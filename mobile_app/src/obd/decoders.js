/**
 * obd/decoders.js — complete fixed version
 * Key fix: dtc_uds now handles MULTIPLE 5902 blocks (multi-ECU responses)
 */

export const hexToInt  = (hex) => parseInt(hex, 16);
export const clamp     = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const twoBytes  = (hex) => hexToInt(hex.substring(0, 4));

export const raw_string = (hex) => hex;
export const drop = () => null;

export const percent = (hex) => {
  const v = hexToInt(hex.substring(0, 2));
  return clamp(Math.round((v * 100.0) / 255.0), 0, 100);
};

export const percent_centered = (hex) => {
  const v = hexToInt(hex.substring(0, 2));
  return clamp(Math.round(((v - 128) * 100.0) / 128.0), -100, 100);
};

export const temp        = (hex) => hexToInt(hex.substring(0, 2)) - 40;
export const pressure    = (hex) => hexToInt(hex.substring(0, 2));
export const fuel_pressure = (hex) => hexToInt(hex.substring(0, 2)) * 3;

export const current_centered = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 4)) / 256.0) - 128).toFixed(2));

export const sensor_voltage = (hex) =>
  parseFloat((hexToInt(hex.substring(0, 2)) / 200.0).toFixed(3));

export const sensor_voltage_big = (hex) =>
  parseFloat(((hexToInt(hex.substring(4, 8)) * 8.0) / 65535).toFixed(3));

export const timing_advance = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 2)) / 2.0) - 64).toFixed(1));

export const inject_timing = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 4)) - 26880) / 128.0).toFixed(2));

export const fuel_rate = (hex) =>
  parseFloat((hexToInt(hex.substring(0, 4)) * 0.05).toFixed(2));

export const max_maf = (hex) => hexToInt(hex.substring(0, 2)) * 10;
export const count   = (hex) => hexToInt(hex);

export const absolute_load = (hex) =>
  clamp(Math.round(hexToInt(hex.substring(0, 4)) / 655.35), 0, 100);

export const decodeUas = (hex, id) => {
  const v = hexToInt(hex);
  switch (id.toLowerCase()) {
    case '0x01': return v;
    case '0x07': return Math.round(v / 4.0);
    case '0x09': return v;
    case '0x0b': return parseFloat((v / 1000.0).toFixed(2));
    case '0x12': return v;
    case '0x16': return parseFloat((v * 0.1 - 40).toFixed(1));
    case '0x19': return parseFloat((v * 0.079).toFixed(2));
    case '0x1b': return v;
    case '0x1e': return parseFloat((v * 0.0000305).toFixed(5));
    case '0x25': return v;
    case '0x27': return parseFloat((v / 100.0).toFixed(2));
    case '0x34': return v;
    default:     return v;
  }
};

// ── DTC (Mode 03 / 07 / 0A) ──────────────────────────────────────────────────

export const dtc = (hex) => {
  if (!hex || hex.length < 4) return [];
  const codes   = [];
  const LETTERS = ['P', 'C', 'B', 'U'];
  const countByte = parseInt(hex.substring(0, 2), 16);
  if (countByte === 0) return [];
  const data = hex.substring(2);
  for (let i = 0; i + 3 < data.length; i += 4) {
    const chunk = data.substring(i, i + 4);
    if (chunk === '0000') continue;
    const byteA = parseInt(chunk.substring(0, 2), 16);
    const byteB = parseInt(chunk.substring(2, 4), 16);
    if (byteA === 0 && byteB === 0) continue;
    const letter = LETTERS[(byteA >> 6) & 0x03];
    const d1     = (byteA >> 4) & 0x03;
    const d234   = ((byteA & 0x0F).toString(16) + byteB.toString(16).padStart(2, '0')).toUpperCase();
    const code   = `${letter}${d1}${d234}`;
    if (d1 === 0 && (byteA & 0x0F) === 0 && byteB === 0) continue;
    codes.push(code);
  }
  return codes;
};

// ── UDS DTC decoder — FIXED: handles multiple 5902 blocks (multi-ECU) ────────

