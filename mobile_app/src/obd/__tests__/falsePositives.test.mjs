/**
 * False-positive regression test — built from a REAL capture.
 *
 * Run: node src/obd/__tests__/falsePositives.test.mjs   (from mobile_app/)
 *
 * Background: a scan of Тимур's Mercedes reported ~145 trouble codes when the
 * car had exactly ONE real fault (P0597, thermostat). fixtures/ holds the
 * actual command/response pairs from that session (claude/logs.txt,
 * 2026-09-10), so this pins the behaviour against the bytes that caused it.
 *
 * Two independent bugs produced the flood:
 *
 *  1. Multi-frame replies were not reassembled. A real reply arrives as ONE
 *     unbroken string — "7E8119F5902FF008792" + "7E821401CE365401CE4" + ... —
 *     and only the leading PCI was stripped, so every embedded "7E821"/"7E822"
 *     was decoded as DTC bytes. That is literally where C07E8 / P07E8 / B07EB /
 *     C247E came from: CAN ids plus frame counters.
 *
 *  2. Status-mask 0xFF (and sub-function 0x0A "supported") ask the ECU to list
 *     every code it KNOWS ABOUT, not every code currently set — 0xFF matches
 *     TEST_NOT_COMPLETED, which is true for almost all of them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  splitByEcuHeader,
  decodeUdsDtcResponse,
  isReportableFault,
  isActiveFault,
  parseDtcStatusByte,
} from '../dtcScanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'mercedes_2026-09-10.json'), 'utf-8'),
);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// Mirrors what the runner now asks for: failure-indicating masks only.
const FAULT_QUERIES = { '190208': 0x02, '190204': 0x02, '190201': 0x02, '19022F': 0x02, '1915': 0x15 };
// What it used to ask for, and must never ask for again.
const CATALOGUE_QUERIES = { '1902FF': 0x02, '190A': 0x0A, '190FFF': 0x0F, '190E': 0x0E };

function decodeAll(queries, { gate = true } = {}) {
  const found = new Map();
  for (const [key, list] of Object.entries(FIX)) {
    const [, cmd] = key.split('|');
    const sub = queries[cmd];
    if (sub === undefined) continue;
    for (const payload of Object.values(splitByEcuHeader(list[0]))) {
      for (const d of decodeUdsDtcResponse(payload, sub)) {
        if (gate && !isReportableFault(d.statusByte)) continue;
        if (!found.has(d.code)) found.set(d.code, d);
      }
    }
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Multi-frame reassembly — the source of the phantom codes\n');

const blob = FIX['7E0|1902FF'][0];
const blocks = splitByEcuHeader(blob);
const payload = blocks['7E8'];

check('a concatenated multi-frame reply yields exactly one ECU block',
  Object.keys(blocks).length === 1 && !!payload, Object.keys(blocks).join(','));
check('reassembled payload starts at the service response (5902FF)',
  payload?.startsWith('5902FF'), payload?.slice(0, 12));
check('payload length matches the length the First Frame declared (0x19F = 415 bytes)',
  payload?.length === 0x19F * 2, `${payload?.length / 2} bytes`);
check('no CAN id survives inside the reassembled payload (7E8 stripped)',
  !payload?.includes('7E82'), 'found embedded frame headers');

// The exact fakes the user saw, all of them frame headers misread as DTC bytes.
const PHANTOMS = ['C07E8', 'P07E8', 'B07EB', 'C247E', 'C37EB', 'U17E8', 'C387E', 'P37E8'];
const fromFaultQueries = decodeAll(FAULT_QUERIES);
for (const p of PHANTOMS) {
  check(`phantom code ${p} (a CAN id, not a fault) is gone`, !fromFaultQueries.has(p));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] The real fault survives, the catalogue does not\n');

check('P0597 (thermostat) IS found — the one genuine fault',
  fromFaultQueries.has('P0597'), [...fromFaultQueries.keys()].join(','));
check('P0597 is classified as actively failing (status 0x27)',
  isActiveFault(fromFaultQueries.get('P0597')?.statusByte) &&
  fromFaultQueries.get('P0597')?.statusByte === 0x27,
  `status=0x${fromFaultQueries.get('P0597')?.statusByte?.toString(16)}`);

const active = [...fromFaultQueries.values()].filter(d => isActiveFault(d.statusByte));
check('exactly ONE actively-failing code, not ~145',
  active.length === 1, `got ${active.length}: ${active.map(d => d.code).join(',')}`);
check('total reportable codes stays in single digits',
  fromFaultQueries.size <= 3, `got ${fromFaultQueries.size}`);

// U0109 genuinely failed at some point since the last clear (status 0x20) but
// is not currently failing — reportable as history, never as an active alarm.
const u0109 = fromFaultQueries.get('U0109');
if (u0109) {
  check('U0109 is reported as historic, not active (status 0x20)',
    !isActiveFault(u0109.statusByte) && parseDtcStatusByte(u0109.statusByte).category === 'historic',
    `status=0x${u0109.statusByte.toString(16)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Why the catalogue queries had to go\n');

const fromCatalogue = decodeAll(CATALOGUE_QUERIES, { gate: false });
check('the old query set still decodes a flood from this same car (proving the cause)',
  fromCatalogue.size > 100, `got ${fromCatalogue.size}`);
check('...and the status gate alone would NOT have saved us',
  [...fromCatalogue.values()].filter(d => isReportableFault(d.statusByte)).length > 20,
  'gate alone was insufficient — the queries themselves were wrong');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Status gate semantics\n');

check('0x27 (failed + pending + since-clear) is an active fault', isActiveFault(0x27));
check('0x08 (confirmed) is an active fault', isActiveFault(0x08));
check('0x04 (pending) is an active fault', isActiveFault(0x04));
check('0x50 (not-completed bits only) is NOT a fault', !isReportableFault(0x50));
check('0x00 is NOT a fault', !isReportableFault(0x00));
check('0x20 (failed since clear) is reportable but NOT active',
  isReportableFault(0x20) && !isActiveFault(0x20));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] The scanner must not ask for catalogue data again\n');

const runnerSrc = readFileSync(join(__dirname, '..', 'dtcScanRunner.js'), 'utf-8');
const subBlock = runnerSrc.slice(
  runnerSrc.indexOf('const subFunctions = ['),
  runnerSrc.indexOf('];', runnerSrc.indexOf('const subFunctions = [')),
);

check('sub-function list no longer requests mask FF',
  !/mask:\s*'FF'/.test(subBlock), subBlock.match(/mask:\s*'FF'/g)?.join(','));
check('sub-function list no longer requests SUPPORTED_DTC (190A)',
  !subBlock.includes('SUPPORTED_DTC'));
check('sub-function list no longer requests MOST_RECENT_CONFIRMED_DTC (190E)',
  !subBlock.includes('MOST_RECENT_CONFIRMED_DTC'));
check('sub-function list still requests confirmed (0x08) and pending (0x04)',
  subBlock.includes("mask: '08'") && subBlock.includes("mask: '04'"));
check('the status gate is actually applied when collecting UDS records',
  /isReportableFault\(d\.statusByte\)/.test(runnerSrc));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
