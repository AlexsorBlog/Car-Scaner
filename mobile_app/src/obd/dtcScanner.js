/**
 * obd/dtcScanner.js — multi-ECU, multi-protocol DTC scanner.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous scanner only ever talked to whatever ECU answered the default
 * header, using a fixed list of 9 commands. That's why a real Mercedes with a
 * known thermostat + battery fault reported "no errors": those are
 * manufacturer-specific codes stored in NON-engine modules, and generic OBD-II
 * Mode 03 only ever returns emissions-related codes from the powertrain ECU.
 * Confirmed in that car's own log — Mode 03/07/0A all answered correctly with
 * a zero count ("4300"/"4700"/"4A00"), i.e. the ECU was telling the truth;
 * we were simply asking the wrong module, in the wrong protocol.
 *
 * Real scan tools do three things we didn't:
 *   1. Turn headers ON so you can tell WHICH module answered.
 *   2. Enumerate the modules on the bus instead of assuming one.
 *   3. Per module, escalate: generic OBD → UDS (with a diagnostic session
 *      first) → KWP, because different modules speak different dialects.
 *
 * ECU addressing follows ISO 15765-4, cross-checked against opendbc's own
 * bus-scanning code (opendbc/car/ecu_addrs.py), which probes 0x700-0x7FF for
 * 11-bit and 0x18DAxxF1 for 29-bit. UDS service/subfunction/status-mask
 * constants follow ISO 14229-1 (mirrored in opendbc/car/uds.py).
 *
 * TESTABILITY
 * -----------
 * The scanner takes a `sendCommand` function rather than importing the BLE
 * layer, so the whole flow can be driven against a mock ELM327 in tests
 * (see __tests__/dtcScanner.test.mjs). All parsing helpers below are pure.
 */

// ── UDS (ISO 14229-1) ────────────────────────────────────────────────────────

export const UDS_SERVICE = {
  DIAGNOSTIC_SESSION_CONTROL: 0x10,
  CLEAR_DIAGNOSTIC_INFORMATION: 0x14,
  READ_DTC_INFORMATION: 0x19,
  READ_DATA_BY_IDENTIFIER: 0x22,
  TESTER_PRESENT: 0x3E,
};

export const UDS_SESSION = {
  DEFAULT: 0x01,
  PROGRAMMING: 0x02,
  EXTENDED_DIAGNOSTIC: 0x03,
  SAFETY_SYSTEM_DIAGNOSTIC: 0x04,
};

// Service 0x19 sub-functions worth asking for. Ordered cheapest/most-supported
// first; the scan stops adding new codes once modules stop yielding any.
export const DTC_REPORT = {
  NUMBER_OF_DTC_BY_STATUS_MASK: 0x01,
  DTC_BY_STATUS_MASK: 0x02,
  SUPPORTED_DTC: 0x0A,
  FIRST_CONFIRMED_DTC: 0x0C,
  MOST_RECENT_CONFIRMED_DTC: 0x0E,
  MIRROR_MEMORY_DTC_BY_STATUS_MASK: 0x0F,
  EMISSIONS_RELATED_OBD_DTC_BY_STATUS_MASK: 0x13,
  DTC_WITH_PERMANENT_STATUS: 0x15,
};

// Status bits per ISO 14229-1 table. Meaningful for telling a stored fault
// apart from one that merely failed once this drive cycle.
export const DTC_STATUS_BITS = {
  TEST_FAILED: 0x01,
  TEST_FAILED_THIS_OPERATION_CYCLE: 0x02,
  PENDING_DTC: 0x04,
  CONFIRMED_DTC: 0x08,
  TEST_NOT_COMPLETED_SINCE_LAST_CLEAR: 0x10,
  TEST_FAILED_SINCE_LAST_CLEAR: 0x20,
  TEST_NOT_COMPLETED_THIS_OPERATION_CYCLE: 0x40,
  WARNING_INDICATOR_REQUESTED: 0x80,
};

