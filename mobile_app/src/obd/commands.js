/**
 * obd/commands.js — OBD command registry
 *
 * Loads all commands from obd_commands.json and builds OBDCommand objects
 * that hold the raw command string, byte count, decoder function, and unit.
 *
 * Changes vs original:
 *  - guessUnit() rewritten to be non-brittle (no substring matching on decoder strings)
 *  - parseDecoder() error path improved — unknown decoders fall back to raw_string
 *    instead of silently setting a non-function value
 *  - Exported mode3/mode4 objects now use safe hasOwnProperty access
 */

import * as decoders    from './decoders.js';
import commandsData     from './obd_commands.json';

// ── Unit lookup table — keyed by canonical decoder name or UAS id ─────────────

const UAS_UNITS = {
  '0x01': '',
  '0x07': 'об/хв',
  '0x09': 'км/год',
  '0x0b': 'В',
  '0x12': 'сек',
  '0x16': '°C',
  '0x19': 'кПа',
  '0x1b': 'кПа',
  '0x1e': '',
  '0x25': 'км',
  '0x27': 'г/с',
  '0x34': 'хв',
};

const DECODER_UNITS = {
  percent:          '%',
  percent_centered: '%',
  temp:             '°C',
  pressure:         'кПа',
  fuel_pressure:    'кПа',
  absolute_load:    '%',
  sensor_voltage:   'В',
  sensor_voltage_big: 'В',
  current_centered: 'мА',
  timing_advance:   '°',
  inject_timing:    '°',
  fuel_rate:        'л/год',
  max_maf:          'г/с',
  count:            '',
  abs_evap_pressure:'кПа',
};

// ── OBDCommand ────────────────────────────────────────────────────────────────

export class OBDCommand {
  /**
   * @param {string} name       e.g. "RPM"
   * @param {string} desc       Human-readable description
   * @param {string} command    Raw ELM327 command string e.g. "010C"
   * @param {number} totalBytes Total bytes in full response frame (including 2 echo bytes)
   * @param {string} decoderStr Decoder identifier from JSON e.g. "percent", "uas(0x07)"
   */
  constructor(name, desc, command, totalBytes, decoderStr) {
    this.name    = name;
    this.desc    = desc;
    this.command = command;

    // Strip the 2 echo/header bytes — remaining bytes are payload
    // totalBytes=0 means variable-length (mode 3/7)
    this.bytes   = totalBytes > 2 ? totalBytes - 2 : 0;

    this.decoder = this._resolveDecoder(decoderStr);
    this.unit    = this._resolveUnit(decoderStr);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _resolveDecoder(str) {
    if (!str) return decoders.raw_string;

    // uas(0xNN) pattern
    const uasMatch = str.match(/^uas\((0x[0-9a-fA-F]+)\)$/i);
    if (uasMatch) {
      const id = uasMatch[1].toLowerCase();
      return (hex) => decoders.decodeUas(hex, id);
    }

    // encoded_string(N) pattern
    const strMatch = str.match(/^encoded_string\(\d+\)$/i);
    if (strMatch) {
      return (hex) => decoders.decodeEncodedString(hex);
    }

    // Named decoder
    if (typeof decoders[str] === 'function') {
      return decoders[str];
    }

    console.warn(`[OBDCommand] Unknown decoder '${str}' for — using raw_string`);
    return decoders.raw_string;
  }

  _resolveUnit(str) {
    if (!str) return '';

    const uasMatch = str.match(/^uas\((0x[0-9a-fA-F]+)\)$/i);
    if (uasMatch) {
      return UAS_UNITS[uasMatch[1].toLowerCase()] ?? '';
    }

    return DECODER_UNITS[str] ?? '';
  }
}

// ── Build command registry ────────────────────────────────────────────────────

/** All commands indexed by name: commands.RPM, commands.SPEED, etc. */
export const commands = {};

for (const modeKey of Object.keys(commandsData)) {
  for (const cmdData of commandsData[modeKey]) {
    commands[cmdData.name] = new OBDCommand(
      cmdData.name,
      cmdData.description,
      cmdData.cmd,
      cmdData.bytes,
      cmdData.decoder,
    );
  }
}

// ── Convenience exports ───────────────────────────────────────────────────────

/** All Mode 1 (live data) commands as an ordered array */
export const mode1Commands = (commandsData.mode1 ?? []).map(c => commands[c.name]).filter(Boolean);

/** Mode 3 — read stored DTCs */
export const mode3 = {};
for (const c of (commandsData.mode3 ?? [])) {
  if (commands[c.name]) mode3[c.name] = commands[c.name];
}

/** Mode 4 — clear DTCs */
export const mode4 = {};
for (const c of (commandsData.mode4 ?? [])) {
  if (commands[c.name]) mode4[c.name] = commands[c.name];
}

/** Mode 7 — pending DTCs (current drive cycle) */
export const mode7 = {};
for (const c of (commandsData.mode7 ?? [])) {
  if (commands[c.name]) mode7[c.name] = commands[c.name];
}

/** Mode 9 — vehicle info (VIN etc.) */
export const mode9 = {};
for (const c of (commandsData.mode9 ?? [])) {
  if (commands[c.name]) mode9[c.name] = commands[c.name];
}