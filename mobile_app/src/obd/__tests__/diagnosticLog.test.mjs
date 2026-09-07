/**
 * Diagnostic-log + replay round-trip test.
 *
 * Run: node src/obd/__tests__/diagnosticLog.test.mjs   (from mobile_app/)
 *
 * The point of the structured log is that a real scan can be turned back into a
 * runnable test. This proves that round trip: scan a simulated car, export the
 * session as a fixture, replay the fixture through a fresh scanner, and get
 * byte-identical results without the original car being present.
 *
 * Once that holds, any log captured from a real vehicle can be dropped into
 * this suite and becomes a permanent regression test for that car.
 */

import { DiagnosticLog, makeReplayCar } from '../diagnosticLog.js';
import { DtcScanRunner } from '../dtcScanRunner.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ── A car with a fault in a non-engine module, as before ─────────────────────
function simulatedCar() {
  const state = { header: '7DF', session: {} };
  const FAULTS = { '700': '5902FF05620029' };
  return (cmdRaw) => {
    const cmd = String(cmdRaw).trim().toUpperCase();
    if (cmd === 'ATZ') return Promise.resolve('ELM327 v2.3');
    if (cmd === 'ATDPN') return Promise.resolve('6');
    if (/^ATSH/.test(cmd)) { state.header = cmd.substring(4); return Promise.resolve('OK'); }
    if (/^AT/.test(cmd)) return Promise.resolve('OK');
    const h = state.header;
    if (cmd === '0100') return Promise.resolve('7E8 06 41 00 BE 3F A8 13');
    if (cmd === '0101') return Promise.resolve('7E8 06 41 01 81 07 00 00'); // MIL on, 1 DTC
    if (cmd === '3E00') return Promise.resolve(['7E0', '700'].includes(h) ? '7E8 02 7E 00' : 'NO DATA');
    if (cmd === '1003') { state.session[h] = true; return Promise.resolve('7E8 02 50 03'); }
    if (/^0(3|7|A)$/.test(cmd)) return Promise.resolve('7E8 02 43 00');
    if (/^19/.test(cmd)) {
      if (!state.session[h]) return Promise.resolve('7E8 03 7F 19 22');
      if (FAULTS[h] && cmd.startsWith('1902')) return Promise.resolve(`708 06 ${FAULTS[h]}`);
      return Promise.resolve('7E8 03 7F 19 31');
    }
    return Promise.resolve('NO DATA');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The log captures state the old one threw away\n');

const log = new DiagnosticLog();
const runner = new DtcScanRunner(simulatedCar(), { deepScan: true, diagnosticLog: log });
const original = await runner.scan({ P0562: 'Низька напруга бортової мережі' });

check('records every command sent', log.entries.length > 20, `${log.entries.length} entries`);
check('keeps the raw response verbatim, not a summary',
  log.entries.some((e) => e.raw.includes('7E8 06 41 00')),
  log.entries.find((e) => e.cmd === '0100')?.raw);

// This is the bit the old log could not express: the SAME command, sent to two
// different modules, with different answers.
const udsEntries = log.entries.filter((e) => e.cmd.startsWith('1902'));
const headersForUds = [...new Set(udsEntries.map((e) => e.header))];
check('attributes each command to the ECU header active at the time',
  headersForUds.length > 1, `headers: ${headersForUds.join(', ')}`);
check('a bare "03" is no longer ambiguous — its header is recorded',
  log.entries.filter((e) => e.cmd === '03').every((e) => e.header != null));
check('records per-command timing', log.entries.every((e) => typeof e.ms === 'number'));
check('tracks the negotiated protocol', log.stats().protocol === '6', log.stats().protocol);
check('tracks which UDS session a module was in',
  log.entries.some((e) => e.cmd.startsWith('1902') && e.session === '3'));
check('marks unusable replies as rejected rather than silently dropping them',
  log.stats().byOutcome.rejected > 0, JSON.stringify(log.stats().byOutcome));
check('annotates NRC rejections with their plain-language meaning',
  log.notes.some((n) => /conditionsNotCorrect|requestOutOfRange/.test(JSON.stringify(n.data))),
  JSON.stringify(log.notes.slice(0, 3)));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Human-readable transcript\n');

const text = log.toText();
check('transcript includes a session header with protocol + counts',
  /OBD diagnostic session/.test(text) && /protocol/.test(text));
check('transcript shows header, command and raw bytes on every row',
  /7E0\s+03\s/.test(text) && /→ 7E8 02 43 00/.test(text));
check('transcript preserves carriage returns as escapes rather than mangling rows',
  !/\r/.test(text));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Round trip — a captured session becomes a runnable test\n');

const fixture = log.toReplayFixture({ car: 'Mercedes (simulated)', vin: 'TEST' });
check('fixture records the protocol', fixture.protocol === '6');
check('fixture keys responses by header + command',
  Object.keys(fixture.responses).some((k) => /^700\|1902/.test(k)),
  Object.keys(fixture.responses).filter(k => k.includes('1902')).join(' '));
check('fixture carries caller-supplied metadata', fixture.meta.car.includes('Mercedes'));
check('fixture is JSON-serialisable (so it can be committed as a test)',
  typeof JSON.parse(JSON.stringify(fixture)) === 'object');

// Replay it against a brand-new scanner with NO access to the original car.
let misses = 0;
const replayed = await new DtcScanRunner(
  makeReplayCar(fixture, { onMiss: () => misses++ }),
  { deepScan: true },
).scan({ P0562: 'Низька напруга бортової мережі' });

check('replay finds the same codes as the live scan',
  JSON.stringify(replayed.codes.map((c) => c.base).sort()) ===
  JSON.stringify(original.codes.map((c) => c.base).sort()),
  `live=[${original.codes.map(c => c.base)}] replay=[${replayed.codes.map(c => c.base)}]`);
check('replay attributes codes to the same modules',
  JSON.stringify(replayed.codes.map((c) => c.ecuAddress).sort()) ===
  JSON.stringify(original.codes.map((c) => c.ecuAddress).sort()));
check('replay reproduces the MIL state', replayed.milOn === original.milOn);
check('replay reproduces the unread-code cross-check',
  replayed.unreadDtcCount === original.unreadDtcCount,
  `live=${original.unreadDtcCount} replay=${replayed.unreadDtcCount}`);
check('replay needed no commands that were not captured', misses === 0, `${misses} misses`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Replay robustness\n');

const tiny = { version: 1, responses: { '-|0100': ['7E8 06 41 00 BE 3F A8 13'] } };
let missed = [];
const car = makeReplayCar(tiny, { onMiss: (c) => missed.push(c) });
check('serves a recorded response',
  (await car('0100')).replace(/\s/g, '').includes('4100'));
check('unrecorded commands behave like a silent ECU, not a crash',
  (await car('1902FF')) === 'NO DATA');
check('reports which commands were missing so a fixture can be extended',
  missed.includes('1902FF'), missed.join(','));

const repeat = { version: 1, responses: { '-|010C': ['41 0C 0A F6', '41 0C 0B 02'] } };
const rc = makeReplayCar(repeat);
const first = await rc('010C'), second = await rc('010C'), third = await rc('010C');
check('repeated polls replay in the order they were captured',
  first.includes('0AF6') || first.includes('0A F6'));
check('and hold the last value once the recording is exhausted', second === third,
  `${second} vs ${third}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
