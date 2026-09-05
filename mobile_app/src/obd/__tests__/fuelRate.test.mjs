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

check('idle-like RPM/throttle/load produces a small, plausible л/год value',
  (() => { const v = calcHeuristicFuelRate(800, 15, 20); return v != null && parseFloat(v) > 0 && parseFloat(v) < 3; })());
check('missing RPM returns null instead of NaN/garbage', calcHeuristicFuelRate(null, 15, 20) === null);
check('missing throttle returns null instead of NaN/garbage', calcHeuristicFuelRate(800, null, 20) === null);
check('missing load falls back to using throttle as load, still produces a value',
  calcHeuristicFuelRate(800, 15, null) != null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] л/год → л/100км conversion (the actual unit switch requested)\n');

// 8 л/год at 80 km/h → 10.0 л/100км
check('converts a realistic cruising rate correctly (8 л/год @ 80 km/h → 10.0 л/100км)',
  lphToL100km('8', 80) === '10.0');
// idle: fuel burns but speed ~0 — must NOT return a value (undefined/nonsensical), not '--' math
check('at idle (speed below threshold) returns null so the caller keeps showing л/год',
  lphToL100km('0.8', 0) === null);
check('just under the moving threshold (4 km/h) still returns null',
  lphToL100km('5', 4) === null);
check('just at the moving threshold (5 km/h) returns a real л/100км value',
  lphToL100km('3', 5) !== null);
check('an implausible result (>100 л/100км) is rejected rather than displayed',
  lphToL100km('50', 5) === null); // 50 л/год at 5 km/h → 1000 л/100км, clearly not real

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Structural check — real PID data must still be tried before any calculated fallback\n');

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