// Negative response codes we must treat as "ask differently", not "no faults".
export const NRC = {
  SERVICE_NOT_SUPPORTED: 0x11,
  SUB_FUNCTION_NOT_SUPPORTED: 0x12,
  INCORRECT_MESSAGE_LENGTH: 0x13,
  CONDITIONS_NOT_CORRECT: 0x22,
  REQUEST_OUT_OF_RANGE: 0x31,
  SECURITY_ACCESS_DENIED: 0x33,
  RESPONSE_PENDING: 0x78,
};

// ── ECU addressing (ISO 15765-4) ─────────────────────────────────────────────

// 11-bit: functional broadcast 0x7DF; physical requests 0x7E0-0x7E7 with
// responses at request+8. Manufacturer modules live across 0x700-0x7FF.
export const FUNCTIONAL_11BIT = '7DF';
export const FUNCTIONAL_29BIT = '18DB33F1';

// The standard eight powertrain-ish addresses every compliant car answers on,
// plus the manufacturer-specific headers most commonly used for body/chassis
// modules (where thermostat/battery/charging faults actually live).
export const STANDARD_11BIT_REQUESTS = ['7E0', '7E1', '7E2', '7E3', '7E4', '7E5', '7E6', '7E7'];

export const EXTENDED_11BIT_REQUESTS = [
  '700', '720', '724', '730', '740', '750', '760', '770', '780', '7A0', '7B0', '7C0',
];

// 29-bit physical request format is 18DA<target>F1 (F1 = tester).
export const build29BitRequest = (target) =>
  `18DA${target.toString(16).toUpperCase().padStart(2, '0')}F1`;

// Human labels for the addresses people actually see. Anything unmapped is
// reported by raw address rather than guessed at.
export const ECU_NAMES = {
  '7E0': 'Двигун (ECM)',
  '7E1': 'Трансмісія (TCM)',
  '7E2': 'Модуль 7E2',
  '7E3': 'Модуль 7E3',
  '7E4': 'Модуль 7E4',
  '7E5': 'Модуль 7E5',
  '7E6': 'Модуль 7E6',
  '7E7': 'Модуль 7E7',
  '700': 'Кузовний модуль',
  '720': 'Панель приладів',
  '724': 'Клімат-контроль',
  '730': 'Модуль дверей',
  '740': 'ABS / гальма',
  '750': 'Подушки безпеки (SRS)',
  '760': 'Рульове керування',
  '770': 'Комфорт / доступ',
  '780': 'Модуль 780',
  '7A0': 'Модуль 7A0',
  '7B0': 'Модуль 7B0',
  '7C0': 'Модуль 7C0',
};

// ── Transport protocols (ELM327 ATSP/ATTP numbers) ───────────────────────────
// If auto-detect (ATSP0) fails we walk this ladder explicitly with ATTP. Order
// is "most likely first" for modern cars, so a healthy CAN vehicle still
// connects on the first try.
export const PROTOCOLS = [
  { id: '6', name: 'ISO 15765-4 CAN 11/500', bits: 11, can: true },
  { id: '7', name: 'ISO 15765-4 CAN 29/500', bits: 29, can: true },
  { id: '8', name: 'ISO 15765-4 CAN 11/250', bits: 11, can: true },
  { id: '9', name: 'ISO 15765-4 CAN 29/250', bits: 29, can: true },
  { id: '5', name: 'ISO 14230-4 KWP fast',   bits: null, can: false, kwp: true },
  { id: '4', name: 'ISO 14230-4 KWP 5-baud', bits: null, can: false, kwp: true },
  { id: '3', name: 'ISO 9141-2',             bits: null, can: false },
  { id: '1', name: 'SAE J1850 PWM',          bits: null, can: false, j1850: true },
  { id: '2', name: 'SAE J1850 VPW',          bits: null, can: false, j1850: true },
  { id: 'A', name: 'SAE J1939 CAN 29/250',   bits: 29, can: true, j1939: true },
];

