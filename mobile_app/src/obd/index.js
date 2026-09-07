/**
 * obd/index.js — complete fixed version
 *
 * Key fixes vs current:
 *  1. smartReadDTC — renamed method variants to include 'Mode' prefix so
 *     TelemetryContext variant.includes('Mode 03') checks work correctly
 *  2. _executeRawDTC — UDS path now passes full payload to dtc_uds which
 *     handles multiple 5902 blocks internally (multi-ECU fix in decoders.js)
 *  3. Ghost filter extended + regex guard moved here too
 *  4. Server-ready: CONFIG object at top for future WebSocket server switch
 */

import { obdScanner } from '../services/bleService.js';
import { commands }   from './commands.js';
import * as decoders  from './decoders.js';
import { saveRawLog } from '../services/db.js';
import {
  isStructurallyValidDtc,
  assembleHexPayload,
  stripNegativeResponses,
  parseLegacyModeDtc,
  parseUdsKwpDtc,
} from './dtcParser.js';
import {
  MERCEDES_UDS_FUEL_CMDS,
  decodeUdsFuelReply,
  calcMafFuelRate,
  calcHeuristicFuelRate,
} from './fuelRate.js';
import { DtcScanRunner } from './dtcScanRunner.js';

// ── Server config — swap URL when server is ready ─────────────────────────────
// When SERVER_ENABLED = true the app will route OBD queries through your
// WebSocket server instead of direct BLE. Flip this flag + set SERVER_URL
// before the TestFlight build that launches alongside the server.
export const SERVER_CONFIG = {
  enabled:    false,                        // ← flip to true when server is live
  url:        'wss://your-server.com/obd', // ← set your server URL
  authToken:  () => localStorage.getItem('obd_token'),
};

const AT_CMD_RE  = /^AT/i;
// Modes with no PID/InfoType byte after the mode itself — Mode 09 does NOT
// belong here (0901, 0902/VIN, 0904, etc. all have an InfoType byte, exactly
// like every PID-bearing mode below); treating it as PID-less used to leave
// that InfoType byte sitting in the data, corrupting the fixed-length slice.
const MODE_NO_PID = new Set(['03', '04', '07', '08']);

class OBDManager {
  constructor() {
    this._scanner = obdScanner;
    this.commands = commands;
  }

  async connect() {
    return this._scanner.connect();
  }

  async initEngine() {
    const steps = [
      { cmd: 'ATZ',   delay: 1200, desc: 'Reset ELM327'         },
      { cmd: 'ATE0',  delay: 100,  desc: 'Echo off'             },
      { cmd: 'ATL0',  delay: 100,  desc: 'Linefeeds off'        },
      { cmd: 'ATS0',  delay: 100,  desc: 'Spaces off'           },
      { cmd: 'ATH0',  delay: 100,  desc: 'Headers off'          },
      { cmd: 'ATSP0', delay: 200,  desc: 'Auto-detect protocol' },
    ];

    for (const step of steps) {
      try {
        const res = await this._scanner.sendCommand(step.cmd);
        console.log(`[OBD init] ${step.desc}: ${res}`);
        saveRawLog('INIT', step.cmd, res || 'NO_RESPONSE');
        if (step.cmd === 'ATZ' && !res.toUpperCase().includes('ELM')) {
          console.warn('[OBD init] ATZ response unexpected — may not be ELM327');
        }
        // NB: this used to be `> 100`, so every 100ms step silently had no
        // delay at all — the adapter got the next AT command immediately.
        if (step.delay >= 100) await this._sleep(step.delay);
      } catch (err) {
        saveRawLog('INIT_ERROR', step.cmd, err.message, true);
        console.error(`[OBD init] ${step.desc} failed:`, err.message);
      }
    }

    await this._warmUpProtocol();
    return true;
  }

