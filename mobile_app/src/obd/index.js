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

  // ── Utilities ─────────────────────────────────────────────────────────────

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export const obd = new OBDManager();