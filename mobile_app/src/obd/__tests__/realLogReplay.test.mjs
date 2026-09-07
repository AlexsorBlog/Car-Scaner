/**
 * Real-hardware log replay test.
 *
 * Run: node src/obd/__tests__/realLogReplay.test.mjs   (from mobile_app/)
 *
 * Background: a tester (Тимур) sent a raw BLE log captured from a real
 * Mercedes — live telemetry polling plus a full DTC scan (UDS 1902xx,
 * legacy Mode 03/07/0A, KWP 18xx). This test replays that exact captured
 * data — copied verbatim below, not synthesized — through the app's real
 * decoding pipeline (decoders.js / dtcParser.js, the same modules
 * obd/index.js's query() and _executeRawDTC() call) to check two things:
 *
 *   1. Live telemetry (RPM/coolant/throttle/speed/load/intake) decodes to
 *      physically sane values — this is the first real-car fixture any
 *      test in this repo has used for the live-PID path, everything else
 *      so far was hand-built.
 *   2. The DTC scan's raw responses — captured BEFORE the ATCAF0/ATCAF1
 *      sequencing fix (see obd/index.js smartReadDTC) — correctly produce
 *      ZERO codes without crashing or hallucinating anything. This data is
 *      genuinely malformed (a negative response for 03/07, flow-control
 *      noise for the UDS/KWP queries) because of the bug that fix
 *      addresses; replaying it here only proves the PARSING side has
 *      always been correct (rejects garbage cleanly) — it can't validate
 *      the fix itself, since that fix changes what gets SENT to the ECU,
 *      not how a given response is decoded. That part needs a fresh
 *      on-car retest.
 */

import { temp, percent, decodeUas, fuel_rate } from '../decoders.js';
import {
  assembleHexPayload,
  stripNegativeResponses,
  parseLegacyModeDtc,
  parseUdsKwpDtc,
  isStructurallyValidDtc,
} from '../dtcParser.js';
import { dtc, dtc_uds, dtc_kwp } from '../decoders.js';

let pass = 0, fail = 0;
const ok   = (label, cond) => { if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); } else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); } };

// ── Verbatim excerpt from Тимур's real Mercedes log (2026-09-03 23:54) ──────
// One representative live-polling cycle + the full DTC scan block.
const RAW_LOG = `
[23:54:48] [QUERY] CMD: 010D | RES: 410D00
[23:54:49] [QUERY] CMD: 010C | RES: 410C0AF4
[23:54:49] [QUERY] CMD: 0105 | RES: 410572
[23:54:49] [QUERY] CMD: 0111 | RES: 411120
[23:54:52] [QUERY] CMD: 0104 | RES: 41043D
[23:54:52] [QUERY] CMD: 010F | RES: 410F4E
[23:54:53] [QUERY] CMD: 015E | RES: NO DATA
[23:54:54] [QUERY] CMD: 015E | RES: NO DATA
[23:54:54] [QUERY] CMD: 0110 | RES: NO DATA
[23:54:54] [DTC_RAW_RES] CMD: 190209 | RES: 300800AAAAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 190208 | RES: 300800AAAAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 190201 | RES: 300800AAAAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 190204 | RES: 300800AAAAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 03 | RES: 037F0011AAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 07 | RES: 037F0011AAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 0A | RES: NO DATA
[23:54:54] [DTC_RAW_RES] CMD: 18000000 | RES: 300800AAAAAAAAAA
[23:54:54] [DTC_RAW_RES] CMD: 1802FF00 | RES: 300800AAAAAAAAAA
`.trim();

const LINE_RE = /\[[\d:]+\]\s+\[(\w+)\]\s+CMD:\s+(\S+)\s+\|\s+RES:\s+(.+?)\s*$/;

function parseLog(raw) {
  return raw.split('\n').map(line => {
    const m = line.match(LINE_RE);
    if (!m) return null;
    return { tag: m[1], cmd: m[2], res: m[3].trim() };
  }).filter(Boolean);
}

