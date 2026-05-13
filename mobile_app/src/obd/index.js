/**
 * obd/index.js — High-level OBD-II query manager
 *
 * Fixed bugs vs original:
 * - AT commands (ATI, ATRV) returned null because the response parser looked
 * for a "41xx" / "43" prefix that AT responses don't have
 * - Mode 03 / 07 DTC responses were silently dropped because the parser
 * expected a PID byte after "43" but mode-3 has no PID
 * - No error handling in initEngine — AT command failures were invisible
 * - No protocol detection step
 * - query() called decoder even when hexData was empty string
 * - Fixed: Imported missing 'decoders' module.
 * - Fixed: Added Count Byte stripping to _executeRawDTC.
 * - Fixed: Added _formatForUI to map raw codes to dictionary strings for the UI.
 */

import { obdScanner } from '../services/bleService.js';
import { commands }   from './commands.js';
import * as decoders  from './decoders.js';

// ── Response prefix table ─────────────────────────────────────────────────────
const AT_CMD_RE = /^AT/i;
const MODE_NO_PID = new Set(['03', '04', '07', '08', '09']);

// ── OBDManager ────────────────────────────────────────────────────────────────

class OBDManager {
  constructor() {
    this._scanner  = obdScanner;
    this.commands  = commands;
  }

  async connect() {
    return this._scanner.connect();
  }

  async initEngine() {
    const steps = [
      { cmd: 'ATZ',   delay: 1200, desc: 'Reset ELM327'           },
      { cmd: 'ATE0',  delay: 100,  desc: 'Echo off'               },
      { cmd: 'ATL0',  delay: 100,  desc: 'Linefeeds off'          },
      { cmd: 'ATS0',  delay: 100,  desc: 'Spaces off'             },
      { cmd: 'ATH0',  delay: 100,  desc: 'Headers off'            },
      { cmd: 'ATSP0', delay: 200,  desc: 'Auto-detect protocol'   },
    ];

    for (const step of steps) {
      try {
        const res = await this._scanner.sendCommand(step.cmd);
        console.log(`[OBD init] ${step.desc}: ${res}`);
        if (step.cmd === 'ATZ' && !res.toUpperCase().includes('ELM')) {
          console.warn('[OBD init] ATZ response unexpected — device may not be ELM327');
        }
        if (step.delay > 100) {
          await this._sleep(step.delay);
        }
      } catch (err) {
        console.error(`[OBD init] ${step.desc} failed:`, err.message);
      }
    }

    return true;
  }

  disconnect() {
    this._scanner.disconnect();
  }

  async query(cmdObj) {
    if (!cmdObj?.command) {
      console.error('[OBD] query called with invalid command object');
      return null;
    }

    let response;
    try {
      response = await this._scanner.sendCommand(cmdObj.command);
    } catch (err) {
      console.error(`[OBD] sendCommand failed for ${cmdObj.name}:`, err.message);
      return null;
    }

    if (!response) return null;

    const clean = response.replace(/[\s\r\n]/g, '').toUpperCase();

    if (
      clean.includes('NODATA') || clean.includes('TIMEOUT') ||
      clean.includes('ERROR') || clean.includes('UNABLE') ||
      clean.includes('STOPPED') || clean === 'TIMEOUT' || clean === ''
    ) {
      return null;
    }

    if (AT_CMD_RE.test(cmdObj.command)) {
      try {
        const value = typeof cmdObj.decoder === 'function' ? cmdObj.decoder(clean) : clean;
        return { value, unit: '', raw: clean, name: cmdObj.name, desc: cmdObj.desc };
      } catch (err) {
        console.warn(`[OBD] AT decoder error for ${cmdObj.name}:`, err.message);
        return null;
      }
    }

    const modeHex  = cmdObj.command.substring(0, 2).toUpperCase();
    const modeInt  = parseInt(modeHex, 16);
    const replyMode = ((modeInt + 0x40) & 0xFF).toString(16).toUpperCase().padStart(2, '0');

    let hexData;

    if (MODE_NO_PID.has(modeHex)) {
      const prefixIdx = clean.indexOf(replyMode);
      if (prefixIdx === -1) return null;
      hexData = clean.substring(prefixIdx + 2); 
    } else {
      const pidHex  = cmdObj.command.substring(2).toUpperCase();
      const prefix  = replyMode + pidHex;
      const prefixIdx = clean.indexOf(prefix);
      if (prefixIdx === -1) return null;
      hexData = clean.substring(prefixIdx + prefix.length);
    }

    if (hexData === '' && cmdObj.bytes === 0) {
      const value = typeof cmdObj.decoder === 'function' ? cmdObj.decoder('') : null;
      return { value, unit: cmdObj.unit, raw: '', name: cmdObj.name, desc: cmdObj.desc };
    }

    if (hexData.length === 0) return null;

    const targetHex = (cmdObj.bytes > 0 && hexData.length >= cmdObj.bytes * 2)
      ? hexData.substring(0, cmdObj.bytes * 2)
      : hexData;

    if (typeof cmdObj.decoder !== 'function') {
      console.warn(`[OBD] No decoder for ${cmdObj.name}`);
      return null;
    }

    try {
      const value = cmdObj.decoder(targetHex);
      if (value === null || value === undefined) return null;
      return {
        value, unit: cmdObj.unit, raw: targetHex, name: cmdObj.name, desc: cmdObj.desc,
      };
    } catch (err) {
      console.warn(`[OBD] Decoder error for ${cmdObj.name}:`, err.message);
      return null;
    }
  }