export const dtc_uds = (hex) => {
  if (!hex || hex.length < 6) return [];

  // Guard: memory dump (1902FF on some ECUs returns huge payload)
  if (hex.length > 400) {
    console.warn('[dtc_uds] Payload too large (' + hex.length + ' chars) — rejected');
    return [];
  }

  // Guard: unresolved CAN multi-frame markers
  if (hex.includes(':')) {
    console.warn('[dtc_uds] Unresolved CAN frame markers — rejected');
    return [];
  }

  const LETTERS  = ['P', 'C', 'B', 'U'];
  const allCodes = new Map(); // base → { base, full, statusByte }

  // ── Find ALL 5902xx occurrences — one per ECU ─────────────────────────────
  const PREFIX    = '5902';
  let   searchFrom = 0;
  const ecuOffsets = [];

  while (true) {
    const idx = hex.indexOf(PREFIX, searchFrom);
    if (idx === -1) break;
    ecuOffsets.push(idx);
    searchFrom = idx + 4;
  }

  if (ecuOffsets.length === 0) return [];

  // ── Parse each ECU slice independently ───────────────────────────────────
  for (let e = 0; e < ecuOffsets.length; e++) {
    const sliceStart = ecuOffsets[e];
    const sliceEnd   = e + 1 < ecuOffsets.length ? ecuOffsets[e + 1] : hex.length;
    const ecuHex     = hex.substring(sliceStart, sliceEnd);

    // Skip '5902' (4 chars) + status availability mask byte (2 chars) = 6 chars
    if (ecuHex.length < 6) continue;
    const data = ecuHex.substring(6);

    for (let i = 0; i + 7 < data.length; i += 8) {
      const chunk = data.substring(i, i + 8);

      if (chunk.startsWith('000000')) continue; // null padding
      if (chunk.includes('AAAA'))    continue;  // 0xAA fill

      const byteA      = parseInt(chunk.substring(0, 2), 16);
      const byteB      = chunk.substring(2, 4);
      const byteC      = chunk.substring(4, 6); // FTB
      const statusByte = parseInt(chunk.substring(6, 8), 16);

      if (isNaN(byteA)) continue;

      const letter   = LETTERS[(byteA >> 6) & 0x03];
      const d1       = (byteA >> 4) & 0x03;
      const d2       = byteA & 0x0F;
      const baseCode = `${letter}${d1}${d2.toString(16).toUpperCase()}${byteB}`;

      // Structural validity
      if (!/^[PCBU][0-3][0-9A-F]{4}$/.test(baseCode)) continue;

      // Union: keep first occurrence (ECU 0 usually most authoritative)
      if (!allCodes.has(baseCode)) {
        allCodes.set(baseCode, { base: baseCode, full: `${baseCode}-${byteC}`, statusByte });
      }
    }
  }

  return Array.from(allCodes.values());
};

// ── KWP2000 DTC decoder ───────────────────────────────────────────────────────

export const dtc_kwp = (hex) => {
  if (!hex || hex.length < 4) return [];
  const codes   = [];
  const LETTERS = ['P', 'C', 'B', 'U'];
  const prefixIdx = hex.indexOf('58');
  if (prefixIdx === -1) return [];
  const data    = hex.substring(prefixIdx + 2);
  if (data.length < 2) return [];
  const payload = data.substring(2);
  for (let i = 0; i + 5 < payload.length; i += 6) {
    const chunk = payload.substring(i, i + 6);
    if (chunk.startsWith('000000')) continue;
    const byteA  = parseInt(chunk.substring(0, 2), 16);
    const byteB  = parseInt(chunk.substring(2, 4), 16);
    const letter = LETTERS[(byteA >> 6) & 0x03];
    const d1     = (byteA >> 4) & 0x03;
    const d234   = ((byteA & 0x0F).toString(16) + byteB.toString(16).padStart(2, '0')).toUpperCase();
    codes.push(`${letter}${d1}${d234}`);
  }
  return codes;
};

// ── String / misc decoders ────────────────────────────────────────────────────

export const decodeEncodedString = (hex) => {
  let str = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.substr(i, 2), 16);
    if (code === 0) continue;
    str += String.fromCharCode(code);
  }
  return str.replace(/[^ -~]/g, '').trim();
};

export const pid              = (hex) => hex;
export const status           = (hex) => hex;
export const single_dtc       = (hex) => hex;
export const fuel_status      = (hex) => hex;
export const air_status       = (hex) => hex;
export const obd_compliance   = (hex) => hex;
export const o2_sensors       = (hex) => hex;
export const o2_sensors_alt   = (hex) => hex;
export const aux_input_status = (hex) => hex;
export const fuel_type        = (hex) => hex;
export const monitor          = (hex) => hex;
export const cvn              = (hex) => hex;
export const elm_voltage      = (hex) => hex;

export const abs_evap_pressure = (hex) => parseFloat((hexToInt(hex) / 200.0).toFixed(2));
export const evap_pressure_alt = (hex) => hexToInt(hex) - 32767;
export const evap_pressure     = (hex) => hex;