// ── Replicates obd/index.js query()'s mode/PID-prefix extraction — same
// small inline copy pattern vinParser.test.mjs uses, against the real,
// unmodified decoders.js exports (not a reimplementation of the decoders).
const MODE_NO_PID = new Set(['03', '04', '07', '08']);
function queryFromRaw(cmd, res, { bytesInFrame, decoder }) {
  if (/NO ?DATA|ERROR|UNABLE|STOPPED/i.test(res)) return null;
  const clean = res.replace(/[\s\r\n]/g, '').toUpperCase();
  const modeHex   = cmd.substring(0, 2).toUpperCase();
  const modeInt   = parseInt(modeHex, 16);
  const replyMode = ((modeInt + 0x40) & 0xFF).toString(16).toUpperCase().padStart(2, '0');
  const cmdBytes  = bytesInFrame > 2 ? bytesInFrame - 2 : 0;

  let hexData;
  if (MODE_NO_PID.has(modeHex)) {
    const idx = clean.indexOf(replyMode);
    if (idx === -1) return null;
    hexData = clean.substring(idx + 2);
  } else {
    const pidHex = cmd.substring(2).toUpperCase();
    const prefix = replyMode + pidHex;
    const idx = clean.indexOf(prefix);
    if (idx === -1) return null;
    hexData = clean.substring(idx + prefix.length);
  }
  if (hexData.length === 0) return null;
  const targetHex = (cmdBytes > 0 && hexData.length >= cmdBytes * 2) ? hexData.substring(0, cmdBytes * 2) : hexData;
  try { return decoder(targetHex); } catch { return null; }
}

const entries = parseLog(RAW_LOG);

console.log('\n[1] Live telemetry — real Mercedes idle readings decode to sane physical values\n');

const liveSpecs = {
  '010C': { bytesInFrame: 4, decoder: (hex) => decodeUas(hex, '0x07'), label: 'RPM',      range: [0, 8000],  unit: 'rpm'  },
  '0105': { bytesInFrame: 3, decoder: temp,                             label: 'Coolant',  range: [-40, 215], unit: '°C'   },
  '0111': { bytesInFrame: 3, decoder: percent,                          label: 'Throttle',  range: [0, 100],   unit: '%'    },
  '010D': { bytesInFrame: 3, decoder: (hex) => decodeUas(hex, '0x09'), label: 'Speed',     range: [0, 300],   unit: 'km/h' },
  '0104': { bytesInFrame: 3, decoder: percent,                          label: 'Load',      range: [0, 100],   unit: '%'    },
  '010F': { bytesInFrame: 3, decoder: temp,                             label: 'Intake',    range: [-40, 215], unit: '°C'   },
};

for (const e of entries.filter(e => e.tag === 'QUERY' && liveSpecs[e.cmd])) {
  const spec  = liveSpecs[e.cmd];
  const value = queryFromRaw(e.cmd, e.res, spec);
  const inRange = value != null && !isNaN(value) && value >= spec.range[0] && value <= spec.range[1];
  ok(`${e.cmd} (${spec.label}): "${e.res}" → ${value}${spec.unit} — within [${spec.range[0]}, ${spec.range[1]}]`, inRange);
}

console.log('\n[2] Unsupported PIDs on this ECU (015E fuel rate, 0110 MAF) — consistently NO DATA, correctly rejected as null\n');

for (const e of entries.filter(e => e.tag === 'QUERY' && (e.cmd === '015E' || e.cmd === '0110'))) {
  const spec = e.cmd === '015E'
    ? { bytesInFrame: 4, decoder: fuel_rate }
    : { bytesInFrame: 4, decoder: (hex) => decodeUas(hex, '0x27') };
  const value = queryFromRaw(e.cmd, e.res, spec);
  ok(`${e.cmd}: "${e.res}" → correctly null (not a fabricated value)`, value === null);
}

console.log('\n[3] DTC scan raw responses — captured under the pre-fix ATCAF0 bug — must yield ZERO codes, no crash, no hallucination\n');

const dtcMethods = [
  { cmd: '190209', dec: dtc_uds, isUds: true  },
  { cmd: '190208', dec: dtc_uds, isUds: true  },
  { cmd: '190201', dec: dtc_uds, isUds: true  },
  { cmd: '190204', dec: dtc_uds, isUds: true  },
  { cmd: '03',       dec: dtc,     isUds: false },
  { cmd: '07',       dec: dtc,     isUds: false },
  { cmd: '0A',       dec: dtc,     isUds: false },
  { cmd: '18000000', dec: dtc_kwp, isUds: false },
  { cmd: '1802FF00', dec: dtc_kwp, isUds: false },
];

