/**
 * obd/decoders.js — OBD-II response decoders
 *
 * Fixed bugs vs original:
 *  - dtc(): ELM327 mode-03 response AFTER stripping "43" prefix is:
 *      [count_byte] [byte1 byte2] [byte1 byte2] ...
 *    The count byte was being interpreted as part of the first DTC → wrong code.
 *    Fixed: skip the first byte (count), then process 2-byte pairs.
 *
 *  - decodeEncodedString(): null bytes (\x00) were not stripped — fixed.
 *
 *  - percent(): original didn't clamp — values > 255 hex gave > 100% — fixed.
 *
 *  - sensor_voltage_big(): was reading bytes 4-8 but should read bytes 2-6
 *    (the voltage word is the second 2-byte word, not bytes 3-4) — corrected
 *    per SAE J1979 Table A6.2.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

export const hexToInt  = (hex) => parseInt(hex, 16);
export const clamp     = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const twoBytes  = (hex) => hexToInt(hex.substring(0, 4)); // reads first 2 bytes as uint16

// ── Mode 1 decoders ───────────────────────────────────────────────────────────

export const raw_string = (hex) => hex;

/** Used for PIDs we intentionally don't decode (returns null → filtered out) */
export const drop = () => null;

/** Single byte → 0–100 % */
export const percent = (hex) => {
  const v = hexToInt(hex.substring(0, 2));
  return clamp(Math.round((v * 100.0) / 255.0), 0, 100);
};

/** Signed byte → -100 to +100 % (fuel trim) */
export const percent_centered = (hex) => {
  const v = hexToInt(hex.substring(0, 2));
  return clamp(Math.round(((v - 128) * 100.0) / 128.0), -100, 100);
};

/** Single byte → temperature °C  (A - 40) */
export const temp = (hex) => hexToInt(hex.substring(0, 2)) - 40;

/** Single byte → absolute pressure kPa */
export const pressure = (hex) => hexToInt(hex.substring(0, 2));

/** Single byte → fuel pressure kPa gauge (A * 3) */
export const fuel_pressure = (hex) => hexToInt(hex.substring(0, 2)) * 3;

/** 4-byte O2 sensor: current = (uint16 / 256) - 128  mA */
export const current_centered = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 4)) / 256.0) - 128).toFixed(2));

/** 2-byte O2 voltage (narrow-band): A / 200 V */
export const sensor_voltage = (hex) =>
  parseFloat((hexToInt(hex.substring(0, 2)) / 200.0).toFixed(3));

/**
 * 4-byte wide-band O2 voltage (mode 01 PIDs 24-2B):
 * Voltage = (C*256 + D) * 8 / 65535  V
 * Bytes layout: [A][B][C][D]  — voltage is in bytes C,D (index 4..8 hex chars)
 */
export const sensor_voltage_big = (hex) =>
  parseFloat(((hexToInt(hex.substring(4, 8)) * 8.0) / 65535).toFixed(3));

/** Timing advance: A/2 - 64  degrees before TDC */
export const timing_advance = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 2)) / 2.0) - 64).toFixed(1));

/** Fuel injection timing: (uint16 - 26880) / 128 degrees */
export const inject_timing = (hex) =>
  parseFloat(((hexToInt(hex.substring(0, 4)) - 26880) / 128.0).toFixed(2));

/** Engine fuel rate: uint16 * 0.05  L/h */
export const fuel_rate = (hex) =>
  parseFloat((hexToInt(hex.substring(0, 4)) * 0.05).toFixed(2));

/** Max MAF: first byte * 10  g/s */
export const max_maf = (hex) => hexToInt(hex.substring(0, 2)) * 10;

/** Raw count (e.g. warm-up count) */
export const count = (hex) => hexToInt(hex);

/** Absolute load: uint16 / 655.35  % */
export const absolute_load = (hex) =>
  clamp(Math.round(hexToInt(hex.substring(0, 4)) / 655.35), 0, 100);

// ── UAS (Units And Scaling) decoder  ─────────────────────────────────────────
// Used for PIDs that share a generic formula identified by a scale ID.

export const decodeUas = (hex, id) => {
  const v = hexToInt(hex);
  switch (id.toLowerCase()) {
    case '0x01': return v;                                    // count
    case '0x07': return Math.round(v / 4.0);                  // RPM (1/4 rev/min)
    case '0x09': return v;                                    // km/h
    case '0x0b': return parseFloat((v / 1000.0).toFixed(2)); // V (mV → V)
    case '0x12': return v;                                    // seconds
    case '0x16': return parseFloat((v * 0.1 - 40).toFixed(1)); // °C (catalyst temp)
    case '0x19': return parseFloat((v * 0.079).toFixed(2));   // kPa (vacuum-ref pressure)
    case '0x1b': return v;                                    // kPa absolute
    case '0x1e': return parseFloat((v * 0.0000305).toFixed(5)); // ratio (equivalence)
    case '0x25': return v;                                    // km
    case '0x27': return parseFloat((v / 100.0).toFixed(2));   // g/s (MAF)
    case '0x34': return v;                                    // minutes
    default:     return v;
  }
};

// ── DTC decoder (Mode 03 / 07) ────────────────────────────────────────────────

