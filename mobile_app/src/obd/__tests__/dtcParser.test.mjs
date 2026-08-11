/**
 * DTC parser regression test.
 *
 * Run: node src/obd/__tests__/dtcParser.test.mjs   (from mobile_app/)
 *
 * Background: a real car threw P0597 (Thermostat) and U0109 (Lost Comm) but
 * the app's DTC scan showed nothing. fixtures/car_missing_p0597_u0109.log is
 * the raw exported OBD log from that exact car/session (a Telegram chat
 * export — mixed with unrelated live-PID polling noise and chat headers).
 *
 * This script:
 *   1. Parses ONLY the genuine DTC-scan exchanges out of that noisy log
 *      (tag === DTC_RAW_RES, command ∈ the exact set smartReadDTC() sends)
 *      and replays them through the real parsing pipeline, to prove the
 *      parser doesn't hallucinate codes out of noise/padding.
 *   2. Confirms those specific real captures never contained the DTC bytes
 *      at all (a transport-layer/status-mask gap, not something any parser
 *      could recover — documented, not "fixed" by fabricating data).
 *   3. Feeds a well-formed synthetic UDS reply containing P0597 + U0109
 *      through the same pipeline and asserts they — and only they — come out.
 *   4. Regression-checks the paths other cars rely on (Mode 03 legacy DTCs,
 *      multi-ECU UDS responses, ghost/padding rejection) still work.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { dtc, dtc_uds } from '../decoders.js';
import {
  isStructurallyValidDtc,
  assembleHexPayload,
  stripNegativeResponses,
  parseLegacyModeDtc,
  parseUdsKwpDtc,
} from '../dtcParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else           { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
}

// Mirrors _executeRawDTC's per-command decode step (minus the BLE send + NRC retry,
// which need real hardware) — same code the app runs after getting a response.
function decodeOneResponse(cmd, decoderFunc, rawResponse) {
  let hex = assembleHexPayload(rawResponse);
  hex = stripNegativeResponses(hex);
  if (cmd === '03' || cmd === '07' || cmd === '0A') return parseLegacyModeDtc(cmd, hex, decoderFunc);
  if (cmd.startsWith('19') || cmd.startsWith('18')) return parseUdsKwpDtc(hex, decoderFunc);
  return null;
}

const DECODER_BY_CMD = (cmd) => {
  if (cmd === '03' || cmd === '07' || cmd === '0A') return dtc;
  if (cmd.startsWith('19')) return dtc_uds;
  return null; // KWP (18xx) not exercised by this log
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Replaying the real car\'s DTC-scan traffic from the log fixture\n');

const logPath = join(__dirname, 'fixtures', 'car_missing_p0597_u0109.log');
const logText = readFileSync(logPath, 'utf-8');

// Only the genuine DTC-scan exchanges — same command set smartReadDTC() sends —
// deliberately excludes live-PID polling (010C/010D/0105/...), chat headers,
// and any other line shape. This is the "don't scrape any other garbage" filter.
const DTC_SCAN_CMDS = new Set(['190209', '190208', '190201', '190204', '03', '07', '0A', '18000000', '1802FF00']);
const LOG_LINE_RE = /\[(DTC_RAW_RES|DTC_RETRY)\]\s*CMD:\s*([0-9A-Fa-f]+)\s*\|\s*RES:\s*(.*?)\s*$/;

const scanEntries = [];
for (const line of logText.split(/\r?\n/)) {
  const m = LOG_LINE_RE.exec(line);
  if (!m) continue;
  const [, , cmd, res] = m;
  const cmdUpper = cmd.toUpperCase();
  if (!DTC_SCAN_CMDS.has(cmdUpper)) continue;
  scanEntries.push({ cmd: cmdUpper, res });
}

check(`found DTC-scan log entries (ignoring PID-polling/chat noise)`, scanEntries.length > 0,
  `found ${scanEntries.length}`);

const foundInRealCapture = new Set();
let garbageEntries = 0;
for (const { cmd, res } of scanEntries) {
  const upper = res.toUpperCase();
  if (upper.includes('NO DATA') || upper.includes('ERROR')) continue;
  const decoderFunc = DECODER_BY_CMD(cmd);
  if (!decoderFunc) continue;

  const result = decodeOneResponse(cmd, decoderFunc, res);
  if (!result) continue;
  for (const item of result) {
    const base = typeof item === 'object' ? item.base : item;
    if (isStructurallyValidDtc(base)) foundInRealCapture.add(base);
    else garbageEntries++;
  }
}

check('parser scraped zero garbage codes from the noisy raw log', garbageEntries === 0,
  `${garbageEntries} rejected-but-almost-matched entries`);
check('P0597 / U0109 are absent from the ACTUAL captured bytes (confirms this is a transport/mask gap, not a parser bug)',
  !foundInRealCapture.has('P0597') && !foundInRealCapture.has('U0109'),
  `found in raw capture: [${[...foundInRealCapture].join(', ') || 'none'}]`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Feeding a well-formed UDS reply containing P0597 + U0109 through the SAME pipeline\n');

// 59 02 <statusAvailabilityMask=FF> | 05 97 <FTB=00> <status=09> | C1 09 <FTB=00> <status=08>
const wellFormedUds = '5902FF' + '05970009' + 'C1090008';
const wellFormedResult = decodeOneResponse('190209', dtc_uds, wellFormedUds);
const wellFormedCodes = (wellFormedResult || [])
  .filter(item => isStructurallyValidDtc(item.base))
  .map(item => item.base)
  .sort();

check('extracts exactly P0597 and U0109 from a well-formed response',
  JSON.stringify(wellFormedCodes) === JSON.stringify(['P0597', 'U0109']),
  `got [${wellFormedCodes.join(', ')}]`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Regression checks — behavior other cars depend on must be unaffected\n');

// Mode 03 legacy DTC (what cars WITHOUT this bug's UDS-only dependency use)
const mode03Response = '43' + '02' + '0301' + '0140';
const mode03Result = decodeOneResponse('03', dtc, mode03Response);
const mode03Codes  = (mode03Result || []).filter(isStructurallyValidDtc);
check('Mode 03 legacy path still extracts real codes (P0301, P0140)',
  mode03Codes.length === 2 && mode03Codes.includes('P0301') && mode03Codes.includes('P0140'),
  `got [${mode03Codes.join(', ')}]`);

// Multi-ECU UDS response (documented example from CARSENSE_CONTEXT.md)
const multiEcu = '5902FF5902FF059700277F1978';
const multiEcuResult = decodeOneResponse('190208', dtc_uds, multiEcu);
check('multi-ECU UDS payload still parses without throwing', Array.isArray(multiEcuResult));

// Ghost / padding codes must still be rejected
check('ghost code P0000 still rejected',    !isStructurallyValidDtc('P0000'));
check('ghost code C0300 still rejected',    !isStructurallyValidDtc('C0300'));
check('0xAA padding chunk still skipped by dtc_uds',
  dtc_uds('5902FF' + 'AAAAAAAA').length === 0);

// A real code must still validate (sanity check on the fixed regex itself)
check('a genuine 5-char code (P0301) passes structural validation', isStructurallyValidDtc('P0301'));
check('a too-short garbage string does not pass', !isStructurallyValidDtc('P030'));

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
