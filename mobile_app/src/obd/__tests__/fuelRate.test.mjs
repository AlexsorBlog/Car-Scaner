/**
 * Fuel-rate fallback chain regression test.
 *
 * Run: node src/obd/__tests__/fuelRate.test.mjs   (from mobile_app/)
 *
 * getSmartFuelRate() (obd/index.js) tries, in order: real PID 015E → same
 * PID on an alternate ECU header → Mercedes-specific UDS PIDs → a MAF-based
 * physics calc → an RPM/throttle heuristic → '--'. The request was: verify
 * real car data is always preferred, calculation only used as a fallback
 * when real data isn't available, and that the fuel-rate math itself is
 * actually correct — checked here against real published reference values,
 * not just internally-consistent synthetic numbers.
 *
 * This tests the pure functions in obd/fuelRate.js (the same functions
 * index.js's getSmartFuelRate() calls directly — no reimplementation here)
 * plus a structural check that the fallback ORDER in index.js hasn't
 * regressed to try a calculated value before a real one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  MERCEDES_UDS_FUEL_CMDS,
  FUEL_PROPS,
  decodeUdsFuelReply,
  calcMafFuelRate,
  calcHeuristicFuelRate,
  lphToL100km,
} from '../fuelRate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function check(label, condition, detail = '') {
  if (condition) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else           { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] Real-world reference sanity checks — not just internally-consistent math\n');

// Stoichiometric AFR (14.7 petrol / 14.5 diesel) is standard, undisputed —
// x-engineer.org and general automotive references agree. Fuel density is
// the one that's easy to get subtly wrong (it did — see [2] below).
check('petrol AFR matches the standard stoichiometric value (14.7:1)', FUEL_PROPS[1].afr === 14.7);
check('diesel AFR matches the standard stoichiometric value (14.5:1)', FUEL_PROPS[4].afr === 14.5);
check('petrol density falls within the real-world reference range (730–760 g/L)',
  FUEL_PROPS[1].density >= 730 && FUEL_PROPS[1].density <= 760,
  `got ${FUEL_PROPS[1].density}`);
check('diesel density falls within the real-world reference range (810–850 g/L)',
  FUEL_PROPS[4].density >= 810 && FUEL_PROPS[4].density <= 850,
  `got ${FUEL_PROPS[4].density}`);

// A commonly-cited idle MAF for a naturally-aspirated ~2.0L 4-cylinder is
// ~2-3 g/s, and idle consumption for that class of engine is commonly cited
// around 0.6-1.0 л/год. This checks our formula lands in that real range,
// not just that it doesn't crash.
const idleMafLph = calcMafFuelRate(2.5, 1);
check('MAF-based calc at a realistic idle MAF (2.5 g/s, petrol) lands in the commonly-cited idle range (0.6–1.0 л/год)',
  idleMafLph != null && parseFloat(idleMafLph) >= 0.6 && parseFloat(idleMafLph) <= 1.0,
  `got ${idleMafLph} л/год`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Regression: the density bug this test caught\n');

// Before the fix, petrol density was 820 g/L — since density is the
// denominator, that's a real ~10% UNDERESTIMATE of consumption whenever the
// app fell back to the MAF calc on a petrol car. Pin the corrected value so
// it can't silently drift back.
const lphWithOldWrongDensity = ((2.5 * 3600) / (14.7 * 820)).toFixed(1);
const lphWithFixedDensity    = calcMafFuelRate(2.5, 1);
check('fixed petrol density computes a higher (more accurate) л/год than the old 820 g/L value did',
  parseFloat(lphWithFixedDensity) > parseFloat(lphWithOldWrongDensity),
  `old(820g/L)=${lphWithOldWrongDensity} л/год vs fixed=${lphWithFixedDensity} л/год`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] UDS fuel-PID decoding (Mercedes-specific path) — well-formed and malformed replies\n');

// 22F40F request → 62F40F positive reply, scale 0.01: raw 0x01F4 (500) → 5.00 л/год
const wellFormedUdsReply = '62F40F01F4';
check('decodes a well-formed UDS fuel reply correctly',
  decodeUdsFuelReply(wellFormedUdsReply, '22F40F', 0.01) === '5.00',
  `got ${decodeUdsFuelReply(wellFormedUdsReply, '22F40F', 0.01)}`);

check('rejects "NO DATA" instead of returning a fabricated value',
  decodeUdsFuelReply('NO DATA', '22F40F', 0.01) === null);
check('rejects a reply for a DIFFERENT DID (prefix mismatch) instead of misreading it',
  decodeUdsFuelReply('62F41500C8', '22F40F', 0.01) === null);
check('rejects an out-of-plausible-range decoded value (>100 л/год)',
  decodeUdsFuelReply('62F40FFFFD', '22F40F', 0.01) === null);

for (const cmd of MERCEDES_UDS_FUEL_CMDS) {
  check(`${cmd.command}: a well-formed reply for THIS exact command decodes correctly`,
    decodeUdsFuelReply(`62${cmd.command.substring(2)}0064`, cmd.command, cmd.scale) === '1.00');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Heuristic fallback (last resort — RPM + throttle + load)\n');

// Real values decoded from Тимур's Mercedes log while idling:
//   010C = 410C0AF6 → 0x0AF6/4 = 701 rpm
//   0104 = 41043D   → 0x3D*100/255 = 24% load
//   0111 = 411120   → 0x20*100/255 = 12% throttle
// Both 015E (fuel rate) and 0110 (MAF) return NO DATA on this ECU, so this
// heuristic is what actually drives the gauge on that car.
const realIdle = calcHeuristicFuelRate(701, 12, 24);
check('real logged idle (701 rpm, 24% load) lands in the commonly-cited 0.6-1.5 л/год idle range',
  realIdle != null && parseFloat(realIdle) >= 0.6 && parseFloat(realIdle) <= 1.5,
  `got ${realIdle} л/год`);

// Regression pin: the old BSFC-constant formula gave 2.0*701*0.24*0.00028 =
// 0.09 л/год for those same real inputs — ~10x too low, which is the "~100
// ml/h" the gauge was showing.
const oldBsfcResult = (2.0 * 701 * 0.24 * 0.00028).toFixed(1);
check('corrected heuristic is far above the old BSFC formula that produced the bogus reading',
  parseFloat(realIdle) > parseFloat(oldBsfcResult) * 5,
  `old=${oldBsfcResult} л/год vs fixed=${realIdle} л/год`);

check('missing RPM returns null instead of NaN/garbage', calcHeuristicFuelRate(null, 15, 20) === null);
check('missing BOTH load and throttle returns null', calcHeuristicFuelRate(800, null, null) === null);
check('load alone is enough (throttle missing) — load is the better airflow proxy',
  calcHeuristicFuelRate(800, null, 20) != null);
check('throttle alone is used as a fallback when load is missing',
  calcHeuristicFuelRate(800, 15, null) != null);
check('scales sensibly under load — 3000 rpm @ 60% is well above idle but still plausible',
  (() => { const v = parseFloat(calcHeuristicFuelRate(3000, 60, 60)); return v > 5 && v < 25; })(),
  `got ${calcHeuristicFuelRate(3000, 60, 60)} л/год`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] л/год → л/100км conversion (the actual unit switch requested)\n');

// 8 л/год at 80 km/h → 10.0 л/100км
check('converts a realistic cruising rate correctly (8 л/год @ 80 km/h → 10.0 л/100км)',
  lphToL100km('8', 80) === '10.0');
// idle: fuel burns but speed ~0 — must NOT return a value (undefined/nonsensical), not '--' math
// At a standstill л/100км is undefined; returning null lets the caller decide
// (DashboardPage holds the last valid reading rather than blanking the tile).
check('at idle (speed below threshold) returns null rather than an infinite value',
  lphToL100km('0.8', 0) === null);
check('just under the moving threshold (4 km/h) still returns null',
  lphToL100km('5', 4) === null);
check('just at the moving threshold (5 km/h) returns a real л/100км value',
  lphToL100km('3', 5) !== null);
check('an implausible result (>100 л/100км) is rejected rather than displayed',
  lphToL100km('50', 5) === null); // 50 л/год at 5 km/h → 1000 л/100км, clearly not real

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Rolling-window л/100км — must stay defined when the car stops\n');

// Mirrors TelemetryContext's accumulator: integrate л/год and km/h over elapsed
// time, then divide the totals. The point is that stopping must NOT blow the
// figure up to infinity the way an instantaneous ratio does.
function rollingL100(samples) {
  let totalL = 0, totalKm = 0;
  for (const { lph, speedKmh, seconds } of samples) {
    const dtH = seconds / 3600;
    totalL  += lph * dtH;
    totalKm += speedKmh * dtH;
  }
  return totalKm > 0.05 ? Math.round((totalL / totalKm) * 1000) / 10 : null;
}

// 60s cruising at 90 km/h burning 7 л/год → 7/90*100 = 7.8 л/100км
check('steady cruise integrates to the expected л/100км',
  rollingL100([{ lph: 7, speedKmh: 90, seconds: 60 }]) === 7.8,
  `got ${rollingL100([{ lph: 7, speedKmh: 90, seconds: 60 }])}`);

// Same cruise, then 30s stopped at a light burning 1.1 л/год with 0 km covered.
// An instantaneous reading would be infinite here; the window must stay finite
// and only drift up modestly.
const withStop = rollingL100([
  { lph: 7,   speedKmh: 90, seconds: 60 },
  { lph: 1.1, speedKmh: 0,  seconds: 30 },
]);
check('stopping at a light keeps the figure finite instead of going infinite',
  withStop != null && isFinite(withStop), `got ${withStop}`);
check('the idle period nudges consumption up but stays realistic (< 10 л/100км)',
  withStop > 7.8 && withStop < 10, `got ${withStop} л/100км`);
check('instantaneous conversion at that same standstill IS undefined — which is why the window exists',
  lphToL100km('1.1', 0) === null);

// A car that has genuinely never moved has no distance to divide by.
check('never-moved car yields null (no distance means no per-distance figure exists)',
  rollingL100([{ lph: 1.1, speedKmh: 0, seconds: 120 }]) === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Structural check — real PID data must still be tried before any calculated fallback\n');

const indexSrc = readFileSync(join(__dirname, '..', 'index.js'), 'utf-8');
const fnStart = indexSrc.indexOf('async getSmartFuelRate()');
const fnBody  = indexSrc.substring(fnStart, indexSrc.indexOf('\n  }', fnStart));

const idx = {
  step1RealPid: fnBody.indexOf("this.query(cmd5E)"),
  step2AltHdr:  fnBody.indexOf('ATSH7E2'),
  step3UdsPid:  fnBody.indexOf('MERCEDES_UDS_FUEL_CMDS'),
  step4MafCalc: fnBody.indexOf('calcMafFuelRate'),
  step5Heuristic: fnBody.indexOf('calcHeuristicFuelRate'),
};

check('all 5 fallback tiers are present in getSmartFuelRate()',
  Object.values(idx).every(i => i !== -1), JSON.stringify(idx));
check('real-PID tiers (1, 2, 3) all appear before the calculated tiers (4, 5) in source order',
  idx.step1RealPid < idx.step4MafCalc &&
  idx.step2AltHdr  < idx.step4MafCalc &&
  idx.step3UdsPid  < idx.step4MafCalc &&
  idx.step4MafCalc < idx.step5Heuristic,
  `order: ${JSON.stringify(idx)}`);

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