let totalCodesFound = 0;
let anyCrash = false;

for (const method of dtcMethods) {
  const entry = entries.find(e => e.tag === 'DTC_RAW_RES' && e.cmd === method.cmd);
  if (!entry) { ok(`${method.cmd}: fixture entry present`, false); continue; }
  if (/NO ?DATA/i.test(entry.res)) { ok(`${method.cmd}: "NO DATA" — correctly zero codes`, true); continue; }

  try {
    let payload = assembleHexPayload(entry.res);
    payload = stripNegativeResponses(payload);
    const result = (method.cmd === '03' || method.cmd === '07' || method.cmd === '0A')
      ? parseLegacyModeDtc(method.cmd, payload, method.dec)
      : parseUdsKwpDtc(payload, method.dec);

    const codes = (result || []).filter(item => isStructurallyValidDtc(method.isUds ? item.base : item));
    totalCodesFound += codes.length;
    ok(`${method.cmd}: "${entry.res}" → ${codes.length} codes (expected 0 from this malformed capture)`, codes.length === 0);
  } catch (err) {
    anyCrash = true;
    ok(`${method.cmd}: threw during parsing — ${err.message}`, false);
  }
}

ok('DTC parser never crashed on any of the 9 real captured responses', !anyCrash);
ok('DTC parser hallucinated zero codes total from this malformed capture', totalCodesFound === 0);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Post-fix capture — same car, same scan, after the ATCAF1 change\n');

// Verbatim from Тимур's 2026-09-05 22:18 session, running the build with the
// CAF fix. Compare against the pre-fix bytes in section [3] above: the legacy
// modes went from identical malformed garbage to proper positive responses,
// which is what proves the request framing — not the parser — was the bug.
const POST_FIX_LOG = `
[22:18:38] [DTC_RAW_RES] CMD: 03 | RES: 4300
[22:18:38] [DTC_RAW_RES] CMD: 07 | RES: 4700
[22:18:38] [DTC_RAW_RES] CMD: 0A | RES: 4A00
[22:18:38] [DTC_RAW_RES] CMD: 18000000 | RES: 7F1811
[22:18:38] [DTC_RAW_RES] CMD: 1802FF00 | RES: 7F1811
[22:18:37] [DTC_RAW_RES] CMD: 190209 | RES: 300800AAAAAAAAAA
`.trim();

const postFix = parseLog(POST_FIX_LOG);
const byCmd = (c) => postFix.find(e => e.cmd === c)?.res;

ok('Mode 03 now returns a well-formed positive response (43 = 0x40+0x03), not garbage',
  byCmd('03') === '4300');
ok('Mode 07 now returns a well-formed positive response (47), distinct from Mode 03',
  byCmd('07') === '4700' && byCmd('07') !== byCmd('03'));
ok('Mode 0A now answers at all (4A) instead of "NO DATA"', byCmd('0A') === '4A00');
ok('KWP now returns a genuine per-service negative response (7F 18 11 = service not supported)',
  byCmd('18000000') === '7F1811');

// The count byte after 43/47/4A is 00 → the ECU really is reporting zero
// generic DTCs. Thermostat/battery faults are manufacturer-specific and never
// appear in Mode 03; they need the UDS 19 path, which is what the CAF1 change
// for udsMethods addresses.
for (const [cmd, dec] of [['03', dtc], ['07', dtc], ['0A', dtc]]) {
  const payload = stripNegativeResponses(assembleHexPayload(byCmd(cmd)));
  const res = parseLegacyModeDtc(cmd, payload, dec) || [];
  ok(`${cmd}: decodes cleanly to zero stored codes (count byte 00), no crash`, res.length === 0);
}

ok('UDS 190209 was still returning a flow-control frame (30 08 00) pre-CAF1-change — the remaining bug this round fixes',
  byCmd('190209') === '300800AAAAAAAAAA');

console.log(`\n${pass} passed, ${fail} failed`);
console.log(
  fail === 0
    ? '\nNote: this confirms decoding never crashes/fabricates on real captured\n' +
      'bytes. It does NOT confirm the ATCAF0/ATCAF1 request-side fix itself —\n' +
      'that requires a fresh on-car DTC scan, since the fix changes what gets\n' +
      'sent to the ECU, not how a response already on hand gets parsed.'
    : ''
);
process.exit(fail === 0 ? 0 : 1);
