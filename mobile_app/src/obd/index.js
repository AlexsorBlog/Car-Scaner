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
 * - NEW: Added comprehensive raw telemetry logging for detailed analysis.
 */

import { obdScanner } from '../services/bleService.js';
import { commands }   from './commands.js';
import * as decoders  from './decoders.js';
import { saveRawLog } from '../services/db.js'; // 📥 ВАЖЛИВО: Імпорт логера

const AT_CMD_RE = /^AT/i;
const MODE_NO_PID = new Set(['03', '04', '07', '08', '09']);

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
        
        // 💾 ЛОГ: Зберігаємо ініціалізацію для дебагу протоколів
        saveRawLog('INIT', step.cmd, res || 'NO_RESPONSE');

        if (step.cmd === 'ATZ' && !res.toUpperCase().includes('ELM')) {
          console.warn('[OBD init] ATZ response unexpected — device may not be ELM327');
        }
        if (step.delay > 100) {
          await this._sleep(step.delay);
        }
      } catch (err) {
        // 💾 ЛОГ: Зберігаємо помилку ініціалізації
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
    if (!cmdObj?.command) {
      console.error('[OBD] query called with invalid command object');
      return null;
    }

    let response;
    try {
      response = await this._scanner.sendCommand(cmdObj.command);
      // 💾 ЛОГ: Успішний запит показників
      saveRawLog('QUERY', cmdObj.command, response || 'NO_RESPONSE');
    } catch (err) {
      // 💾 ЛОГ: Помилка запиту
      saveRawLog('QUERY_ERROR', cmdObj.command, err.message, true);
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

  async smartReadDTC(dtcDictionary = {}) {
    let result;

    result = await this._executeRawDTC('190209', decoders.dtc_uds);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'UDS 190209 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190209 (Confirmed/Failed)' };
    }

    result = await this._executeRawDTC('190208', decoders.dtc_uds);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'UDS 190208 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190208 (Confirmed)' };
    }

    result = await this._executeRawDTC('19020C', decoders.dtc_uds);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'UDS 19020C (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 19020C (Conf/Not Complete)' };
    }

    result = await this._executeRawDTC('190201', decoders.dtc_uds);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'UDS 190201 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 190201 (Active)' };
    }

    result = await this._executeRawDTC('1902FF', decoders.dtc_uds);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'UDS 1902FF (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, true)) return { codes: this._formatForUI(result, dtcDictionary, true), variant: 'UDS 1902FF (All Statuses)' };
    }

    result = await this._executeRawDTC('03', decoders.dtc);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'Mode 03 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 03 (Збережені)' };
    }

    result = await this._executeRawDTC('07', decoders.dtc);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'Mode 07 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 07 (Очікувані)' };
    }

    result = await this._executeRawDTC('0A', decoders.dtc);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'Mode 0A (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'Mode 0A (Перманентні)' };
    }

    result = await this._executeRawDTC('18000000', decoders.dtc_kwp);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'KWP2000 18000000 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'KWP2000 18000000 (Всі)' };
    }

    result = await this._executeRawDTC('1802FF00', decoders.dtc_kwp);
    if (result !== null) {
      if (result.length === 0) return { codes: [], variant: 'KWP2000 1802FF00 (Clean)' };
      if (this._verifyCodes(result, dtcDictionary, false)) return { codes: this._formatForUI(result, dtcDictionary, false), variant: 'KWP2000 1802FF00 (Збережені)' };
    }

    const fallback = await this._executeRawDTC('03', decoders.dtc);
    return { codes: this._formatForUI(fallback || [], dtcDictionary, false), variant: 'Невідомі коди (Fallback Mode 03)' };
  }

  async _executeRawDTC(cmd, decoderFunc) {
    try {
      const response = await this._scanner.sendCommand(cmd);
      
      // 💾 ЛОГ: Найважливіший лог. Фіксує точну відповідь ЕБУ на запит помилок.
      saveRawLog('DTC_RAW_RES', cmd, response || 'NO_RESPONSE');

      if (!response) return null; 

      const rawUpper = response.toUpperCase();

      // Catch critical failures or empty reports
      if (rawUpper.includes('ERROR') || rawUpper.includes('?') || rawUpper.includes('UNABLE')) {
        return null; 
      }
      if (rawUpper.includes('NODATA') || rawUpper.includes('NO DATA') || rawUpper === 'OK') {
        return []; 
      }
      
      // Split into lines and strip whitespace
      const lines = response.split(/[\r\n]+/).map(l => l.replace(/[\s>]/g, '').toUpperCase());
      
      let fullHexPayload = "";

      // 1. ASSEMBLE MULTI-FRAME DATA
      for (let line of lines) {
        if (!line || line.includes('NODATA') || line.includes('ERROR')) continue;
        
        // Strip ELM327 multi-frame PCI indicators (e.g., "0:", "1:", "2:")
        line = line.replace(/^[0-9A-F]:/, '');
        
        fullHexPayload += line;
      }

      let hexData = null;

      // 2. EXTRACT PAYLOAD BASED ON PROTOCOL PREFIX
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const expectedPrefix = '4' + cmd.charAt(1);
        const prefixIdx = fullHexPayload.indexOf(expectedPrefix);
        
        if (prefixIdx !== -1) {
          hexData = fullHexPayload.substring(prefixIdx + 2);
          
          // Count Byte Fix: If length isn't divisible by 4, the first 2 chars are the count byte
          if (hexData.length % 4 !== 0) {
             hexData = hexData.substring(2);
          }
        }
      } else if (cmd.startsWith('19')) {
        const prefixIdx = fullHexPayload.indexOf('5902');
        if (prefixIdx !== -1) hexData = fullHexPayload.substring(prefixIdx);
      } else if (cmd.startsWith('18')) {
        const prefixIdx = fullHexPayload.indexOf('58');
        if (prefixIdx !== -1) hexData = fullHexPayload.substring(prefixIdx);
      }

      // 3. DECODE
      if (hexData) {
        const decoded = decoderFunc(hexData);
        if (Array.isArray(decoded) && decoded.length > 0) {
          
          // 💾 ЛОГ: Фіксуємо фінально розшифровані помилки
          saveRawLog('DTC_DECODED', cmd, JSON.stringify(decoded));
          
          return decoded;
        }
      }

      return [];
    } catch (err) {
      // 💾 ЛОГ: Критична помилка під час спроби зчитати/декодувати DTC
      saveRawLog('DTC_FATAL_ERROR', cmd, err.message, true);
      console.warn(`[OBD SmartDTC] Помилка запиту ${cmd}:`, err.message);
      return null;
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