export const protocolById = (id) =>
  PROTOCOLS.find((p) => p.id === String(id).toUpperCase().replace(/^A?/, (m) => m)) ||
  PROTOCOLS.find((p) => p.id === String(id).toUpperCase());

// ── KWP2000 (ISO 14230) DTC services ─────────────────────────────────────────
export const KWP_SERVICE = {
  READ_DTC: 0x13,               // readDiagnosticTroubleCodes
  READ_DTC_BY_STATUS: 0x18,     // readDiagnosticTroubleCodesByStatus
  READ_STATUS_OF_DTC: 0x17,     // readStatusOfDiagnosticTroubleCodes
};

// ── Response hygiene ─────────────────────────────────────────────────────────

/**
 * Normalise an adapter reply and reject anything that isn't usable payload.
 * This is the single choke point that keeps garbage out of the decoders:
 * command echoes, adapter status words, flow-control frames, pad bytes and
 * odd-length/non-hex data all die here rather than becoming fake DTCs.
 */
export function sanitizeResponse(raw, requestCmd = '') {
  if (!raw) return null;
  let s = String(raw).toUpperCase();

  // Adapter status words — never payload.
  if (/NO ?DATA|UNABLE|BUS ?(INIT|ERROR)|CAN ?ERROR|STOPPED|TIMEOUT|\?|ACT ?ALERT|BUFFER ?FULL|FB ?ERROR|DATA ?ERROR|RX ?ERROR/.test(s)) {
    return null;
  }
  // "SEARCHING..." can prefix a perfectly good reply — strip, don't reject.
  s = s.replace(/SEARCHING\.*/g, '');

  // Drop the echoed request if echo was left on.
  const echo = requestCmd.toUpperCase().replace(/\s/g, '');
  if (echo) s = s.replace(new RegExp('^\\s*' + echo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '');

  s = s.replace(/[\s\r\n>]/g, '');
  if (!s || !/^[0-9A-F]+$/.test(s)) return null;   // non-hex ⇒ not payload
  if (s.length % 2 !== 0) s = s.slice(0, -1);      // odd nibble ⇒ truncated
  if (s.length < 4) return null;
  if (/^(AA)+$/.test(s) || /^(FF)+$/.test(s) || /^0+$/.test(s)) return null; // pure padding
  return s;
}

/** A single ISO-TP flow-control frame carries no data — never parse it. */
export function isFlowControlOnly(hex) {
  return !!hex && /^3[0-2]/.test(hex);
}

// ── J1939 (commercial vehicles / Sprinter-class vans) ────────────────────────
// Faults here are SPN+FMI, not Pxxxx codes, so they need their own decoder.
// DM1 = active faults, DM2 = previously active. Layout per SAE J1939-73:
//   byte0..1  SPN low 16 bits
//   byte2     bits 7..5 = SPN high 3 bits, bits 4..0 = FMI
//   byte3     bit 7 = conversion method, bits 6..0 = occurrence count
export function decodeJ1939Dtcs(hex) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  if (clean.length < 12) return [];
  // First two bytes are lamp status, then 4-byte records.
  const data = clean.substring(4);
  const out = [];
  for (let i = 0; i + 8 <= data.length; i += 8) {
    const b = [0, 2, 4, 6].map((o) => parseInt(data.substr(i + o, 2), 16));
    if (b.some(isNaN)) continue;
    // All-zero and all-ones records are the documented "no fault" padding.
    if (b.every((x) => x === 0) || b.every((x) => x === 0xFF)) continue;

    const spn = b[0] | (b[1] << 8) | ((b[2] >> 5) << 16);
    const fmi = b[2] & 0x1F;
    const occurrence = b[3] & 0x7F;
    if (spn === 0 || spn === 0x7FFFF) continue;

    out.push({
      code: `SPN ${spn} FMI ${fmi}`,
      spn, fmi, occurrence,
      statusByte: null,
      status: null,
      isJ1939: true,
    });
  }
  return out;
}

