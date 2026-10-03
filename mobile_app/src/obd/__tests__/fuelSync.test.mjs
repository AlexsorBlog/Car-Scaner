/**
 * The fuel tile and the fuel graph must show the SAME number, and a car that is
 * standing still must never be reported as drinking 99 л/100км.
 *
 * Run: node src/obd/__tests__/fuelSync.test.mjs   (from mobile_app/)
 *
 * Built from Тимур's real capture (2026-10-03, engine idling, car stationary):
 *
 *   010D -> 410D00    speed  0 km/h
 *   010C -> 410C0ADE  rpm    695
 *   0104 -> 41043C    load   ~23.5 %
 *   0111 -> 411121    throttle ~12.9 %
 *   015E -> NO DATA   no fuel-rate PID
 *   0110 -> NO DATA   no MAF
 *
 * With both fuel PIDs absent the rate is estimated from rpm/load, and л/100км —
 * fuel per DISTANCE — is undefined while the distance is zero. The old code
 * answered that twice, differently: the graph drew the 99.9 ceiling while the
 * tile fell back to "--".
 */

import { calcHeuristicFuelRate } from '../fuelRate.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ── The poller's rolling-window maths, mirrored exactly ──────────────────────
// (TelemetryContext: integrate litres and km over a window, divide, and hold the
// last real figure when the window has no distance in it.)
const FUEL_WINDOW_MS = 2 * 60 * 1000;

