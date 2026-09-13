/**
 * End-to-end: real captured bytes → DtcScanRunner → normalizeScanCodes →
 * the exact objects the UI renders.
 *
 * Run: node src/obd/__tests__/endToEnd.test.mjs   (from mobile_app/)
 *
 * The other suites prove the decoders are right. This one exists to answer a
 * different question: will the phone show what the test run shows? It drives
 * the real runner and the real normalizer — the same two modules the app calls
 * — and asserts on the finished error objects, including the statusCategory
 * that DashboardPage/DiagnosticsPage bucket on.
 *
 * The fixture is the Mercedes that reported ~145 codes with one real fault.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DtcScanRunner } from '../dtcScanRunner.js';
import { normalizeScanCodes } from '../normalizeScanCodes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'mercedes_2026-09-10.json'), 'utf-8'));
const DICT = JSON.parse(readFileSync(join(__dirname, '..', 'codes.json'), 'utf-8'));

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ── A replay "car": answers only what the real adapter answered ─────────────
const KNOWN = ['7E0', '7E1', '7E3'];
const RESP = { '7E0': '7E8', '7E1': '7E9', '7E3': '7EB' };
let hdr = '7DF';
const sent = [];

function send(raw) {
  const cmd = raw.trim().toUpperCase();
  sent.push(cmd);
  if (/^ATSH/.test(cmd)) { hdr = cmd.slice(4); return 'OK'; }
  if (cmd === 'ATDPN') return '6';
  if (/^AT/.test(cmd)) return 'OK';
  if (cmd === '0100') {
    if (hdr === '7DF') return KNOWN.map(h => `${RESP[h]} 06 4100BE3FA813`).join('\r');
    return KNOWN.includes(hdr) ? `${RESP[hdr]} 06 4100BE3FA813` : 'NO DATA';
  }
  if (cmd === '3E00') return KNOWN.includes(hdr) ? `${RESP[hdr]} 02 7E00` : 'NO DATA';
  if (cmd === '1003') return KNOWN.includes(hdr) ? `${RESP[hdr]} 02 5003` : 'NO DATA';
  const hit = FIX[`${hdr}|${cmd}`];
  return hit ? hit[0] : 'NO DATA';
}

const result = await new DtcScanRunner((c) => Promise.resolve(send(c)), { deepScan: true }).scan(DICT);
const errors = normalizeScanCodes(result.codes, DICT, result.variant);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] What the driver sees\n');

check('exactly 2 errors reach the UI, not ~145', errors.length === 2,
  `got ${errors.length}: ${errors.map(e => e.code).join(', ')}`);

const thermostat = errors.find(e => e.code.startsWith('P0597'));
const fuelPump = errors.find(e => e.code.startsWith('U0109'));

check('the thermostat fault is present', !!thermostat, errors.map(e => e.code).join(', '));
check('thermostat is ACTIVE — the red bucket', thermostat?.statusCategory === 'active',
  thermostat?.statusCategory);
check('thermostat carries its real title, not "Код виробника"',
  thermostat?.title?.includes('Thermostat') && thermostat.isManufacturerCode === false,
  thermostat?.title);
check('thermostat is attributed to the engine module',
  thermostat?.ecuAddress === '7E0' && !!thermostat?.ecu, `${thermostat?.ecu} / ${thermostat?.ecuAddress}`);

check('U0109 is present but ARCHIVED, not shown as a live fault',
  fuelPump?.statusCategory === 'historic', fuelPump?.statusCategory);
check('U0109 resolves from the dictionary too',
  fuelPump?.title?.includes('Fuel Pump'), fuelPump?.title);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] The buckets the pages actually filter on\n');

// Mirrors DashboardPage.jsx / DiagnosticsPage.jsx.
const activeErrors = errors.filter(e => (e.statusCategory || 'active') === 'active');
const pendingErrors = errors.filter(e => e.statusCategory === 'pending');
const archiveErrors = errors.filter(e => e.statusCategory === 'historic');

check('1 active fault on the dashboard', activeErrors.length === 1,
  activeErrors.map(e => e.code).join(', '));
check('0 pending — that bucket is retired', pendingErrors.length === 0,
  pendingErrors.map(e => e.code).join(', '));
check('1 archived code', archiveErrors.length === 1, archiveErrors.map(e => e.code).join(', '));
check('every error lands in a bucket the UI can style',
  errors.every(e => ['active', 'pending', 'historic'].includes(e.statusCategory)));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] None of the phantom codes survive the full pipeline\n');

const PHANTOMS = ['C07E8', 'P07E8', 'B07EB', 'C247E', 'C37EB', 'U17E8', 'B0212', 'C3002', 'U2000'];
for (const p of PHANTOMS) {
  check(`${p} is not shown to the driver`, !errors.some(e => e.code.startsWith(p)));
}
check('no error is an unnamed manufacturer code in this scan',
  errors.every(e => e.isManufacturerCode === false),
  errors.filter(e => e.isManufacturerCode).map(e => e.code).join(', '));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] The scan asked only failure-indicating questions\n');

const dtcQueries = sent.filter(c => /^19/.test(c));
check('never requested status mask FF (the ECU catalogue)',
  !dtcQueries.some(c => c.startsWith('1902FF')), dtcQueries.filter(c => c.startsWith('1902FF')).join(','));
check('never requested supported-DTC (190A)',
  !dtcQueries.some(c => c.startsWith('190A')));
check('never requested mirror memory (190F)',
  !dtcQueries.some(c => c.startsWith('190F')));
check('did ask for confirmed (190208) and pending (190204)',
  dtcQueries.some(c => c.startsWith('190208')) && dtcQueries.some(c => c.startsWith('190204')));
check('interrogated all three modules present on the bus', result.ecus.length === 3,
  result.ecus.map(e => e.request).join(','));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] A clean car must still come back clean\n');

const cleanErrors = normalizeScanCodes([], DICT, 'test');
check('no faults in, no faults out — nothing fabricated', cleanErrors.length === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
