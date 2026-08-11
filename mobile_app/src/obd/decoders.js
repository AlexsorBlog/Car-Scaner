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

      // Structural validity — DTC codes are 5 chars total: letter + digit(0-3) + 3 more
      if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(baseCode)) continue;

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
  // Strip ISO-TP frame numbers (e.g. "1:002D" → strip "1:")
  const clean = hex.replace(/[0-9A-Fa-f]{1,2}:[0-9A-Fa-f]/g, m => m.slice(2));
  let str = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    const code = parseInt(clean.substr(i, 2), 16);
    if (code === 0) continue;
    if (code >= 32 && code < 127) str += String.fromCharCode(code);
  }
  return str.trim() || hex;
};

// Fuel system status — decode the status byte to human-readable
export const fuel_status = (hex) => {
  const byte1 = parseInt(hex.substring(0, 2), 16);
  const statuses = [];
  if (byte1 & 0x01) statuses.push('ВКЛ (Open loop, fault)');
  if (byte1 & 0x02) statuses.push('Закр. контур (норма)');
  if (byte1 & 0x04) statuses.push('Відкр. контур (пуск)');
  if (byte1 & 0x08) statuses.push('Закр. контур (O2 fault)');
  if (byte1 & 0x10) statuses.push('Закр. контур (feedback)');
  return statuses.join(', ') || `0x${hex.substring(0,2)}`;
};

// OBD compliance — map byte to standard name
export const obd_compliance = (hex) => {
  const v = parseInt(hex.substring(0, 2), 16);
  const COMPLIANCE = {
    1: 'OBD-II (CARB)', 2: 'OBD (EPA)', 3: 'OBD+OBD-II', 4: 'OBD-I',
    5: 'No OBD', 6: 'EOBD', 7: 'EOBD+OBD-II', 8: 'EOBD+OBD',
    9: 'EOBD+OBD+OBD-II', 10: 'JOBD', 11: 'JOBD+OBD-II', 12: 'JOBD+EOBD',
    13: 'JOBD+EOBD+OBD-II', 17: 'EMD', 18: 'EMD+', 19: 'HD OBD-C',
    20: 'HD OBD', 21: 'WWH OBD', 23: 'HD EOBD-I', 24: 'HD EOBD-I N',
    25: 'HD EOBD-II', 26: 'HD EOBD-II N', 28: 'OBDBr-1', 29: 'OBDBr-2',
    30: 'KOBD', 31: 'IOBD-I', 32: 'IOBD-II', 33: 'HD EOBD-IV',
  };
  return COMPLIANCE[v] || `Стандарт 0x${v.toString(16).toUpperCase()}`;
};

// O2 sensors present — decode bitmask
export const o2_sensors = (hex) => {
  const v = parseInt(hex.substring(0, 2), 16);
  const present = [];
  const labels  = ['B1S1','B1S2','B1S3','B1S4','B2S1','B2S2','B2S3','B2S4'];
  labels.forEach((l, i) => { if (v & (1 << i)) present.push(l); });
  return present.length ? present.join(', ') : 'Немає';
};

export const o2_sensors_alt = o2_sensors;

// Evap pressure — FEEE means "not available", otherwise signed int16
export const evap_pressure = (hex) => {
  const raw = parseInt(hex.substring(0, 4), 16);
  if (raw === 0xFEEE || raw === 0xFFFF) return 'Н/Д';
  // Signed: range -8192 to +8191 Pa
  const signed = raw > 32767 ? raw - 65536 : raw;
  return `${signed} Па`;
};

export const abs_evap_pressure = (hex) => {
  const v = parseInt(hex.substring(0, 4), 16);
  if (v === 0xFEEE || v === 0xFFFF) return 'Н/Д';
  return parseFloat((v / 200.0).toFixed(2));
};

// Drive cycle status — decode the 4-byte bitmask
export const status = (hex) => {
  if (!hex || hex.length < 2) return hex;
  const b0 = parseInt(hex.substring(0,2), 16);
  const milOn = !!(b0 & 0x80);
  const dtcCnt = b0 & 0x7F;
  return `MIL: ${milOn ? 'УВІМК' : 'ВИМК'} · ${dtcCnt} кодів`;
};

// CVN — strip ISO-TP frame numbers, format as clean hex groups
export const cvn = (hex) => {
  // Remove frame sequence numbers like "1:", "2:" etc
  const clean = hex.replace(/[0-9A-Fa-f]{1,2}:/g, '');
  // Group into 4-byte CVN values
  const groups = [];
  for (let i = 0; i + 7 < clean.length; i += 8) {
    groups.push(clean.substring(i, i+8).toUpperCase());
  }
  return groups.length ? groups.join(' ') : clean.toUpperCase();
};

// ECU name — decode from hex to ASCII, strip frame numbers
export const elm_voltage = (hex) => hex;

// Single DTC — keep as raw for now (used in mode 1 DTC status)
export const single_dtc = (hex) => {
  if (!hex || hex === '0000') return 'Немає';
  const LETTERS = ['P','C','B','U'];
  const b = parseInt(hex.substring(0,2),16);
  const letter = LETTERS[(b >> 6) & 0x03];
  const d1 = (b >> 4) & 0x03;
  const d2 = (b & 0x0F).toString(16).toUpperCase();
  const d34 = hex.substring(2,4).toUpperCase();
  return `${letter}${d1}${d2}${d34}`;
};

export const pid              = (hex) => hex;
export const air_status       = (hex) => {
  const v = parseInt(hex.substring(0,2), 16);
  if (v & 0x01) return 'Upstream';
  if (v & 0x02) return 'Downstream';
  if (v & 0x04) return 'Off / not used';
  return `0x${v.toString(16).toUpperCase()}`;
};
export const aux_input_status = (hex) => parseInt(hex.substring(0,2),16) & 0x01 ? 'Увімк.' : 'Вимк.';
export const fuel_type        = (hex) => {
  const TYPES = {
    0:'Не визначено',1:'Бензин',2:'Метанол',3:'Етанол',4:'Дизель',
    5:'LPG',6:'CNG',7:'Пропан',8:'Електро',9:'Біфуель (бензин)',
    10:'Біфуель (метанол)',11:'Біфуель (етанол)',12:'Біфуель (LPG)',
    13:'Біфуель (CNG)',14:'Біфуель (пропан)',15:'HFCEV',16:'Гібрид (електро)',
    17:'Гібрид (бензин)',18:'Гібрид (дизель)',
  };
  const v = parseInt(hex.substring(0,2),16);
  return TYPES[v] || `Тип ${v}`;
};
export const monitor          = (hex) => hex;
export const evap_pressure_alt = (hex) => {
  const raw = parseInt(hex.substring(0,4),16);
  if (raw === 0xFEEE || raw === 0xFFFF) return 'Н/Д';
  const signed = raw > 32767 ? raw - 65536 : raw;
  return `${signed} Па`;
};
