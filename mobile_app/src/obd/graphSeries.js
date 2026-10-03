/**
 * obd/graphSeries.js — pure helpers behind the telemetry graphs.
 *
 * Three jobs, all kept out of DashboardPage so they can be tested:
 *
 *  1. FIXED Y axes. The graphs used to compute min/max from whatever points
 *     happened to be on screen, so panning re-scaled the axis under your finger
 *     and the same value jumped to a different height. The axis is now a
 *     property of the metric, never of the visible data.
 *
 *  2. Fuel in л/100км. History stores л/год (a rate that is well-defined at
 *     idle); л/100км needs distance, so each fuel sample has to be paired with
 *     the speed at that moment. Samples taken below the moving threshold have
 *     no meaningful per-distance value and are dropped rather than faked.
 *
 *  3. Finding the nearest data in a direction, so swiping past the end of the
 *     recording jumps to the real data instead of showing an empty grid.
 */

// ── Fixed Y axes ────────────────────────────────────────────────────────────
// Ranges cover the full plausible span of each sensor, so a value never sits
// off-axis, and the axis never moves. Keys accept both the graph id (SPEED) and
// the history key (speed).
const RANGES = {
  speed:   { min: 0, max: 200,  step: 40 },
  rpm:     { min: 0, max: 8000, step: 2000 },
  temp:    { min: 0, max: 150,  step: 30 },
  fuel:    { min: 0, max: 30,   step: 5 },   // л/100км
  load:    { min: 0, max: 100,  step: 20 },
  throttle:{ min: 0, max: 100,  step: 20 },
  voltage: { min: 8, max: 16,   step: 2 },
  intake:  { min: 0, max: 80,   step: 20 },
  maf:     { min: 0, max: 100,  step: 20 },
};

const ID_TO_RANGE = {
  SPEED: 'speed',
  RPM: 'rpm',
  COOLANT_TEMP: 'temp',
  FUEL_RATE: 'fuel',
  ENGINE_LOAD: 'load',
  THROTTLE: 'throttle',
  THROTTLE_POS: 'throttle',
  VOLTAGE: 'voltage',
  CONTROL_MODULE_VOLTAGE: 'voltage',
  INTAKE_TEMP: 'intake',
  MAF: 'maf',
};

export const DEFAULT_RANGE = { min: 0, max: 100, step: 20 };

/**
 * The Y axis for a metric. Deliberately takes no data argument — that is the
 * whole point: the same metric always renders on the same axis.
 * @returns {{min:number,max:number,step:number,range:number,ticks:number[]}}
 */
export function yAxisFor(metricId) {
  const key = ID_TO_RANGE[metricId] || (metricId || '').toLowerCase();
  const r = RANGES[key] || DEFAULT_RANGE;
  const ticks = [];
  for (let v = r.min; v <= r.max + 1e-9; v += r.step) ticks.push(Number(v.toFixed(6)));
  return { ...r, range: r.max - r.min, ticks };
}

/**
 * Value → SVG y coordinate (0 = top, 100 = bottom) on a fixed axis.
 *
 * Clamped on purpose: with an auto-scaling axis an extreme reading simply
 * stretched the chart, but a FIXED axis has an edge, and an unclamped value
 * would be drawn outside the chart box. Pinning it to the edge keeps the line
 * visible and honest about having gone off-scale.
 */
export function svgYFor(value, axis) {
  const a = axis || { min: DEFAULT_RANGE.min, range: DEFAULT_RANGE.max - DEFAULT_RANGE.min };
  const range = a.range || (a.max - a.min) || 1;
  const y = 100 - ((Number(value) - a.min) / range) * 100;
  if (isNaN(y)) return 100;
  return Math.max(0, Math.min(100, y));
}

// ── Fuel: л/год history → л/100км history ───────────────────────────────────

/**
 * Largest л/100км worth believing. Above this the figure is noise, not a
 * reading: a stationary car divides fuel by ~zero distance and produces an
 * arbitrarily large number, which is how the graph ended up showing 99 л/100км
 * on an idling car. Anything beyond this is discarded rather than drawn.
 */
export const L100_PLAUSIBLE_MAX = 50;

// Below this the car is not meaningfully moving and the ratio runs away.
const STANDSTILL_KMH = 0.5;

/**
 * Pair each fuel sample with the speed reading closest in time and convert
 * л/год → л/100км. Every fuel sample produces a point.
 *
 * @param {Array<{t:number,v:number}>} fuelPoints  л/год samples
 * @param {Array<{t:number,v:number}>} speedPoints км/год samples
 * @param {{maxGapMs?:number}} [opts]
 *        maxGapMs — how stale a speed sample may be before the fuel sample is
 *        considered unpairable (default 5s; polling runs ~1Hz).
 * @returns {Array<{t:number,v:number}>} л/100км samples
 */