  // ── Smart DTC Fallback Logic ──────────────────────────────────────────────

  async smartReadDTC(dtcDictionary = {}) {
    let result;

    // --- БЛОК 1: СУЧАСНІ UDS МЕТОДИ (ISO 14229) ---
    result = await this._executeRawDTC('190209', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190209 (Confirmed/Failed)' };

    result = await this._executeRawDTC('190208', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190208 (Confirmed)' };

    result = await this._executeRawDTC('19020C', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 19020C (Conf/Not Complete)' };

    result = await this._executeRawDTC('190201', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190201 (Active)' };

    result = await this._executeRawDTC('1902FF', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 1902FF (All Statuses)' };


    // --- БЛОК 2: СТАНДАРТНІ OBD-II МЕТОДИ (ISO 15031 / SAE J1979) ---
    result = await this._executeRawDTC('03', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 03 (Збережені)' };

    result = await this._executeRawDTC('07', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 07 (Очікувані)' };

    result = await this._executeRawDTC('0A', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 0A (Перманентні)' };


    // --- БЛОК 3: СТАРІ ПРОТОКОЛИ KWP2000 (ISO 14230) ---
    result = await this._executeRawDTC('18000000', decoders.dtc_kwp);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'KWP2000 18000000 (Всі)' };

    result = await this._executeRawDTC('1802FF00', decoders.dtc_kwp);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'KWP2000 1802FF00 (Збережені)' };


    // --- FALLBACK ---
    const fallback = await this._executeRawDTC('03', decoders.dtc);
    return { codes: this._formatForUI(fallback || [], dtcDictionary, false), variant: 'Невідомі коди (Fallback Mode 03)' };
  }

  // ── Private helpers for Smart DTC ─────────────────────────────────────────

  async _executeRawDTC(cmd, decoderFunc) {
    try {
      const response = await this._scanner.sendCommand(cmd);
      if (!response) return [];
      
      const lines = response.split(/[\r\n]+/).map(l => l.replace(/[\s>]/g, '').toUpperCase());
      let allCodes = [];

      for (const line of lines) {
        if (!line || line.includes('NODATA') || line.includes('ERROR')) continue;

        let hexData = null;

        if (cmd === '03' || cmd === '07' || cmd === '0A') {
          const expectedPrefix = '4' + cmd.charAt(1);
          const prefixIdx = line.indexOf(expectedPrefix);
          if (prefixIdx !== -1) {
            hexData = line.substring(prefixIdx + 2);
          }
        } else if (cmd.startsWith('19')) {
          const prefixIdx = line.indexOf('5902');
          if (prefixIdx !== -1) hexData = line.substring(prefixIdx);
        } else if (cmd.startsWith('18')) {
          const prefixIdx = line.indexOf('58');
          if (prefixIdx !== -1) hexData = line.substring(prefixIdx);
        }

        if (hexData) {
          // Count Byte Fix: If standard OBD and length is off by 2 (e.g. 6 chars for 1 DTC), 
          // the first byte is a count byte. Strip it before passing to decoder.
          if ((cmd === '03' || cmd === '07' || cmd === '0A') && hexData.length % 4 !== 0) {
             hexData = hexData.substring(2);
          }

          const decoded = decoderFunc(hexData);
          if (Array.isArray(decoded)) {
            allCodes.push(...decoded);
          }
        }
      }

      return allCodes;
    } catch (err) {
      console.warn(`[OBD SmartDTC] Помилка запиту ${cmd}:`, err.message);
      return [];
    }
  }

  _verifyCodes(codes, dictionary, isUds) {
    if (!codes || codes.length === 0) return false;

    let validCount = 0;
    for (const codeItem of codes) {
      const codeToVerify = isUds ? codeItem.base : codeItem; 
      if (dictionary[codeToVerify]) {
        validCount++;
      }
    }

    return validCount > 0;
  }

  _formatForUI(codes, dictionary, isUds) {
    return codes.map(item => {
      const codeString = isUds ? item.base : item;
      return {
        code: codeString,
        title: dictionary[codeString] || "Невідома помилка",
        desc: dictionary[codeString] ? "Зверніться до технічної документації вашого авто." : "Опис не знайдено",
        base: codeString
      };
    });
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export const obd = new OBDManager();