/**
 * KWP2000 replies to 0x13/0x17/0x18. Positive response id is service+0x40
 * (0x53/0x57/0x58), then a count byte, then 3-byte records
 * (DTC high, DTC low, status).
 */
export function decodeKwpDtcResponse(hex, service) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  if (!clean) return [];
  const pos = (service + 0x40).toString(16).toUpperCase().padStart(2, '0');
  const idx = clean.indexOf(pos);
  if (idx === -1) return [];

  const data = clean.substring(idx + 4); // skip response id + count byte
  const out = [];
  for (let i = 0; i + 6 <= data.length; i += 6) {
    const chunk = data.substring(i, i + 6);
    if (/^0{6}$/.test(chunk) || /AAAA/.test(chunk) || /^F{6}$/.test(chunk)) continue;
    const a = parseInt(chunk.substring(0, 2), 16);
    const b = parseInt(chunk.substring(2, 4), 16);
    const st = parseInt(chunk.substring(4, 6), 16);
    if (isNaN(a) || isNaN(b)) continue;
    const code = decodeDtcBytes(a, b);
    if (!isStructurallyValidDtc(code)) continue;
    out.push({ code, statusByte: st, status: parseDtcStatusByte(st) });
  }
  return out;
}

/**
 * Format a DTC with its failure-type byte the way workshop tools show it
 * (P0128-00). FTB distinguishes e.g. "circuit low" from "circuit high" for the
 * same base code, so dropping it loses real diagnostic detail.
 */
export function formatDtcWithFtb(code, ftb) {
  if (ftb == null || isNaN(ftb)) return code;
  return `${code}-${ftb.toString(16).toUpperCase().padStart(2, '0')}`;
}

// ── Mode 01 PID 01: MIL state, confirmed-DTC count, readiness monitors ───────
// SAE J1979. Response: 41 01 A B C D
//   A  bit7    = MIL (check-engine lamp) commanded on
//   A  bits6-0 = number of confirmed emissions-related DTCs
//   B  bit3    = compression ignition (diesel) when set, else spark ignition
//   B  bits2-0 = misfire / fuel-system / components monitors SUPPORTED
//   B  bits6-4 = same three monitors INCOMPLETE
//   C  bits    = availability of the eight remaining monitors
//   D  bits    = incompleteness of those same eight
//
// This is the single most useful cross-check we have: if the ECU reports
// dtcCount > 0 while every read returns nothing, the faults are real but
// stored somewhere we haven't reached — which is very different from a car
// that genuinely has no faults. The old scanner could not tell those apart.
const CONTINUOUS_MONITORS = ['Пропуски запалювання', 'Паливна система', 'Компоненти'];
const NON_CONTINUOUS_MONITORS = [
  'Каталізатор', 'Підігрів каталізатора', 'Система вентиляції баку', 'Система вторинного повітря',
  'Кондиціонер', 'Кисневий датчик', 'Підігрів кисневого датчика', 'Система EGR',
];

export function decodeMilStatus(hex) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  const idx = clean.indexOf('4101');
  if (idx === -1) return null;
  const body = clean.substring(idx + 4);
  if (body.length < 8) return null;

  const A = parseInt(body.substring(0, 2), 16);
  const B = parseInt(body.substring(2, 4), 16);
  const C = parseInt(body.substring(4, 6), 16);
  const D = parseInt(body.substring(6, 8), 16);
  if ([A, B, C, D].some(isNaN)) return null;

  const monitors = [];
  CONTINUOUS_MONITORS.forEach((name, i) => {
    if (B & (1 << i)) monitors.push({ name, complete: !(B & (1 << (i + 4))) });
  });
  NON_CONTINUOUS_MONITORS.forEach((name, i) => {
    if (C & (1 << i)) monitors.push({ name, complete: !(D & (1 << i)) });
  });

  return {
    milOn: (A & 0x80) !== 0,
    dtcCount: A & 0x7F,
    compressionIgnition: (B & 0x08) !== 0,
    monitors,
  };
}