export function toL100kmSeries(fuelPoints, speedPoints, opts = {}) {
  const { maxGapMs = 5000 } = opts;
  if (!fuelPoints?.length || !speedPoints?.length) return [];

  const speeds = [...speedPoints].sort((a, b) => a.t - b.t);
  const out = [];
  let i = 0;
  let lastGood = null;

  for (const f of [...fuelPoints].sort((a, b) => a.t - b.t)) {
    // Advance to the last speed sample at or before this fuel sample.
    while (i + 1 < speeds.length && speeds[i + 1].t <= f.t) i++;

    // The nearest sample is either that one or the next one.
    let nearest = speeds[i];
    const next = speeds[i + 1];
    if (next && Math.abs(next.t - f.t) < Math.abs(nearest.t - f.t)) nearest = next;

    // No speed anywhere near this fuel reading: we genuinely cannot say what it
    // cost per kilometre, and guessing would be worse than leaving it out.
    if (!nearest || Math.abs(nearest.t - f.t) > maxGapMs) continue;

    const lph   = Number(f.v);
    const speed = Number(nearest.v);
    if (isNaN(lph) || isNaN(speed)) continue;

    let v;
    if (lph <= 0) {
      // Overrun fuel cut-off — coasting in gear burns nothing. Genuinely 0.
      v = 0;
    } else if (speed <= STANDSTILL_KMH) {
      // Idling: fuel per DISTANCE cannot be measured, because there is no
      // distance. Hold the last real figure, exactly as a car's own trip
      // computer does, rather than inventing a huge one.
      if (lastGood == null) continue;      // nothing real to hold on to yet
      v = lastGood;
    } else {
      v = (lph / speed) * 100;
      if (v > L100_PLAUSIBLE_MAX) continue;  // noise, not a reading
    }
    lastGood = v;
    out.push({ t: f.t, v: Number(v.toFixed(1)) });
  }
  return out;
}

// ── Navigating to where the data actually is ────────────────────────────────

/**
 * The data point nearest `fromTime` in one direction.
 * @param {Array<{t:number}>} points
 * @param {number} fromTime
 * @param {'past'|'future'} direction
 * @returns {{t:number,v:number}|null}
 */
export function findNeighborPoint(points, fromTime, direction) {
  if (!points?.length) return null;
  let best = null;
  for (const p of points) {
    if (direction === 'past') {
      if (p.t < fromTime && (!best || p.t > best.t)) best = p;
    } else {
      if (p.t > fromTime && (!best || p.t < best.t)) best = p;
    }
  }
  return best;
}

/**
 * Pan offset (ms back from now) that centres `targetTime` in the window.
 * Clamped at 0 so we never scroll into the future.
 */
export function panOffsetCentering(targetTime, windowMs, now = Date.now()) {
  return Math.max(0, now - targetTime - windowMs / 2);
}

/** Human-readable stamp for "you are now looking at data from ...". */
export function formatPointDate(t, locale = 'uk-UA') {
  const d = new Date(t);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleString(locale, {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      });
}

// ── Window presets ──────────────────────────────────────────────────────────
// Shared by every graph. 5 seconds is the default: a live view of the value as
// it moves, which is what the dashboard is usually open for.
export const WINDOW_PRESETS = [
  { label: '5 СЕК', ms: 5 * 1000 },
  { label: '30 СЕК', ms: 30 * 1000 },
  { label: '1 ХВ', ms: 60 * 1000 },
  { label: '5 ХВ', ms: 5 * 60 * 1000 },
  { label: '30 ХВ', ms: 30 * 60 * 1000 },
  { label: '24 ГОД', ms: 24 * 60 * 60 * 1000 },
  { label: '7 ДНІВ', ms: 7 * 24 * 60 * 60 * 1000 },
];

export const DEFAULT_WINDOW_MS = 5 * 1000;

const WINDOW_STORAGE_PREFIX = 'graphWindowMs:';

/** Remembered window for a graph, falling back to the 5s default. */
export function loadWindowMs(graphId, storage) {
  try {
    const raw = storage?.getItem(`${WINDOW_STORAGE_PREFIX}${graphId}`);
    const ms = Number(raw);
    return WINDOW_PRESETS.some(p => p.ms === ms) ? ms : DEFAULT_WINDOW_MS;
  } catch {
    return DEFAULT_WINDOW_MS;   // private mode / storage disabled
  }
}

export function saveWindowMs(graphId, ms, storage) {
  try {
    storage?.setItem(`${WINDOW_STORAGE_PREFIX}${graphId}`, String(ms));
  } catch {
    /* not worth failing a render over */
  }
}
