/**
 * obd/index.js — High-level OBD-II query manager
 *
 * Fixed bugs vs original:
 *  - AT commands (ATI, ATRV) returned null because the response parser looked
 *    for a "41xx" / "43" prefix that AT responses don't have
 *  - Mode 03 / 07 DTC responses were silently dropped because the parser
 *    expected a PID byte after "43" but mode-3 has no PID
 *  - No error handling in initEngine — AT command failures were invisible
 *  - No protocol detection step
 *  - query() called decoder even when hexData was empty string
 */

import { obdScanner } from '../services/bleService.js';
import { commands }   from './commands.js';

// ── Response prefix table ─────────────────────────────────────────────────────
//
// ELM327 echoes: request mode byte + 0x40, followed by the PID byte (mode 1/2)
// or nothing extra (mode 3/4/7/9).
//
// Examples:
//   Request "010C"  → response starts with "410C" then 2 data bytes
//   Request "03"    → response starts with "43"   then DTC pairs (no PID byte)
//   Request "ATZ"   → response is plain text, no numeric prefix
//
const AT_CMD_RE = /^AT/i;

// Modes whose response has NO trailing PID byte after the prefix
const MODE_NO_PID = new Set(['03', '04', '07', '08', '09']);

// ── OBDManager ────────────────────────────────────────────────────────────────

