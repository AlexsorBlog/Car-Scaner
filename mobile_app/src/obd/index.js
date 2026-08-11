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
const MODE_NO_PID = new Set(['03', '04', '07', '08', '09']);

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
        if (step.delay > 100) await this._sleep(step.delay);
      } catch (err) {
        saveRawLog('INIT_ERROR', step.cmd, err.message, true);
        console.error(`[OBD init] ${step.desc} failed:`, err.message);
      }
    }
    return true;
  }

  disconnect() {
    this._scanner.disconnect();
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

    const clean = response.replace(/[\s\r\n]/g, '').toUpperCase();

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
    // Mercedes W212/W205/W213 commonly use these UDS ReadDataByIdentifier PIDs.
    // 22F40F = fuel consumption (l/h), 22F415 = instant consumption variant,
    // 222110 / 2221FD = alternate addresses seen on some ECU variants.
    for (const udsCmd of [
      { command: '22F40F', scale: 0.01,  desc: 'UDS Fuel F40F' },
      { command: '22F415', scale: 0.01,  desc: 'UDS Fuel F415' },
      { command: '222110', scale: 0.01,  desc: 'UDS Fuel 2110' },
      { command: '2221FD', scale: 0.01,  desc: 'UDS Fuel 21FD' },
    ]) {
      try {
        const raw = await this._scanner.sendCommand(udsCmd.command);
        if (raw && !raw.includes('NO DATA') && !raw.includes('ERROR') && !raw.includes('?')) {
          const clean = raw.replace(/[\s\r\n:0-9A-F]{1}:/g, '').replace(/[\s\r\n]/g, '').toUpperCase();
          // UDS 22 reply prefix is 62 + the 2-byte DID, e.g. 22F40F → 62F40F
          const did        = udsCmd.command.substring(2).toUpperCase();
          const replyPfx   = '62' + did;
          const prefixIdx  = clean.indexOf(replyPfx);
          if (prefixIdx !== -1) {
            // Data starts after the 6-char prefix (62 + 2-byte DID)
            const hexData = clean.substring(prefixIdx + 6, prefixIdx + 10);
            if (hexData.length === 4) {
              const raw_val = parseInt(hexData, 16);
              if (!isNaN(raw_val) && raw_val > 0 && raw_val < 0xFFFE) {
                const lph = (raw_val * (udsCmd.scale || 0.01)).toFixed(2);
                if (parseFloat(lph) > 0 && parseFloat(lph) < 100) {
                  saveRawLog('FUEL_UDS', udsCmd.command, `${lph} л/год`);
                  return { value: lph, unit: 'л/год', raw: hexData, name: 'FUEL_RATE', desc: 'Витрата палива' };
                }
              }
            }
          }
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
      const mafGs = parseFloat(rMaf.value);

      // Try to get fuel type for accurate AFR
      const cmdFuelType = this.commands['FUEL_TYPE'] || {
        command: '0151', bytes: 1,
        decoder: (hex) => parseInt(hex.substring(0,2), 16),
        unit: '', name: 'FUEL_TYPE', desc: 'Fuel Type',
      };
      const rFuelType = await this.query(cmdFuelType);
      const fuelId = (_ok(rFuelType) && !isNaN(rFuelType.value)) ? parseInt(rFuelType.value, 10) : 1;

      const FUEL_PROPS = {
        1:  { afr: 14.7, density: 820 },  // Petrol
        4:  { afr: 14.5, density: 850 },  // Diesel
        8:  { afr: 15.5, density: 540 },  // LPG
        9:  { afr: 17.2, density: 128 },  // CNG
        23: { afr: 9.0,  density: 789 },  // Ethanol
      };
      const fp  = FUEL_PROPS[fuelId] || FUEL_PROPS[1];
      const lph = ((mafGs * 3600) / (fp.afr * fp.density)).toFixed(1);
      return { value: lph, unit: 'л/год', raw: 'MAF_CALC', name: 'FUEL_RATE', desc: 'Витрата палива' };
    }

    // ── Step 5: Throttle + RPM + displacement heuristic (last resort) ────────
    // Very rough but better than '--' for engines that support nothing else
    try {
      const rRpm = await this.query(this.commands['RPM']);
      const rTps = await this.query(this.commands['THROTTLE_POS']);
      const rLoad = await this.query(this.commands['ENGINE_LOAD']);
      if (_ok(rRpm) && _ok(rTps)) {
        const rpm   = parseFloat(rRpm.value);
        const tps   = parseFloat(rTps.value) / 100;
        const load  = _ok(rLoad) ? parseFloat(rLoad.value) / 100 : tps;
        // Assume 2.0L petrol if unknown — rough L/h = displacement * RPM * load * BSFC
        const DISPLACEMENT_L = 2.0;
        const BSFC = 0.00028; // brake-specific fuel consumption constant (rough)
        const lph  = (DISPLACEMENT_L * rpm * load * BSFC).toFixed(1);
        if (parseFloat(lph) > 0 && parseFloat(lph) < 80) {
          return { value: lph, unit: 'л/год', raw: 'HEURISTIC', name: 'FUEL_RATE', desc: 'Витрата палива (розрах.)' };
        }
      }
    } catch (_) {}

    return { value: '--', unit: 'л/год', raw: '', name: 'FUEL_RATE', desc: 'Витрата палива' };
  }

  // ── Smart DTC scanner ─────────────────────────────────────────────────────

  async smartReadDTC(dtcDictionary = {}) {
    const allCodes     = new Map();
    const usedVariants = [];

    // ── Pre-scan setup: increase ELM timeout and enable multi-frame ───────────
    // Mercedes (and many modern cars) need longer response time for DTC queries
    try {
      await this._scanner.sendCommand('ATAT2');   // adaptive timing mode 2 (max wait)
      await this._scanner.sendCommand('ATST64');  // timeout = 100 * 4ms = 400ms
      await this._scanner.sendCommand('ATAL');    // allow long messages
      await this._scanner.sendCommand('ATCAF0');  // disable CAN auto-formatting so we get raw frames
    } catch (_) {}

    const methods = [
      // UDS — reliable subset only (1902FF and 19020C removed — cause garbage)
      // IMPORTANT: names use 'Mode UDS' prefix so TelemetryContext variant checks work
      { cmd: '190209', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 09' },
      { cmd: '190208', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 08' },
      { cmd: '190201', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 01' },
      // Narrow, single-bit pendingDTC mask (0x04) — some ECUs only expose fresh
      // codes here, missed by 09/08/01. Unlike the removed 1902FF/19020C this
      // is a single status bit, not the full mask, so it doesn't trigger the
      // memory-dump-scale responses those caused on other cars.
      { cmd: '190204', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 04' },
      // OBD-II standard modes
      { cmd: '03',       dec: decoders.dtc,     isUds: false, name: 'Mode 03' },
      { cmd: '07',       dec: decoders.dtc,     isUds: false, name: 'Mode 07' },
      { cmd: '0A',       dec: decoders.dtc,     isUds: false, name: 'Mode 0A' },
      // KWP2000
      { cmd: '18000000', dec: decoders.dtc_kwp, isUds: false, name: 'KWP 00' },
      { cmd: '1802FF00', dec: decoders.dtc_kwp, isUds: false, name: 'KWP FF' },
    ];

    for (const method of methods) {
      const result = await this._executeRawDTC(method.cmd, method.dec);
      if (!result || result.length === 0) continue;

      let addedNew = false;

      for (const item of result) {
        const baseCode = method.isUds ? item.base : item;

        // ── Ghost / padding / structural filter ──────────────────────────────
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