// ── Mode 02: the DTC that triggered freeze-frame storage ─────────────────────
// Request 0202 → response 42 02 [frame] <DTC hi> <DTC lo>. Some ECUs echo the
// frame number, some don't, so read the DTC off the end and let structural
// validation reject anything that isn't a real code.
export function decodeFreezeFrameDtc(hex) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  const idx = clean.indexOf('4202');
  if (idx === -1) return null;
  const body = clean.substring(idx + 4);
  if (body.length < 4) return null;

  for (const candidate of [body.substring(body.length - 4), body.substring(0, 4)]) {
    const a = parseInt(candidate.substring(0, 2), 16);
    const b = parseInt(candidate.substring(2, 4), 16);
    if (isNaN(a) || isNaN(b)) continue;
    // 0x0000 = no freeze frame stored; 0xFFFF = unwritten/padded memory. The
    // latter would otherwise decode to the plausible-looking "U3FFF".
    if ((a === 0 && b === 0) || (a === 0xFF && b === 0xFF)) continue;
    const code = decodeDtcBytes(a, b);
    if (isStructurallyValidDtc(code)) return code;
  }
  return null;
}

// ── UDS 0x19 0x01: number of DTCs matching a status mask ─────────────────────
// Response: 59 01 <availabilityMask> <formatIdentifier> <countHigh> <countLow>
// A per-module counterpart to Mode 01's count — tells us a module HAS faults
// even when reading the codes themselves fails.
export function decodeUdsDtcCount(hex) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  const idx = clean.indexOf('5901');
  if (idx === -1) return null;
  const body = clean.substring(idx + 4);
  if (body.length < 8) return null;
  const count = parseInt(body.substring(4, 8), 16);
  return isNaN(count) ? null : count;
}

// ── Mode 06: on-board monitor test results ───────────────────────────────────
// Response: 46 <MID> <TID> <UAS> <value hi/lo> <min hi/lo> <max hi/lo>
// A test whose value sits outside its own min/max is failing — often BEFORE it
// matures into a stored DTC. That makes this the one place a marginal
// thermostat or sensor shows up while Mode 03 is still clean.
//
// Deliberately NOT converting to physical units: that needs the full UAS
// scaling table, and a wrong scale would print confident nonsense. Pass/fail
// against the ECU's own limits is exact and needs no table.
export function decodeMode06Results(hex) {
  const clean = (hex || '').replace(/[^0-9A-F]/gi, '').toUpperCase();
  const idx = clean.indexOf('46');
  if (idx === -1) return [];
  const body = clean.substring(idx + 2);

  const out = [];
  for (let i = 0; i + 18 <= body.length; i += 18) {
    const rec = body.substring(i, i + 18);
    const mid = parseInt(rec.substring(0, 2), 16);
    const tid = parseInt(rec.substring(2, 4), 16);
    const uas = parseInt(rec.substring(4, 6), 16);
    const value = parseInt(rec.substring(6, 10), 16);
    const min = parseInt(rec.substring(10, 14), 16);
    const max = parseInt(rec.substring(14, 18), 16);
    if ([mid, tid, uas, value, min, max].some(isNaN)) continue;
    if (mid === 0 || mid === 0xFF) continue; // padding

    out.push({
      mid, tid, uas, value, min, max,
      passed: value >= min && value <= max,
    });
  }
  return out;
}

// ── Pure parsing helpers ─────────────────────────────────────────────────────