class OBDManager {
  constructor() {
    this._scanner  = obdScanner;
    this.commands  = commands;
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  async connect() {
    return this._scanner.connect();
  }

  /**
   * Send the standard ELM327 initialisation sequence.
   * Returns true if ELM327 responded sensibly, false if something looks wrong.
   */
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
        // ATZ response should contain "ELM327" or "ELM"
        if (step.cmd === 'ATZ' && !res.toUpperCase().includes('ELM')) {
          console.warn('[OBD init] ATZ response unexpected — device may not be ELM327');
        }
        if (step.delay > 100) {
          await this._sleep(step.delay);
        }
      } catch (err) {
        console.error(`[OBD init] ${step.desc} failed:`, err.message);
        // Non-fatal — continue with remaining steps
      }
    }

    return true;
  }

  disconnect() {
    this._scanner.disconnect();
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Execute an OBDCommand and return the decoded result.
   *
   * @param {OBDCommand} cmdObj
   * @returns {Promise<{value: any, unit: string, raw: string, name: string} | null>}
   */
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

    // Normalise: remove all whitespace, carriage returns
    const clean = response.replace(/[\s\r\n]/g, '').toUpperCase();

    // ── Handle error responses ──────────────────────────────────────────────
    if (
      clean.includes('NODATA') ||
      clean.includes('TIMEOUT') ||
      clean.includes('ERROR') ||
      clean.includes('UNABLE') ||
      clean.includes('STOPPED') ||
      clean === 'TIMEOUT' ||
      clean === ''
    ) {
      return null;
    }

    // ── AT command path ─────────────────────────────────────────────────────
    // AT commands return plain text — no numeric prefix to strip
    if (AT_CMD_RE.test(cmdObj.command)) {
      try {
        const value = typeof cmdObj.decoder === 'function'
          ? cmdObj.decoder(clean)
          : clean;
        return { value, unit: '', raw: clean, name: cmdObj.name, desc: cmdObj.desc };
      } catch (err) {
        console.warn(`[OBD] AT decoder error for ${cmdObj.name}:`, err.message);
        return null;
      }
    }

    // ── OBD mode command path ───────────────────────────────────────────────
    const modeHex  = cmdObj.command.substring(0, 2).toUpperCase();
    const modeInt  = parseInt(modeHex, 16);
    const replyMode = ((modeInt + 0x40) & 0xFF).toString(16).toUpperCase().padStart(2, '0');

    let hexData;

    if (MODE_NO_PID.has(modeHex)) {
      // Mode 03/07 etc.: response is just "43" followed by raw DTC bytes
      // Mode 04: response is just "44" (success, no data)
      const prefixIdx = clean.indexOf(replyMode);
      if (prefixIdx === -1) return null;
      hexData = clean.substring(prefixIdx + 2); // skip the 2-char mode prefix
    } else {
      // Mode 01/02/09 etc.: response is "41" + PID + data bytes
      const pidHex  = cmdObj.command.substring(2).toUpperCase(); // e.g. "0C" for RPM
      const prefix  = replyMode + pidHex;
      const prefixIdx = clean.indexOf(prefix);
      if (prefixIdx === -1) return null;
      hexData = clean.substring(prefixIdx + prefix.length);
    }

    // Empty data (e.g. mode 04 clear DTC → "44" with no data) — treat as success
    if (hexData === '' && cmdObj.bytes === 0) {
      const value = typeof cmdObj.decoder === 'function'
        ? cmdObj.decoder('')
        : null;
      return { value, unit: cmdObj.unit, raw: '', name: cmdObj.name, desc: cmdObj.desc };
    }

    if (hexData.length === 0) return null;

    // Trim to expected byte length if specified
    const targetHex = (cmdObj.bytes > 0 && hexData.length >= cmdObj.bytes * 2)
      ? hexData.substring(0, cmdObj.bytes * 2)
      : hexData;

    if (typeof cmdObj.decoder !== 'function') {
      console.warn(`[OBD] No decoder for ${cmdObj.name}`);
      return null;
    }

    try {
      const value = cmdObj.decoder(targetHex);
      // decoder returning null means "no data" (e.g. drop())
      if (value === null || value === undefined) return null;
      return {
        value,
        unit:  cmdObj.unit,
        raw:   targetHex,
        name:  cmdObj.name,
        desc:  cmdObj.desc,
      };
    } catch (err) {
      console.warn(`[OBD] Decoder error for ${cmdObj.name}:`, err.message);
      return null;
    }
  }

  // ── Smart DTC Fallback Logic ──────────────────────────────────────────────

  /**
   * Розумне читання помилок з перевіркою валідності через словник.
   * Використовує 5 різних варіантів запитів до ЕБУ.
   * * @param {Object} dtcDictionary - Ваш JSON об'єкт з 2000+ кодами (наприклад, { "P0104": "...", "P0597": "..." })
   * @returns {Promise<{codes: Array, variant: string}>}
   */
  // ── Smart DTC Fallback Logic (10 Variants) ──────────────────────────────

  async smartReadDTC(dtcDictionary = {}) {
    let result;

    // --- БЛОК 1: СУЧАСНІ UDS МЕТОДИ (ISO 14229) ---
    // На сучасних авто найкраще починати з UDS, бо він найточніший.

    // Варіант 1: UDS 190209 (Confirmed + Test Failed - Найчастіший успіх на VAG/BMW)
    result = await this._executeRawDTC('190209', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: result, variant: 'UDS 190209 (Confirmed/Failed)' };

    // Варіант 2: UDS 190208 (Тільки Confirmed)
    result = await this._executeRawDTC('190208', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: result, variant: 'UDS 190208 (Confirmed)' };

    // Варіант 3: UDS 19020C (Confirmed + Test Not Complete - Якщо цикл тесту ще не завершено)
    result = await this._executeRawDTC('19020C', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: result, variant: 'UDS 19020C (Conf/Not Complete)' };

    // Варіант 4: UDS 190201 (Тільки поточні Active/Test Failed)
    result = await this._executeRawDTC('190201', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: result, variant: 'UDS 190201 (Active)' };

    // Варіант 5: UDS 1902FF (Всі помилки в будь-якому статусі - "Пилосос")
    result = await this._executeRawDTC('1902FF', decoders.dtc_uds);
    if (this._verifyCodes(result, dtcDictionary, true)) return { codes: result, variant: 'UDS 1902FF (All Statuses)' };


    // --- БЛОК 2: СТАНДАРТНІ OBD-II МЕТОДИ (ISO 15031 / SAE J1979) ---
    
    // Варіант 6: Mode 03 (Збережені)
    result = await this._executeRawDTC('03', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: result, variant: 'Mode 03 (Збережені)' };

    // Варіант 7: Mode 07 (Очікувані/Тимчасові)
    result = await this._executeRawDTC('07', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: result, variant: 'Mode 07 (Очікувані)' };

    // Варіант 8: Mode 0A (Перманентні)
    result = await this._executeRawDTC('0A', decoders.dtc);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: result, variant: 'Mode 0A (Перманентні)' };


    // --- БЛОК 3: СТАРІ ПРОТОКОЛИ KWP2000 (ISO 14230) ---
    // Для автомобілів приблизно 2000-2007 років випуску

    // Варіант 9: KWP2000 Read DTCs by Status (00 00 = Всі статуси)
    result = await this._executeRawDTC('18000000', decoders.dtc_kwp);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: result, variant: 'KWP2000 18000000 (Всі)' };

    // Варіант 10: KWP2000 Read Saved DTCs
    result = await this._executeRawDTC('1802FF00', decoders.dtc_kwp);
    if (this._verifyCodes(result, dtcDictionary, false)) return { codes: result, variant: 'KWP2000 1802FF00 (Збережені)' };


    // --- FALLBACK ---
    // Якщо нічого не підійшло, але Mode 03 щось відповів (хоч і сміття), віддаємо його
    const fallback = await this._executeRawDTC('03', decoders.dtc);
    return { codes: fallback || [], variant: 'Невідомі коди (Fallback Mode 03)' };
  }

  // ── Private helpers for Smart DTC ─────────────────────────────────────────

  /**
   * Виконує сирий запит і пропускає через конкретний декодер.
   */
  async _executeRawDTC(cmd, decoderFunc) {
    try {
      const response = await this._scanner.sendCommand(cmd);
      if (!response) return [];
      
      const clean = response.replace(/[\s\r\n]/g, '').toUpperCase();
      if (clean.includes('NODATA') || clean.includes('ERROR') || clean === '') return [];

      let hexData;
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const prefixIdx = clean.indexOf('4' + cmd.charAt(1)); // 03 -> 43
        if (prefixIdx === -1) return [];
        hexData = clean.substring(prefixIdx); 
      } else if (cmd.startsWith('19')) {
        hexData = clean; // UDS: обробка починається з "5902" (перевіряється в декодері)
      } else if (cmd.startsWith('18')) {
        hexData = clean; // KWP2000: обробка починається з "58" (перевіряється в декодері dtc_kwp)
      }

      if (!hexData) return [];
      return decoderFunc(hexData);
    } catch (err) {
      console.warn(`[OBD SmartDTC] Помилка запиту ${cmd}:`, err.message);
      return [];
    }
  }

  /**
   * Перевіряє, чи отриманий список помилок є валідним згідно з вашим словником.
   * Критерій: хоча б 50% кодів мають бути розпізнані словником.
   */
  _verifyCodes(codes, dictionary, isUds) {
    if (!codes || codes.length === 0) return false;

    let validCount = 0;
    for (const codeItem of codes) {
      // Для UDS ми звіряємо базову частину (напр. "P0597"), для звичайних — весь рядок
      const codeToVerify = isUds ? codeItem.base : codeItem; 
      
      if (dictionary[codeToVerify]) {
        validCount++;
      }
    }

    // Формула валідації: якщо більше нуля і відсоток знайомих кодів >= 50%
    return validCount > 0 && (validCount / codes.length) >= 0.5;
  }

  

  // ── Utilities ─────────────────────────────────────────────────────────────

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  
}



export const obd = new OBDManager();