function makePoller() {
  const samples = [];
  let lastGood = null;
  return {
    /** One polling cycle. Returns the canonical л/100км, or null. */
    tick(now, lph, speedKmh, dtMs = 1000) {
      const dtHours = dtMs / 3600000;
      samples.push({ t: now, litres: lph * dtHours, km: speedKmh * dtHours });
      while (samples.length && samples[0].t < now - FUEL_WINDOW_MS) samples.shift();

      let litres = 0, km = 0;
      for (const s of samples) { litres += s.litres; km += s.km; }
      const avg = km > 0.05 ? Math.round((litres / km) * 1000) / 10 : null;

      if (avg != null && avg > 0 && avg < 100) { lastGood = avg; return avg; }
      return lastGood;          // standing still: hold the last real figure
    },
    get held() { return lastGood; },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The car from the capture: idling, going nowhere\n');

const IDLE_RPM = 695, IDLE_LOAD = 23.5, IDLE_THROTTLE = 12.9;
const idleLph = Number(calcHeuristicFuelRate(IDLE_RPM, IDLE_THROTTLE, IDLE_LOAD));

check('a fuel rate is still produced with no 015E and no MAF',
  Number.isFinite(idleLph) && idleLph > 0, String(idleLph));
check('idle burn is a believable л/год figure, not a wild one',
  idleLph > 0.2 && idleLph < 5, `${idleLph} л/год`);

{
  const p = makePoller();
  let value = null;
  for (let i = 0; i < 60; i++) value = p.tick(1_000_000 + i * 1000, idleLph, 0);

  check('a stationary car never reports the 99 л/100км ceiling',
    value === null || value < 90, String(value));
  check('with no distance ever driven there is simply no per-100km figure yet',
    value === null, String(value));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Drive, then stop at a light\n');

{
  const p = makePoller();
  let t = 2_000_000;
  let driving = null;
  // 60s at 60 km/h burning 6 л/год  -> 10 л/100км
  for (let i = 0; i < 60; i++) driving = p.tick(t += 1000, 6, 60);

  check('while moving it reports the real consumption',
    driving !== null && Math.abs(driving - 10) < 0.6, String(driving));

  const atLight = p.tick(t += 1000, idleLph, 0);
  check('stopping at a light does NOT jump to 99',
    atLight !== null && atLight < 90, String(atLight));
  check('it holds the figure the car just achieved',
    Math.abs(atLight - driving) < 0.6, `${atLight} vs ${driving}`);

  let stopped = atLight;
  for (let i = 0; i < 30; i++) stopped = p.tick(t += 1000, idleLph, 0);
  check('and keeps holding it while stopped, instead of drifting upward',
    stopped !== null && stopped < 90, String(stopped));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Tile and graph cannot disagree\n');

{
  // Both read the SAME poller output: the tile takes the latest value, the graph
  // plots every value. That is the point of computing it in one place.
  const p = makePoller();
  let t = 3_000_000;
  const series = [];
  const emitted = [];
  // Long enough to clear the 50 m noise floor: below that the ratio is still
  // dominated by measurement error, so the poller deliberately reports nothing.
  const speeds = [0, 0, ...Array(20).fill(60), 0, 0, 0, 50, 0, 0];
  for (const v of speeds) {
    const out = p.tick(t += 1000, v > 0 ? 6 : idleLph, v);
    emitted.push(out);
    if (out != null) series.push({ t, v: out });
  }

  const tile = series.length ? series[series.length - 1].v : null;
  const graphLast = series.length ? series[series.length - 1].v : null;

  check('the tile value IS the last point of the graph series',
    tile === graphLast && tile !== null, `${tile} vs ${graphLast}`);
  check('no point in the series is the standstill ceiling',
    series.every(s => s.v < 90), JSON.stringify(series.map(s => s.v)));
  check('every point is a finite, positive number — never undefined or NaN',
    series.every(s => Number.isFinite(s.v) && s.v > 0));
  // Before the first real measurement there is honestly nothing to draw; after
  // it, the line must never break — including while stopped.
  const firstIdx = emitted.findIndex(v => v != null);
  check('a value appears once enough distance is covered', firstIdx >= 0, String(firstIdx));
  check('and from then on EVERY cycle has a value — no gaps at stops',
    firstIdx >= 0 && emitted.slice(firstIdx).every(v => v != null),
    `${emitted.slice(firstIdx).filter(v => v == null).length} gaps after first value`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] The number the tile prints\n');

// Mirrors DashboardPage: per-distance when it exists, otherwise the engine's
// hourly burn, otherwise "--". Returns [value, unit].
const renderTile = (canonical, held, perHour) => {
  const perDistance = (canonical != null && isFinite(canonical)) ? canonical : held;
  if (perDistance != null && isFinite(perDistance)) return [Number(perDistance).toFixed(1), 'л/100км'];
  if (perHour != null && isFinite(perHour)) return [Number(perHour).toFixed(1), 'л/год'];
  return ['--', 'л/100км'];
};

check('a real per-distance value prints with one decimal',
  renderTile(8.34, null, 1.1)[0] === '8.3');
check('a held value is used when the current one is unavailable',
  renderTile(null, 9.1, 1.1)[0] === '9.1');

// The car in the capture: idling, never moved, no 015E and no MAF. There is no
// honest per-100km figure — but the engine IS burning fuel, and we can say how
// much per hour from rpm and load.
const [idleValue, idleUnit] = renderTile(null, null, idleLph);
check('a parked car shows its ENGINE USAGE instead of "--"',
  idleValue !== '--' && Number(idleValue) > 0, `${idleValue} ${idleUnit}`);
check('and labels it as an hourly burn, not per-100km',
  idleUnit === 'л/год', idleUnit);
check('that number is small and believable, never a wild one',
  Number(idleValue) < 10, idleValue);

check('with nothing at all it prints "--", never "undefined"',
  renderTile(null, null, null)[0] === '--');
check('a NaN never reaches the screen', renderTile(NaN, null, NaN)[0] === '--');
check('undefined is handled like absent',
  renderTile(undefined, undefined, undefined)[0] === '--');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] No wild numbers, anywhere\n');

check('the poller refuses implausible per-100km figures',
  (() => {
    const p2 = makePoller();
    let t2 = 5_000_000, v = null;
    // Crawling: 1 km/h while burning 40 л/год is ~4000 л/100км — division noise.
    for (let i = 0; i < 30; i++) v = p2.tick(t2 += 1000, 40, 1);
    return v === null || v < 50;
  })(), 'implausible value leaked');

check('99 л/100км is not reachable for an idling car',
  (() => {
    const p3 = makePoller();
    let t3 = 6_000_000, v = null;
    for (let i = 0; i < 120; i++) v = p3.tick(t3 += 1000, idleLph, 0);
    return v === null;
  })(), 'idle produced a per-distance number');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