/** Decode a UDS status byte into named flags plus a coarse severity bucket. */
export function parseDtcStatusByte(byte) {
  if (byte == null || isNaN(byte)) return null;
  const has = (bit) => (byte & bit) !== 0;
  const confirmed = has(DTC_STATUS_BITS.CONFIRMED_DTC);
  const pending   = has(DTC_STATUS_BITS.PENDING_DTC);
  return {
    raw: byte,
    testFailed:            has(DTC_STATUS_BITS.TEST_FAILED),
    testFailedThisCycle:   has(DTC_STATUS_BITS.TEST_FAILED_THIS_OPERATION_CYCLE),
    pending,
    confirmed,
    testNotCompletedSinceClear: has(DTC_STATUS_BITS.TEST_NOT_COMPLETED_SINCE_LAST_CLEAR),
    testFailedSinceClear:  has(DTC_STATUS_BITS.TEST_FAILED_SINCE_LAST_CLEAR),
    testNotCompletedThisCycle: has(DTC_STATUS_BITS.TEST_NOT_COMPLETED_THIS_OPERATION_CYCLE),
    warningIndicator:      has(DTC_STATUS_BITS.WARNING_INDICATOR_REQUESTED),
    // Matches the categories the UI already renders.
    category: confirmed ? 'active' : pending ? 'pending' : 'historic',
  };
}

/** Encode a 2-byte legacy (Mode 03/07/0A) DTC pair as e.g. "P0128". */
export function decodeDtcBytes(byteA, byteB) {
  const LETTERS = ['P', 'C', 'B', 'U'];
  const letter = LETTERS[(byteA >> 6) & 0x03];
  const d1 = (byteA >> 4) & 0x03;
  const rest = ((byteA & 0x0F).toString(16) + byteB.toString(16).padStart(2, '0')).toUpperCase();
  return `${letter}${d1}${rest}`;
}

/**
 * Strip ELM327 line noise and, when headers are enabled, split a response into
 * per-ECU blocks keyed by the responding CAN id.
 *
 * With ATH1 an ISO-TP reply looks like:  "7E8 06 59 02 FF 01 28 00 08"
 * (possibly across several lines for multi-frame). Returns
 * { '7E8': 'hexpayload', ... } with ISO-TP framing bytes removed.
 */
export function splitByEcuHeader(raw) {
  if (!raw) return {};
  const out = {};
  for (const line of raw.split(/[\r\n]+/)) {
    const clean = line.replace(/[>\s]/g, '').toUpperCase();
    if (!clean || /^(OK|SEARCHING|BUS|STOPPED|NODATA|ERROR|UNABLE|CANERROR)/.test(clean)) continue;

    // 29-bit header is 8 hex chars, 11-bit is 3.
    let header = null, body = clean;
    if (/^18DA[0-9A-F]{4}/.test(clean)) { header = clean.substring(0, 8); body = clean.substring(8); }
    else if (/^[0-9A-F]{3}/.test(clean) && clean.length > 3) { header = clean.substring(0, 3); body = clean.substring(3); }
    if (!header) continue;

    // Drop the ISO-TP PCI. Single frame = 0X (X = length). First frame = 1XXX.
    // Consecutive frame = 2X — its payload continues the previous block.
    const pci = body.substring(0, 1);
    if (pci === '0')      body = body.substring(2);
    else if (pci === '1') body = body.substring(4);
    else if (pci === '2') body = body.substring(2);
    else if (pci === '3') continue; // flow control frame, carries no payload

    out[header] = (out[header] || '') + body;
  }
  return out;
}

/** True when a payload is a UDS negative response, with the NRC extracted. */
export function readNegativeResponse(hex) {
  const m = /7F([0-9A-F]{2})([0-9A-F]{2})/.exec(hex || '');
  if (!m) return null;
  return { service: parseInt(m[1], 16), nrc: parseInt(m[2], 16) };
}

/**
 * Decode a UDS 0x19 reply. Handles sub-functions that return 4-byte records
 * (3-byte DTC + status): 0x02, 0x0A, 0x0C, 0x0E, 0x0F, 0x13, 0x15.
 * Payload shape: 59 <subfn> <statusAvailabilityMask> [DTC(3) status(1)]...
 */
