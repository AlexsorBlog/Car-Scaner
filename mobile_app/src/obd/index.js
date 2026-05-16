import { obdScanner } from '../services/bleService.js';
import { commands }   from './commands.js';
import * as decoders  from './decoders.js';
import { saveRawLog } from '../services/db.js'; 

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
        
        saveRawLog('INIT', step.cmd, res || 'NO_RESPONSE');

        if (step.cmd === 'ATZ' && !res.toUpperCase().includes('ELM')) {
          console.warn('[OBD init] ATZ response unexpected — device may not be ELM327');
        }
        if (step.delay > 100) {
          await this._sleep(step.delay);
        }
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

    if (typeof cmdObj.decoder !== 'function') return null;

    try {
      const value = cmdObj.decoder(targetHex);
      if (value === null || value === undefined) return null;
      return {
        value, unit: cmdObj.unit, raw: targetHex, name: cmdObj.name, desc: cmdObj.desc,
      };
    } catch (err) {
      return null;
    }
  }

  // 🔥 NEW WATERFALL DTC SCANNER
  async smartReadDTC(dtcDictionary = {}) {
    const allCodes = new Map();
    const usedVariants = [];

    // Master list of every single way to ask a car for codes
    const methods = [
      { cmd: '190209', dec: decoders.dtc_uds, isUds: true,  name: 'UDS 09' },
      { cmd: '190208', dec: decoders.dtc_uds, isUds: true,  name: 'UDS 08' },
      { cmd: '19020C', dec: decoders.dtc_uds, isUds: true,  name: 'UDS 0C' },
      { cmd: '190201', dec: decoders.dtc_uds, isUds: true,  name: 'UDS 01' },
      { cmd: '1902FF', dec: decoders.dtc_uds, isUds: true,  name: 'UDS FF' },
      { cmd: '03',     dec: decoders.dtc,     isUds: false, name: 'Mode 03' },
      { cmd: '07',     dec: decoders.dtc,     isUds: false, name: 'Mode 07' },
      { cmd: '0A',     dec: decoders.dtc,     isUds: false, name: 'Mode 0A' },
      { cmd: '18000000', dec: decoders.dtc_kwp, isUds: false, name: 'KWP 00' },
      { cmd: '1802FF00', dec: decoders.dtc_kwp, isUds: false, name: 'KWP FF' }
    ];

    // Run ALL methods, do not stop if one is empty
    for (const method of methods) {
      const result = await this._executeRawDTC(method.cmd, method.dec);
      
      if (result && result.length > 0) {
        let addedNew = false;
        
        for (const item of result) {
          const baseCode = method.isUds ? item.base : item;
          
          // 🔥 FATAL FILTER: Hard-delete ghost codes caused by J1979 ECU padding
          if (['P0000', 'C0300', 'C0700', 'C0A00'].includes(baseCode)) continue;
          
          const isKnown = !!dtcDictionary[baseCode];
          
          // Only add if it's new, or if this version is known in our database
          if (!allCodes.has(baseCode) || (isKnown && !allCodes.get(baseCode).isKnown)) {
            allCodes.set(baseCode, {
              code: method.isUds ? item.full : item,
              base: baseCode,
              isKnown: isKnown,
              variant: method.name
            });
            addedNew = true;
          }
        }
        
        if (addedNew && !usedVariants.includes(method.name)) {
          usedVariants.push(method.name);
        }
      }
    }

    if (allCodes.size === 0) {
      return { codes: [], variant: 'Комплексне сканування (Помилок не виявлено)' };
    }

    const finalCodes = Array.from(allCodes.values()).map(item => ({
      code: item.code,
      title: dtcDictionary[item.base] || "Невідома помилка",
      desc: "Знайдено в базі",
      base: item.base,
      variant: item.variant
    }));

    // Sort: Push recognized errors to the top of the list
    finalCodes.sort((a, b) => {
      const aKnown = !!dtcDictionary[a.base];
      const bKnown = !!dtcDictionary[b.base];
      if (aKnown === bKnown) return 0;
      return aKnown ? -1 : 1;
    });

    return { 
      codes: finalCodes, 
      variant: `Знайдено через: ${usedVariants.join(', ')}` 
    };
  }

  async _executeRawDTC(cmd, decoderFunc) {
    try {
      const response = await this._scanner.sendCommand(cmd);
      saveRawLog('DTC_RAW_RES', cmd, response || 'NO_RESPONSE');

      if (!response) return null; 

      const rawUpper = response.toUpperCase();

      if (
        rawUpper.includes('ERROR') || rawUpper.includes('?') || 
        rawUpper.includes('UNABLE') || rawUpper.includes('NODATA') || 
        rawUpper.includes('NO DATA')
      ) {
        return null; 
      }
      
      const lines = response.split(/[\r\n]+/).map(l => l.replace(/[\s>]/g, '').toUpperCase());
      let fullHexPayload = "";

      for (let line of lines) {
        if (!line) continue;
        line = line.replace(/^[0-9A-F]:/, ''); // Remove CAN PCI frames
        fullHexPayload += line;
      }

      let hexData = "";
      let prefixFound = false;

      // 🔥 BUGFIX: Smart string alignment to prevent ELM327 multi-ECU shift
      if (cmd === '03' || cmd === '07' || cmd === '0A') {
        const expectedPrefix = '4' + cmd.charAt(1);
        
        let idx = fullHexPayload.indexOf(expectedPrefix);
        if (idx !== -1) prefixFound = true;
        
        while (idx !== -1) {
          let nextIdx = fullHexPayload.indexOf(expectedPrefix, idx + 2);
          let ecuPayload = nextIdx !== -1 
             ? fullHexPayload.substring(idx + 2, nextIdx) 
             : fullHexPayload.substring(idx + 2);
             
          // If the payload has an odd count byte, strip it to realign to 4
          if (ecuPayload.length % 4 !== 0) {
             ecuPayload = ecuPayload.substring(2);
          }
          
          const validLen = Math.floor(ecuPayload.length / 4) * 4;
          hexData += ecuPayload.substring(0, validLen);
          
          idx = nextIdx;
        }
      } else if (cmd.startsWith('19') || cmd.startsWith('18')) {
        prefixFound = true; 
        hexData = fullHexPayload; // KWP and UDS decoders handle this internally
      }

      if (!prefixFound) return null; 

      const decoded = decoderFunc(hexData || "");
      if (Array.isArray(decoded)) {
        if (decoded.length > 0) saveRawLog('DTC_DECODED', cmd, JSON.stringify(decoded));
        return decoded; 
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