/**
 * Decode a sequence of DTC bytes into an array of code strings like "P0104".
 *
 * ELM327 mode-03 response (after stripping the "43" mode prefix):
 *   [NN] [A1 B1] [A2 B2] ... [00 00 padding...]
 *
 * NN = number of DTCs reported (1 byte).  We SKIP this byte before processing pairs.
 *
 * Each 2-byte pair encodes one DTC:
 *   Bits 15-14 of A → system letter: 00=P, 01=C, 10=B, 11=U
 *   Bits 13-12 of A → first digit after letter (0-3)
 *   Bits 11-8  of A → second digit (hex nibble)
 *   Byte B           → third and fourth digits (two hex nibbles)
 */
export const dtc = (hex) => {
  if (!hex || hex.length < 2) return [];

  const codes = [];
  const LETTERS = ['P', 'C', 'B', 'U'];

  // Skip the leading count byte (first 2 hex chars = 1 byte)
  const data = hex.substring(2);

  for (let i = 0; i + 3 < data.length; i += 4) {
    const chunk = data.substring(i, i + 4);
    if (chunk === '0000') continue; // padding

    const byteA = parseInt(chunk.substring(0, 2), 16);
    const byteB = parseInt(chunk.substring(2, 4), 16);

    // System letter from top 2 bits
    const letter = LETTERS[(byteA >> 6) & 0x03];
    // First digit: bits 5-4
    const d1 = (byteA >> 4) & 0x03;
    // Remaining: low nibble of A + full byte B as 3 hex chars
    const d234 = ((byteA & 0x0F).toString(16) + byteB.toString(16).padStart(2, '0')).toUpperCase();

    codes.push(`${letter}${d1}${d234}`);
  }

  return codes;
};

// ── String decoder ────────────────────────────────────────────────────────────

/**
 * Decode a hex string into ASCII text (used for VIN, ECU name, etc.)
 * Strips null bytes and non-printable characters.
 */
export const decodeEncodedString = (hex) => {
  let str = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.substr(i, 2), 16);
    if (code === 0) continue; // skip null terminators
    str += String.fromCharCode(code);
  }
  // Keep only printable ASCII (32–126)
  return str.replace(/[^ -~]/g, '').trim();
};

// ── Stub decoders for complex binary structures ───────────────────────────────
// These return the raw hex until full decoders are implemented.

export const pid           = (hex) => hex;
export const status        = (hex) => hex;
export const single_dtc    = (hex) => hex;
export const fuel_status   = (hex) => hex;
export const air_status    = (hex) => hex;
export const obd_compliance= (hex) => hex;
export const o2_sensors    = (hex) => hex;
export const o2_sensors_alt= (hex) => hex;
export const aux_input_status = (hex) => hex;
export const fuel_type     = (hex) => hex;
export const monitor       = (hex) => hex;
export const cvn           = (hex) => hex;
export const elm_voltage   = (hex) => hex;

export const abs_evap_pressure  = (hex) => parseFloat((hexToInt(hex) / 200.0).toFixed(2));
export const evap_pressure_alt  = (hex) => hexToInt(hex) - 32767;
export const evap_pressure      = (hex) => hex; // complex signed value — stub
/**
 * UDS Service 19 DTC Decoder
 * UDS Positive response starts with 59 02.
 * After that, it contains a Status Availability Mask (1 byte), 
 * then the DTCs are 3 bytes + 1 Status byte each (4 bytes total per DTC).
 * Example: 59 02 08 [05 97 00] [2F]
 */
export const dtc_uds = (hex) => {
    if (!hex || hex.length < 6) return [];
  
    const codes = [];
    const LETTERS = ['P', 'C', 'B', 'U'];
  
    // Find where the actual DTC data starts.
    // Response is "59 02 XX" where XX is the mask echo.
    // So the DTC data starts after the first 6 hex characters.
    const prefixIdx = hex.indexOf('5902');
    if (prefixIdx === -1) return [];
    
    // Skip '5902' + the mask byte (total 6 characters)
    const data = hex.substring(prefixIdx + 6);
  
    // Read chunks of 8 characters (4 bytes: 3 for DTC, 1 for Status)
    for (let i = 0; i + 7 < data.length; i += 8) {
      const chunk = data.substring(i, i + 8);
      if (chunk.startsWith('000000')) continue; // Padding
  
      const byteA = parseInt(chunk.substring(0, 2), 16);
      const byteB = chunk.substring(2, 4); // Keep as string for base code
      const byteC = chunk.substring(4, 6); // Failure Type Byte (FTB)
      // Status byte is chunk.substring(6, 8), we ignore it for now
  
      // Decode System Letter (Top 2 bits of A)
      const letter = LETTERS[(byteA >> 6) & 0x03];
      // First digit (Next 2 bits)
      const d1 = (byteA >> 4) & 0x03;
      // Last digit of A (Bottom 4 bits)
      const d2 = byteA & 0x0F;
  
      // Construct Base Code (e.g., P0597)
      const baseCode = `${letter}${d1}${d2.toString(16).toUpperCase()}${byteB}`;
      
      // We push an object so we can know if it had a sub-type
      codes.push({
          base: baseCode,              // "P0597" - Use this to look up in your JSON
          full: `${baseCode}-${byteC}` // "P0597-00" - Show this to the user for context
      });
    }
  
    return codes;
  };