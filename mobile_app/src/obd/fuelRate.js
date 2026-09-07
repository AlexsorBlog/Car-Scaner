/**
 * obd/fuelRate.js — pure fuel-rate decoding/calculation helpers, no BLE/
 * Capacitor deps. Split out of obd/index.js's getSmartFuelRate() so the
 * fallback chain (real PID → alt header → Mercedes UDS PID → MAF-based
 * calc → RPM/throttle heuristic) can be unit-tested directly — same reason
 * dtcParser.js was split out (see obd/__tests__/dtcParser.test.mjs).
 *
 * getSmartFuelRate() always computes in л/год (a rate, well-defined even at
 * idle — that's also what gets stored in history/graphs). Converting to
 * л/100км needs the current speed, which this module doesn't have, so that
 * conversion (lphToL100km) is a separate, explicit step done at display time.
 */

// Mercedes W212/W205/W213 commonly use these UDS ReadDataByIdentifier PIDs.
// 22F40F = fuel consumption (l/h), 22F415 = instant consumption variant,
// 222110 / 2221FD = alternate addresses seen on some ECU variants.
export const MERCEDES_UDS_FUEL_CMDS = [
  { command: '22F40F', scale: 0.01, desc: 'UDS Fuel F40F' },
  { command: '22F415', scale: 0.01, desc: 'UDS Fuel F415' },
  { command: '222110', scale: 0.01, desc: 'UDS Fuel 2110' },
  { command: '2221FD', scale: 0.01, desc: 'UDS Fuel 21FD' },
];

export const FUEL_PROPS = {
  // density in g/L. Petrol was 820 (too high vs the real 730-760 g/L range —
  // that overstated density made calcMafFuelRate() UNDERESTIMATE petrol
  // consumption by ~10%, since density sits in the denominator); 745 is the
  // commonly-cited average. Diesel's 850 and the rest were already in range.
  1:  { afr: 14.7, density: 745 },  // Petrol
  4:  { afr: 14.5, density: 850 },  // Diesel
  8:  { afr: 15.5, density: 540 },  // LPG
  9:  { afr: 17.2, density: 128 },  // CNG
  23: { afr: 9.0,  density: 789 },  // Ethanol
};

// Extracts an ISO-TP UDS ReadDataByIdentifier (service 0x22) reply — prefix
// "62" + the 2-byte DID, e.g. requesting "22F40F" replies "62F40F<data>".
// Returns a л/год string, or null if the response is missing/malformed/out
// of the plausible range (>100 л/год is not a real instantaneous rate).
export function decodeUdsFuelReply(rawResponse, command, scale = 0.01) {
  if (!rawResponse) return null;
  const upper = rawResponse.toUpperCase();
  if (upper.includes('NO DATA') || upper.includes('ERROR') || upper.includes('?')) return null;

  const clean = rawResponse.replace(/[\s\r\n:0-9A-F]{1}:/g, '').replace(/[\s\r\n]/g, '').toUpperCase();
  const did       = command.substring(2).toUpperCase();
  const replyPfx  = '62' + did;
  const prefixIdx = clean.indexOf(replyPfx);
  if (prefixIdx === -1) return null;

  const hexData = clean.substring(prefixIdx + 6, prefixIdx + 10);
  if (hexData.length !== 4) return null;

  const rawVal = parseInt(hexData, 16);
  if (isNaN(rawVal) || rawVal <= 0 || rawVal >= 0xFFFE) return null;

  const lph = (rawVal * (scale || 0.01)).toFixed(2);
  return (parseFloat(lph) > 0 && parseFloat(lph) < 100) ? lph : null;
}

// MAF (Mass Air Flow, g/s) → fuel rate via the air-fuel-ratio relationship:
// fuel_g_per_s = maf_g_per_s / AFR; л/год = fuel_g_per_s * 3600 / density(g/L).
export function calcMafFuelRate(mafGs, fuelTypeId = 1) {
  if (mafGs == null || isNaN(mafGs) || mafGs <= 0) return null;
  const fp = FUEL_PROPS[fuelTypeId] || FUEL_PROPS[1];
  return ((mafGs * 3600) / (fp.afr * fp.density)).toFixed(1);
}

// Air density at roughly 20°C / 1 atm, g/L — used to turn the engine's
// theoretical volumetric airflow into a mass airflow.
const AIR_DENSITY_G_PER_L = 1.2;

// Last-resort estimate when the ECU exposes neither PID 015E nor MAF (0110) —
// on this Mercedes both come back "NO DATA", so this path is what actually
// drives the gauge. Estimates airflow via the standard speed-density relation,
// then reuses the SAME AFR/density physics as the real MAF path:
//
//   intake volume flow (4-stroke) = rpm/2 revolutions × displacement, per min
//                                 = rpm × L / 120  litres per second
//   MAF_g_s ≈ that × air density × engine load
//
// PID 0104 "calculated engine load" is defined as current airflow ÷ peak
// airflow, so it is exactly the right multiplier here — it already carries
// the throttling/volumetric-efficiency effect. Throttle position is only a
// fallback for ECUs that don't report load.
//
// Sanity vs the real car: 701 rpm, 24% load, 2.0L →
//   (701 × 2.0 / 120) × 1.2 × 0.24 = 3.4 g/s  (real idle MAF is 2-4 g/s)
//   → ~1.1 л/год, matching the commonly-cited 0.6-1.0 л/год idle range.
// The previous BSFC-constant formula returned 0.09 л/год for the same inputs —
// roughly 10x too low, which is the "~100 ml/h" the gauge was showing.
export function calcHeuristicFuelRate(rpm, throttlePercent, loadPercent, displacementL = 2.0) {
  if (rpm == null || isNaN(rpm) || rpm <= 0) return null;

  const loadFraction =
    (loadPercent != null && !isNaN(loadPercent)) ? loadPercent / 100
    : (throttlePercent != null && !isNaN(throttlePercent)) ? throttlePercent / 100
    : null;
  if (loadFraction == null || loadFraction <= 0) return null;

  const intakeLitresPerSec = (rpm * displacementL) / 120;
  const estimatedMafGs     = intakeLitresPerSec * AIR_DENSITY_G_PER_L * loadFraction;

  // Reuse the real MAF physics so both paths agree on AFR and fuel density.
  const lph = calcMafFuelRate(estimatedMafGs, 1);
  if (lph == null) return null;
  return (parseFloat(lph) > 0 && parseFloat(lph) < 80) ? lph : null;
}

// л/год → л/100км, only meaningful while actually moving — at/near a stop,
// fuel burns but distance doesn't, so the ratio blows up/is undefined
// (exactly how real trip computers behave: they show л/год at idle and
// switch to л/100км once moving). Returns null below the threshold or on
// an implausible result, so the caller can decide how to display that
// (e.g. DashboardPage falls back to showing л/год in that case).
export function lphToL100km(lph, speedKmh, movingThresholdKmh = 5) {
  const lphNum = Number(lph);
  const speed  = Number(speedKmh) || 0;
  if (isNaN(lphNum) || speed < movingThresholdKmh) return null;
  const l100 = (lphNum / speed) * 100;
  return (l100 > 0 && l100 < 100) ? l100.toFixed(1) : null;
}
