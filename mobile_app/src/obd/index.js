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

// Ghost codes that are ALWAYS padding / J1979 artefacts — never real faults
const GHOST_CODES = new Set([
  'P0000','C0000','B0000','U0000',
  'C0300','C0700','C0A00',
]);

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
    let cmdFuelRate = this.commands['FUEL_RATE'];
    if (!cmdFuelRate) {
      cmdFuelRate = {
        command: '015E', bytes: 2,
        decoder: (hex) => (parseInt(hex.substring(0,2),16)*256 + parseInt(hex.substring(2,4),16))*0.05,
        unit: 'л/год', name: 'FUEL_RATE',
      };
    }
    const direct = await this.query(cmdFuelRate);
    if (direct?.value != null && direct.value !== 'NO DATA' && direct.value !== 'ERROR') return direct;

    let cmdMaf = this.commands['MAF'];
    if (!cmdMaf) {
      cmdMaf = {
        command: '0110', bytes: 2,
        decoder: (hex) => (parseInt(hex.substring(0,2),16)*256 + parseInt(hex.substring(2,4),16))/100,
        unit: 'г/с', name: 'MAF',
      };
    }
    const mafData = await this.query(cmdMaf);
    if (mafData?.value != null && mafData.value !== 'NO DATA' && mafData.value !== 'ERROR') {
      const mafValue = parseFloat(mafData.value);
      let cmdFuelType = this.commands['FUEL_TYPE'];
      if (!cmdFuelType) {
        cmdFuelType = {
          command: '0151', bytes: 1,
          decoder: (hex) => parseInt(hex.substring(0,2),16),
          unit: '', name: 'FUEL_TYPE',
        };
      }
      const fuelTypeData = await this.query(cmdFuelType);
      let fuelId = 1;
      if (fuelTypeData?.value != null && !isNaN(fuelTypeData.value)) fuelId = parseInt(fuelTypeData.value, 10);
      const FUEL_CONSTANTS = {
        1:  { afr: 14.7, density: 820 },
        4:  { afr: 14.5, density: 850 },
        8:  { afr: 15.5, density: 540 },
        9:  { afr: 17.2, density: 128 },
        23: { afr: 9.0,  density: 789 },
        DEFAULT: { afr: 14.7, density: 820 },
      };
      const fp  = FUEL_CONSTANTS[fuelId] || FUEL_CONSTANTS.DEFAULT;
      const lph = (mafValue * 3600) / (fp.afr * fp.density);
      return { value: lph.toFixed(1), unit: 'л/год', raw: 'CALC', name: 'FUEL_RATE', desc: 'Витрата палива' };
    }
    return { value: '--', unit: 'л/год', raw: '', name: 'FUEL_RATE', desc: 'Витрата палива' };
  }

  // ── Smart DTC scanner ─────────────────────────────────────────────────────

  async smartReadDTC(dtcDictionary = {}) {
    const allCodes    = new Map();
    const usedVariants = [];

    const methods = [
      // UDS — reliable subset only (1902FF and 19020C removed — cause garbage)
      // IMPORTANT: names use 'Mode UDS' prefix so TelemetryContext variant checks work
      { cmd: '190209', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 09' },
      { cmd: '190208', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 08' },
      { cmd: '190201', dec: decoders.dtc_uds, isUds: true,  name: 'Mode UDS 01' },
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

        // ── Ghost / padding filter ──────────────────────────────────────────
        if (GHOST_CODES.has(baseCode))               continue;
        if (/^[PCBU]0{4}$/.test(baseCode))           continue;
        if (!/^[PCBU][0-3][0-9A-F]{4}$/.test(baseCode)) continue;

        const numericPart = baseCode.substring(1);
        if (numericPart === '0000' || numericPart === 'FFFF') continue;

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
      const response = await this._scanner.sendCommand(cmd);
      saveRawLog('DTC_RAW_RES', cmd, response || 'NO_RESPONSE');

      if (!response) return null;

      const rawUpper = response.toUpperCase();
      if (
        rawUpper.includes('ERROR')   || rawUpper.includes('?')      ||
        rawUpper.includes('UNABLE')  || rawUpper.includes('NODATA') ||
        rawUpper.includes('NO DATA')
      ) return null;

      const lines = response
        .split(/[\r\n]+/)
        .map(l => l.replace(/[\s>]/g, '').toUpperCase());

      let fullHexPayload = '';
      for (let line of lines) {
        if (!line) continue;
        line = line.replace(/^[0-9A-F]:/, ''); // strip CAN PCI frame byte
        fullHexPayload += line;
      }

      // ── Mode 03 / 07 / 0A: parse each ECU independently ─────────────────
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const expectedPrefix = '4' + cmd.charAt(1);
        let idx = fullHexPayload.indexOf(expectedPrefix);
        if (idx === -1) return null;

        const perEcuCodes = [];

        while (idx !== -1) {
          const nextIdx = fullHexPayload.indexOf(expectedPrefix, idx + 2);
          let ecuRaw    = nextIdx !== -1
            ? fullHexPayload.substring(idx + 2, nextIdx)
            : fullHexPayload.substring(idx + 2);

          if (ecuRaw.length % 2 !== 0) ecuRaw = ecuRaw.substring(1);

          const ecuCodes = decoderFunc(ecuRaw);
          if (Array.isArray(ecuCodes)) perEcuCodes.push(ecuCodes);

          idx = nextIdx;
        }

        if (perEcuCodes.length === 0) return null;

        // Union across ECUs, deduplicated
        const seen    = new Set();
        const unified = [];
        for (const list of perEcuCodes) {
          for (const code of list) {
            if (!seen.has(code)) { seen.add(code); unified.push(code); }
          }
        }

        if (unified.length > 0) saveRawLog('DTC_DECODED', cmd, JSON.stringify(unified));
        return unified;
      }

      // ── UDS (19xx) and KWP (18xx): pass full payload ─────────────────────
      // dtc_uds handles multiple 5902 blocks internally
      if (cmd.startsWith('19') || cmd.startsWith('18')) {
        const decoded = decoderFunc(fullHexPayload);
        if (!Array.isArray(decoded)) return null;

        // Deduplicate within this response
        const seen   = new Set();
        const unique = decoded.filter(item => {
          const key = typeof item === 'object' ? item.base : item;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        });

        if (unique.length > 0) saveRawLog('DTC_DECODED', cmd, JSON.stringify(unique));
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