export function decodeUdsDtcResponse(hex, subFunction) {
  if (!hex) return [];
  const clean = hex.replace(/[^0-9A-F]/gi, '').toUpperCase();
  const prefix = '59' + subFunction.toString(16).toUpperCase().padStart(2, '0');
  const idx = clean.indexOf(prefix);
  if (idx === -1) return [];

  // Skip "59 <subfn> <availability mask>" = 6 hex chars.
  const data = clean.substring(idx + 6);
  const out = [];
  for (let i = 0; i + 8 <= data.length; i += 8) {
    const chunk = data.substring(i, i + 8);
    if (/^0{6}/.test(chunk) || /AAAA/.test(chunk) || /^FFFFFF/.test(chunk)) continue;

    const byteA = parseInt(chunk.substring(0, 2), 16);
    const byteB = parseInt(chunk.substring(2, 4), 16);
    const ftb   = parseInt(chunk.substring(4, 6), 16); // failure type byte
    const status = parseInt(chunk.substring(6, 8), 16);
    if (isNaN(byteA) || isNaN(byteB)) continue;

    const code = decodeDtcBytes(byteA, byteB);
    if (!isStructurallyValidDtc(code)) continue;
    out.push({ code, ftb, statusByte: status, status: parseDtcStatusByte(status) });
  }
  return out;
}

/** Decode a legacy Mode 03/07/0A reply ("43 <count> <dtc pairs...>"). */
export function decodeLegacyDtcResponse(hex, mode) {
  if (!hex) return [];
  const clean = hex.replace(/[^0-9A-F]/gi, '').toUpperCase();
  const expected = (0x40 + parseInt(mode, 16)).toString(16).toUpperCase().padStart(2, '0');
  const idx = clean.indexOf(expected);
  if (idx === -1) return [];

  // Mode 03/07/0A responses carry a DTC count byte before the pairs on CAN.
  let data = clean.substring(idx + 2);
  if (data.length >= 2) data = data.substring(2); // drop count byte

  const out = [];
  for (let i = 0; i + 4 <= data.length; i += 4) {
    const chunk = data.substring(i, i + 4);
    if (chunk === '0000' || /AAAA/.test(chunk)) continue;
    const byteA = parseInt(chunk.substring(0, 2), 16);
    const byteB = parseInt(chunk.substring(2, 4), 16);
    if (isNaN(byteA) || isNaN(byteB)) continue;
    const code = decodeDtcBytes(byteA, byteB);
    if (!isStructurallyValidDtc(code)) continue;
    out.push({ code, statusByte: null, status: null });
  }
  return out;
}

// Padding/ghost artefacts that are never real faults.
const GHOST_CODES = new Set(['P0000', 'C0000', 'B0000', 'U0000', 'C0300', 'C0700', 'C0A00']);

export function isStructurallyValidDtc(code) {
  if (!code || GHOST_CODES.has(code)) return false;
  if (!/^[PCBU][0-3][0-9A-F]{3}$/.test(code)) return false;
  const n = code.substring(1);
  return n !== '0000' && n !== 'FFFF';
}

/** Which ECUs answered a functional broadcast, from the headers in the reply. */
export function extractRespondingEcus(raw) {
  const blocks = splitByEcuHeader(raw);
  return Object.keys(blocks).map((responseAddr) => {
    // 11-bit convention: response = request + 8 (7E8 → 7E0).
    if (/^7E[89A-F]$/.test(responseAddr)) {
      const req = (parseInt(responseAddr, 16) - 8).toString(16).toUpperCase();
      return { request: req, response: responseAddr };
    }
    if (/^18DAF1[0-9A-F]{2}$/.test(responseAddr)) {
      const target = responseAddr.substring(6, 8);
      return { request: `18DA${target}F1`, response: responseAddr };
    }
    return { request: responseAddr, response: responseAddr };
  });
}
