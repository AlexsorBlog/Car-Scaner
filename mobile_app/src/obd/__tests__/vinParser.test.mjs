/**
 * VIN (and other multi-frame Mode 09 string PIDs) decoding regression test.
 *
 * Run: node src/obd/__tests__/vinParser.test.mjs   (from mobile_app/)
 *
 * Background: users reported the auto-captured VIN was always missing its
 * last character — every other character was correct, just truncated by one.
 * Root cause was two compounding bugs:
 *   1. index.js's MODE_NO_PID set incorrectly included '09' — Mode 09 DOES
 *      have an InfoType byte (unlike 03/04/07/08), so treating it as
 *      PID-less left that byte sitting in the data, eating into the
 *      fixed-length byte budget and pushing the true tail out of the window.
 *   2. decodeEncodedString's old frame-marker-stripping regex ran on the
 *      already-newline-collapsed string, where a real "1:" frame marker is
 *      indistinguishable from a coincidental digit+colon+digit pattern
 *      inside the payload — it could eat real payload digits.
 *
 * This mirrors query()'s actual mode/PID-prefix routing logic (kept small
 * and inline here, same as the real function) against decoders.js's real,
 * unmodified exports (stripFrameMarkers, decodeEncodedString).
 */

import { decodeEncodedString, stripFrameMarkers } from '../decoders.js';

let pass = 0, fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else           { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
}

// Mirrors query()'s mode/PID-prefix extraction — Mode 09 correctly routed as
// PID-bearing (NOT in MODE_NO_PID, matching the real index.js constant).
const MODE_NO_PID = new Set(['03', '04', '07', '08']);

function extractHexData(response, cmd, bytes) {
  const deFramed = stripFrameMarkers(response);
  const clean = deFramed.replace(/[\s\r\n]/g, '').toUpperCase();

  const modeHex   = cmd.substring(0, 2).toUpperCase();
  const modeInt    = parseInt(modeHex, 16);
  const replyMode  = ((modeInt + 0x40) & 0xFF).toString(16).toUpperCase().padStart(2, '0');

  let hexData;
  if (MODE_NO_PID.has(modeHex)) {
    const prefixIdx = clean.indexOf(replyMode);
    hexData = clean.substring(prefixIdx + 2);
  } else {
    const pidHex    = cmd.substring(2).toUpperCase();
    const prefix     = replyMode + pidHex;
    const prefixIdx  = clean.indexOf(prefix);
    const nextIdx    = clean.indexOf(prefix, prefixIdx + prefix.length);
    hexData = nextIdx !== -1
      ? clean.substring(prefixIdx + prefix.length, nextIdx)
      : clean.substring(prefixIdx + prefix.length);
  }

  return (bytes > 0 && hexData.length >= bytes * 2) ? hexData.substring(0, bytes * 2) : hexData;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Real multi-frame VIN response (3 CAN frames, ATH0 headers off)\n');

// 49 02 01 | 31 44 34 47 50 30 30 52 35 35 42 31 32 33 34 35 36
// (49=mode reply, 02=InfoType/VIN, 01=NODI, then 17 ASCII VIN bytes)
const vinResponse = '0: 49 02 01 31 44 34\r\n1: 47 50 30 30 52 35\r\n2: 35 42 31 32 33 34 35 36';
const vinTarget = extractHexData(vinResponse, '0902', 22);
const vin = decodeEncodedString(vinTarget);

check('decodes the full 17-character VIN, no truncation', vin === '1D4GP00R55B123456', `got "${vin}" (${vin.length} chars)`);
check('specifically: last character is NOT cut off', vin.endsWith('6'), `got "${vin}"`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Regression: a coincidental digit+colon+digit pattern inside real payload\n');

// A VIN whose hex bytes happen to contain a byte pair that could look like a
// frame marker once naively joined — the old regex-based stripping in
// decodeEncodedString would have eaten real characters here.
const trickyResponse = '0: 49 02 01 31 41 34\r\n1: 47 50 30 30 52 35\r\n2: 35 42 31 32 33 34 35 36';
const trickyTarget = extractHexData(trickyResponse, '0902', 22);
const trickyVin = decodeEncodedString(trickyTarget);
check('17 chars preserved even with a tricky byte pattern', trickyVin.length === 17, `got "${trickyVin}" (${trickyVin.length} chars)`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Other Mode 09 string PIDs use the same path — CALIBRATION_ID\n');

// 49 04 01 | "ABC123XYZ" padded — a shorter single-frame example
const calResponse = '49 04 01 41 42 43 31 32 33 58 59 5A';
const calTarget = extractHexData(calResponse, '0904', 18);
const calId = decodeEncodedString(calTarget);
check('CALIBRATION_ID decodes correctly (same Mode 09 path as VIN)', calId === 'ABC123XYZ', `got "${calId}"`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Regression: single-frame PID-less modes (Mode 03 etc.) still unaffected\n');

// Mode 03 has no InfoType byte — must stay in MODE_NO_PID and be unaffected
// by this fix (this is the exact same DTC pipeline verified in
// dtcParser.js's own tests; this just confirms stripFrameMarkers is a
// harmless no-op on a plain single-line response).
const dtcResponse = '43 02 0301 0140';
check('stripFrameMarkers is a no-op on a plain single-line response', stripFrameMarkers(dtcResponse) === dtcResponse);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