  // ── Protocol warm-up ───────────────────────────────────────────────────────
  // ATSP0 doesn't actually search on the AT command — it searches on the first
  // real PID request, which can take several seconds on the first connect to a
  // given car. Real logs showed the cost of not waiting for it:
  //
  //   ATSP0 | OK  →  010D | TIMEOUT  →  010C | STOPPED  →  0105 | TIMEOUT
  //
  // The first query times out mid-search, then the NEXT query interrupts the
  // still-running search and comes back "STOPPED", cascading until the app gave
  // up and reconnected. It only succeeded on the 4th attempt, once the adapter
  // had cached the protocol — which is exactly the "doesn't connect the first
  // time, works after 2-3 tries" report.
  //
  // So: send the standard 0100 handshake and give the search room to finish,
  // backing OFF after a timeout instead of immediately firing the next command.
  async _warmUpProtocol(attempts = 4) {
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = (await this._scanner.sendCommand('0100')) || '';
        const clean = res.replace(/[\s\r\n>]/g, '').toUpperCase();
        saveRawLog('INIT_WARMUP', '0100', res || 'NO_RESPONSE');

        // "SEARCHING..." may prefix a perfectly good reply — only the 4100
        // positive response actually confirms the protocol is established.
        if (clean.includes('4100')) {
          console.log(`[OBD init] protocol established on warm-up ${i}/${attempts}`);
          return true;
        }
        // Timed out / aborted mid-search: let the adapter settle before the
        // next attempt, otherwise we abort its own retry and get "STOPPED".
        await this._sleep(1500);
      } catch (err) {
        saveRawLog('INIT_WARMUP_ERROR', '0100', err.message, true);
        await this._sleep(1500);
      }
    }
    // Not fatal — some ECUs don't answer 0100 but still serve individual PIDs.
    console.warn('[OBD init] protocol warm-up did not confirm 4100; continuing anyway');
    return false;
  }

  disconnect() {
    this._scanner.disconnect();
  }

  /**
   * The last full scan's session, for export/bug reports.
   *  - `text`    human-readable transcript (every command + verbatim response)
   *  - `fixture` JSON that replays this exact car offline via makeReplayCar(),
   *              i.e. paste it into a test and the car is reproducible in CI
   */
  getLastScanDiagnostics() {
    if (!this._lastScanLog) return null;
    return {
      text: this._lastScanLog.toText(),
      fixture: this._lastScanFixture,
      stats: this._lastScanLog.stats(),
    };
  }

  async query(cmdObj) {
    if (!cmdObj?.command) return null;

    let response;
    try {
      response = await this._scanner.sendCommand(cmdObj.command);
      saveRawLog('QUERY', cmdObj.command, response || 'NO_RESPONSE');
    } catch (err) {
      saveRawLog('QUERY_ERROR', cmdObj.command, err.message, true);
      return null;
    }

    if (!response) return null;

    const deFramed = decoders.stripFrameMarkers(response);

    const clean = deFramed.replace(/[\s\r\n]/g, '').toUpperCase();

    if (
      clean.includes('NODATA') || clean.includes('TIMEOUT') ||
      clean.includes('ERROR')  || clean.includes('UNABLE')  ||
      clean.includes('STOPPED') || clean === ''
    ) return null;

    if (AT_CMD_RE.test(cmdObj.command)) {
      try {
        const value = typeof cmdObj.decoder === 'function' ? cmdObj.decoder(clean) : clean;
        return { value, unit: '', raw: clean, name: cmdObj.name, desc: cmdObj.desc };
      } catch { return null; }
    }

    const modeHex  = cmdObj.command.substring(0, 2).toUpperCase();
    const modeInt  = parseInt(modeHex, 16);
    const replyMode = ((modeInt + 0x40) & 0xFF).toString(16).toUpperCase().padStart(2, '0');

    let hexData;

    if (MODE_NO_PID.has(modeHex)) {
      const prefixIdx = clean.indexOf(replyMode);
      if (prefixIdx === -1) return null;
      const nextIdx = clean.indexOf(replyMode, prefixIdx + 2);
      hexData = nextIdx !== -1
        ? clean.substring(prefixIdx + 2, nextIdx)
        : clean.substring(prefixIdx + 2);
    } else {
      const pidHex    = cmdObj.command.substring(2).toUpperCase();
      const prefix    = replyMode + pidHex;
      const prefixIdx = clean.indexOf(prefix);
      if (prefixIdx === -1) return null;
      const nextIdx = clean.indexOf(prefix, prefixIdx + prefix.length);
      hexData = nextIdx !== -1
        ? clean.substring(prefixIdx + prefix.length, nextIdx)
        : clean.substring(prefixIdx + prefix.length);
    }

    if (hexData === '' && cmdObj.bytes === 0) {
      const value = typeof cmdObj.decoder === 'function' ? cmdObj.decoder('') : null;
      return { value, unit: cmdObj.unit, raw: '', name: cmdObj.name, desc: cmdObj.desc };
    }
    if (hexData.length === 0) return null;

    const targetHex = (cmdObj.bytes > 0 && hexData.length >= cmdObj.bytes * 2)
      ? hexData.substring(0, cmdObj.bytes * 2)
      : hexData;

    if (typeof cmdObj.decoder !== 'function') return null;

    try {
      const value = cmdObj.decoder(targetHex);
      if (value === null || value === undefined) return null;
      return { value, unit: cmdObj.unit, raw: targetHex, name: cmdObj.name, desc: cmdObj.desc };
    } catch { return null; }
  }

  // ── Smart fuel rate ───────────────────────────────────────────────────────

  async getSmartFuelRate() {
    const _ok = (res) => res?.value != null && res.value !== '--' &&
                          res.value !== 'NO DATA' && res.value !== 'ERROR' &&
                          !isNaN(parseFloat(res.value));

    // ── Step 1: Standard OBD PID 015E (works on most ECUs) ──────────────────
    const cmd5E = this.commands['FUEL_RATE'] || {
      command: '015E', bytes: 2,
      decoder: (hex) => ((parseInt(hex.substring(0,2),16)*256 + parseInt(hex.substring(2,4),16)) * 0.05).toFixed(2),
      unit: 'л/год', name: 'FUEL_RATE', desc: 'Витрата палива',
    };
    const r5E = await this.query(cmd5E);
    if (_ok(r5E)) return r5E;

    // ── Step 2: Mercedes/BMW often use PID 015E on secondary address ─────────
    // Try alternate header — some Mercs respond only on 7E2 or 7E3
    try {
      await this._scanner.sendCommand('ATSH7E2');
      const r5E2 = await this.query(cmd5E);
      await this._scanner.sendCommand('ATSH7E0'); // restore default header
      if (_ok(r5E2)) return r5E2;
    } catch (_) {
      try { await this._scanner.sendCommand('ATSH7E0'); } catch (_) {}
    }

    // ── Step 3: UDS 22 service — Mercedes specific PIDs ─────────────────────
    for (const udsCmd of MERCEDES_UDS_FUEL_CMDS) {
      try {
        const raw = await this._scanner.sendCommand(udsCmd.command);
        const lph = decodeUdsFuelReply(raw, udsCmd.command, udsCmd.scale);
        if (lph != null) {
          saveRawLog('FUEL_UDS', udsCmd.command, `${lph} л/год`);
          return { value: lph, unit: 'л/год', raw, name: 'FUEL_RATE', desc: 'Витрата палива' };
        }
      } catch (_) {}
    }

    // ── Step 4: MAF-based calculation (universal fallback) ───────────────────
    const cmdMaf = this.commands['MAF'] || {
      command: '0110', bytes: 2,
      decoder: (hex) => ((parseInt(hex.substring(0,2),16)*256 + parseInt(hex.substring(2,4),16)) / 100).toFixed(2),
      unit: 'г/с', name: 'MAF', desc: 'MAF',
    };
    const rMaf = await this.query(cmdMaf);
    if (_ok(rMaf)) {
      // Try to get fuel type for accurate AFR
      const cmdFuelType = this.commands['FUEL_TYPE'] || {
        command: '0151', bytes: 1,
        decoder: (hex) => parseInt(hex.substring(0,2), 16),
        unit: '', name: 'FUEL_TYPE', desc: 'Fuel Type',
      };
      const rFuelType = await this.query(cmdFuelType);
      const fuelId = (_ok(rFuelType) && !isNaN(rFuelType.value)) ? parseInt(rFuelType.value, 10) : 1;

      const lph = calcMafFuelRate(parseFloat(rMaf.value), fuelId);
      if (lph != null) {
        return { value: lph, unit: 'л/год', raw: 'MAF_CALC', name: 'FUEL_RATE', desc: 'Витрата палива' };
      }
    }

    // ── Step 5: Throttle + RPM + displacement heuristic (last resort) ────────
    // Very rough but better than '--' for engines that support nothing else
    try {
      const rRpm  = await this.query(this.commands['RPM']);
      const rTps  = await this.query(this.commands['THROTTLE_POS']);
      const rLoad = await this.query(this.commands['ENGINE_LOAD']);
      if (_ok(rRpm) && _ok(rTps)) {
        const lph = calcHeuristicFuelRate(
          parseFloat(rRpm.value),
          parseFloat(rTps.value),
          _ok(rLoad) ? parseFloat(rLoad.value) : null
        );
        if (lph != null) {
          return { value: lph, unit: 'л/год', raw: 'HEURISTIC', name: 'FUEL_RATE', desc: 'Витрата палива (розрах.)' };
        }
      }
    } catch (_) {}

    return { value: '--', unit: 'л/год', raw: '', name: 'FUEL_RATE', desc: 'Витрата палива' };
  }

  // ── Full multi-ECU scan (preferred) ───────────────────────────────────────
  //
  // Walks every module on the bus rather than just whichever one answers the
  // default header, opens a diagnostic session per module, and escalates
  // generic OBD → UDS → KWP. See obd/dtcScanner.js for why the old
  // single-ECU approach structurally could not find manufacturer faults.
  //
  // Falls back to the legacy single-ECU scan if the full scan throws, so a
  // failure here can never leave the user with no scan at all.
  async fullScanDTC(dtcDictionary = {}, { deepScan = true, onProgress } = {}) {
    try {
      const runner = new DtcScanRunner((cmd) => this._scanner.sendCommand(cmd), {
        deepScan,
        onProgress,
        log: (msg) => { console.log(msg); saveRawLog('SCAN', 'flow', msg); },
      });
      const result = await runner.scan(dtcDictionary);

      // Persist the full structured session, not a summary. This is what makes
      // a real scan reproducible: `replayFixture` can be fed straight back
      // through makeReplayCar() to re-run the exact car offline.
      const fixture = result.diagnosticLog?.toReplayFixture({
        capturedBy: 'fullScanDTC',
        codes: result.codes.map(c => c.code),
      });
      this._lastScanLog = result.diagnosticLog;
      this._lastScanFixture = fixture;

      saveRawLog('SCAN_RESULT', 'full', JSON.stringify({
        codes: result.codes.map(c => `${c.code}@${c.ecuAddress}`),
        ecus: result.ecus.map(e => e.request),
        protocol: result.protocol,
        ms: result.durationMs,
        warnings: result.warnings,
        stats: result.diagnosticLog?.stats(),
      }));
      // Stored separately so the transcript survives even if the summary row
      // gets rotated out of the capped log table.
      if (fixture) saveRawLog('SCAN_FIXTURE', 'replay', JSON.stringify(fixture));
      return result;
    } catch (err) {
      saveRawLog('SCAN_FATAL', 'full', err.message, true);
      console.error('[OBD] full scan failed, falling back to legacy scan:', err);
      const legacy = await this.smartReadDTC(dtcDictionary);
      return { ...legacy, ecus: [], protocol: null, durationMs: 0 };
    }
  }

  // ── Smart DTC scanner (legacy single-ECU path, kept as a fallback) ────────

  async smartReadDTC(dtcDictionary = {}) {
    const allCodes     = new Map();
    const usedVariants = [];

    // ── Pre-scan setup: increase ELM timeout and enable multi-frame ───────────
    // Mercedes (and many modern cars) need longer response time for DTC queries.
    // CAF (CAN auto-formatting) is deliberately NOT touched here — it's toggled
    // per method group below, since UDS and legacy/KWP need opposite settings.
    try {
      await this._scanner.sendCommand('ATAT2');   // adaptive timing mode 2 (max wait)
      await this._scanner.sendCommand('ATST64');  // timeout = 100 * 4ms = 400ms
      await this._scanner.sendCommand('ATAL');    // allow long messages
    } catch (_) {}

    // UDS — reliable subset only (1902FF and 19020C removed — cause garbage)
    // IMPORTANT: names use 'Mode UDS' prefix so TelemetryContext variant checks work
    const udsMethods = [
      { cmd: '190209', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 09' },
      { cmd: '190208', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 08' },
      { cmd: '190201', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 01' },
      // Narrow, single-bit pendingDTC mask (0x04) — some ECUs only expose fresh
      // codes here, missed by 09/08/01. Unlike the removed 1902FF/19020C this
      // is a single status bit, not the full mask, so it doesn't trigger the
      // memory-dump-scale responses those caused on other cars.
      { cmd: '190204', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 04' },
    ];
    // OBD-II standard modes + KWP2000 — their decoders (decoders.dtc /
    // decoders.dtc_kwp) look for the standard ELM-formatted positive-response
    // prefix ("43"/"47"/"58"), which only exists when the adapter builds the
    // ISO-TP framing for us — i.e. under CAF1, not CAF0.
    const legacyMethods = [
      { cmd: '03',       dec: decoders.dtc,     isUds: false, name: 'Mode 03' },
      { cmd: '07',       dec: decoders.dtc,     isUds: false, name: 'Mode 07' },
      { cmd: '0A',       dec: decoders.dtc,     isUds: false, name: 'Mode 0A' },
      { cmd: '18000000', dec: decoders.dtc_kwp, isUds: false, name: 'KWP 00' },
      { cmd: '1802FF00', dec: decoders.dtc_kwp, isUds: false, name: 'KWP FF' },
    ];

    const runMethods = async (methods) => {
      for (const method of methods) {
        const result = await this._executeRawDTC(method.cmd, method.dec);
        if (!result || result.length === 0) continue;

        let addedNew = false;

        for (const item of result) {
          const baseCode = method.isUds ? item.base : item;

          // ── Ghost / padding / structural filter ──────────────────────────
          if (!isStructurallyValidDtc(baseCode)) continue;

          // For non-UDS: only accept dictionary-known codes
          // (UDS statusByte gives enough confidence even for unlisted codes)
          const isKnown = !!dtcDictionary[baseCode];
          if (!method.isUds && !isKnown) {
            console.log(`[DTC] Dropping non-dictionary code from ${method.name}: ${baseCode}`);
            continue;
          }

          // Keep first occurrence, or promote if newly known
          if (!allCodes.has(baseCode) || (isKnown && !allCodes.get(baseCode).isKnown)) {
            allCodes.set(baseCode, {
              code:       method.isUds ? item.full : item,
              base:       baseCode,
              isKnown,
              variant:    method.name,
              statusByte: method.isUds ? (item.statusByte ?? null) : null,
            });
            addedNew = true;
          }
        }

        if (addedNew && !usedVariants.includes(method.name)) {
          usedVariants.push(method.name);
        }
      }
    };

    // EVERYTHING runs under CAF1 (CAN auto-formatting ON) so the adapter builds
    // the ISO-TP header for us. Proven on a real Mercedes:
    //
    //   under CAF0:  03 → "037F0011AAAAAAAA"      190209 → "300800AAAAAAAAAA"
    //   under CAF1:  03 → "4300" ✓  07 → "4700" ✓  0A → "4A00" ✓  18.. → "7F1811" ✓
    //
    // With CAF0 the adapter transmits our bytes verbatim, so the ECU reads the
    // FIRST payload byte as the ISO-TP PCI header. For "190209" that byte is
    // 0x19 → high nibble 1 = "First Frame", length 0x902 = 2306 bytes, so the
    // ECU answers with a Flow Control frame ("30 08 00" = ContinueToSend,
    // BlockSize 8, STmin 0) asking us to keep sending a message we never meant
    // to start. That flow-control frame — padded with 0xAA — is the exact
    // garbage seen for every 19xx query. CAF1 makes the adapter emit
    // "03 19 02 09" (PCI + 3 data bytes), which is a valid single-frame
    // request, the same mechanism that already fixed Mode 03/07/0A above.
    try { await this._scanner.sendCommand('ATCAF1'); } catch (_) {}
    await runMethods(udsMethods);
    await runMethods(legacyMethods);

    // ── Post-scan: restore normal ELM timing for live polling ─────────────────
    try {
      await this._scanner.sendCommand('ATAT1');   // adaptive timing mode 1 (normal)
      await this._scanner.sendCommand('ATST26');  // default timeout
      await this._scanner.sendCommand('ATCAF1');  // re-enable CAN auto-formatting
    } catch (_) {}

    if (allCodes.size === 0) {
      return { codes: [], variant: 'Комплексне сканування (Помилок не виявлено)' };
    }

    const finalCodes = Array.from(allCodes.values()).map(item => ({
      code:       item.code,
      title:      dtcDictionary[item.base] || 'Невідома помилка',
      desc:       'Знайдено в базі',
      base:       item.base,
      variant:    item.variant,
      statusByte: item.statusByte ?? null,
    }));

    // Sort: known first, then by code alphabetically
    finalCodes.sort((a, b) => {
      const ak = !!dtcDictionary[a.base], bk = !!dtcDictionary[b.base];
      if (ak !== bk) return ak ? -1 : 1;
      return a.base.localeCompare(b.base);
    });

    return {
      codes:   finalCodes,
      variant: `Знайдено через: ${usedVariants.join(', ')}`,
    };
  }

  // ── Raw DTC executor ──────────────────────────────────────────────────────

  async _executeRawDTC(cmd, decoderFunc) {
    try {
      let response = await this._scanner.sendCommand(cmd);
      saveRawLog('DTC_RAW_RES', cmd, response || 'NO_RESPONSE');

      if (!response) return null;

      // ── NRC 0x78: responsePending ─────────────────────────────────────────
      // Mercedes ECUs often respond 7F <svc> 78 meaning "I'm still computing,
      // send the same request again in a moment". We retry up to 4 times.
      // From logs: 190208 → "...7F197859027F" contains 7F1978.
      const svcByte = cmd.substring(0, 2).toUpperCase();
      let retryCount = 0;
      while (retryCount < 4) {
        const r78 = response.replace(/[\s\r\n]/g, '').toUpperCase();
        if (r78.includes(`7F${svcByte}78`)) {
          retryCount++;
          console.log(`[DTC] NRC 0x78 responsePending (${cmd}), retry ${retryCount}/4 after 600ms`);
          await new Promise(r => setTimeout(r, 600));
          response = await this._scanner.sendCommand(cmd);
          saveRawLog('DTC_RETRY', cmd, response || 'NO_RESPONSE');
        } else {
          break;
        }
      }

      if (!response) return null;

      const rawUpper = response.toUpperCase();
      if (
        rawUpper.includes('ERROR')   || rawUpper.includes('?')      ||
        rawUpper.includes('UNABLE')  || rawUpper.includes('NODATA') ||
        rawUpper.includes('NO DATA')
      ) return null;

      let fullHexPayload = assembleHexPayload(response);

      // Strip any 7Fxx negative responses from multi-ECU payload — e.g.
      // "5902FF5902FF7F197859027F" — the "7F1978" is NRC appended by one
      // ECU, we strip it so the decoder only sees valid 5902xx blocks
      fullHexPayload = stripNegativeResponses(fullHexPayload);

      // ── Mode 03 / 07 / 0A: parse each ECU independently ─────────────────
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const unified = parseLegacyModeDtc(cmd, fullHexPayload, decoderFunc);
        if (unified && unified.length > 0) saveRawLog('DTC_DECODED', cmd, JSON.stringify(unified));
        return unified;
      }

      // ── UDS (19xx) and KWP (18xx): pass full payload ─────────────────────
      // dtc_uds handles multiple 5902 blocks internally
      if (cmd.startsWith('19') || cmd.startsWith('18')) {
        const unique = parseUdsKwpDtc(fullHexPayload, decoderFunc);
        if (unique && unique.length > 0) saveRawLog('DTC_DECODED', cmd, JSON.stringify(unique));
        return unique;
      }

      return null;

    } catch (err) {
      saveRawLog('DTC_FATAL_ERROR', cmd, err.message, true);
      return null;
    }
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export const obd = new OBDManager();
