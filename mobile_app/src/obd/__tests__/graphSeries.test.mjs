/**
 * Graph behaviour the user asked for, pinned:
 *   - Y axis is fixed per metric and NEVER depends on the visible data
 *   - fuel graphs read in л/100км, not л/год
 *   - swiping past the end of the data finds the real data either side
 *
 * Run: node src/obd/__tests__/graphSeries.test.mjs   (from mobile_app/)
 */

import {
  yAxisFor, svgYFor, toL100kmSeries, findNeighborPoint, panOffsetCentering,
  formatPointDate, WINDOW_PRESETS, DEFAULT_WINDOW_MS, loadWindowMs, saveWindowMs,
  L100_CEILING,
} from '../graphSeries.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The Y axis never moves\n');

const speedAxis = yAxisFor('SPEED');
check('speed axis is 0–200 regardless of what is on screen',
  speedAxis.min === 0 && speedAxis.max === 200, JSON.stringify(speedAxis));
check('axis ticks are whole, evenly spaced numbers',
  speedAxis.ticks.join(',') === '0,40,80,120,160,200', speedAxis.ticks.join(','));
check('the same metric always returns the identical axis',
  JSON.stringify(yAxisFor('SPEED')) === JSON.stringify(yAxisFor('SPEED')));
check('history-key spelling resolves to the same axis as the graph id',
  JSON.stringify(yAxisFor('speed')) === JSON.stringify(yAxisFor('SPEED')));
check('rpm axis reaches redline', yAxisFor('RPM').max === 8000);
check('coolant axis covers overheating', yAxisFor('COOLANT_TEMP').max === 150);
check('fuel axis is a л/100км range, not a л/год one', yAxisFor('FUEL_RATE').max === 30);
check('an unknown metric still gets a usable axis',
  yAxisFor('SOMETHING_NEW').max === 100 && yAxisFor('SOMETHING_NEW').ticks.length > 1);
check('yAxisFor takes no data argument at all — scaling cannot depend on it',
  yAxisFor.length === 1);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1b] Points stay inside the chart on a fixed axis\n');

check('a value at the axis minimum sits on the bottom edge',
  svgYFor(0, speedAxis) === 100);
check('a value at the axis maximum sits on the top edge',
  svgYFor(200, speedAxis) === 0);
check('the midpoint is halfway up', svgYFor(100, speedAxis) === 50);
check('a reading ABOVE the fixed axis is pinned to the top, not drawn outside',
  svgYFor(350, speedAxis) === 0, String(svgYFor(350, speedAxis)));
check('a reading BELOW the axis is pinned to the bottom',
  svgYFor(-20, speedAxis) === 100, String(svgYFor(-20, speedAxis)));
check('rpm past the redline still renders inside the box',
  svgYFor(12000, yAxisFor('RPM')) === 0);
check('a non-numeric value does not produce NaN coordinates',
  svgYFor(undefined, speedAxis) === 100);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Fuel history converts to л/100км\n');

const t0 = 1_700_000_000_000;
const fuel  = [{ t: t0, v: 10 }, { t: t0 + 1000, v: 10 }, { t: t0 + 2000, v: 6 }];
const speed = [{ t: t0, v: 100 }, { t: t0 + 1000, v: 50 }, { t: t0 + 2000, v: 0 }];
const conv = toL100kmSeries(fuel, speed);

check('10 л/год at 100 км/год is 10 л/100км',
  conv[0]?.v === 10, JSON.stringify(conv[0]));
check('10 л/год at 50 км/год is 20 л/100км',
  conv[1]?.v === 20, JSON.stringify(conv[1]));

// The car burns fuel at a red light. Dropping that sample hid real consumption;
// per-distance it is off the top of the scale, so that is what gets reported.
check('a sample taken while stopped is KEPT, not dropped',
  conv.length === 3, JSON.stringify(conv));
check('idling reads at the ceiling — burning fuel, covering no distance',
  conv[2]?.v === L100_CEILING, JSON.stringify(conv[2]));
check('every fuel sample yields a point — no gaps in the fuel graph',
  toL100kmSeries(fuel, speed).length === fuel.length);
check('timestamps are preserved so points stay aligned with the time axis',
  conv[0].t === t0 && conv[1].t === t0 + 1000 && conv[2].t === t0 + 2000);

check('crawling in traffic is a real number, not the ceiling',
  toL100kmSeries([{ t: t0, v: 1 }], [{ t: t0, v: 4 }])[0].v === 25,
  JSON.stringify(toL100kmSeries([{ t: t0, v: 1 }], [{ t: t0, v: 4 }])));
check('overrun fuel cut-off (0 л/год while rolling) reads 0, not the ceiling',
  toL100kmSeries([{ t: t0, v: 0 }], [{ t: t0, v: 60 }])[0].v === 0);
check('a thirsty reading is capped at the ceiling rather than spiking the axis',
  toL100kmSeries([{ t: t0, v: 40 }], [{ t: t0, v: 1 }])[0].v === L100_CEILING);

check('fuel samples with no nearby speed reading are dropped',
  toL100kmSeries([{ t: t0, v: 10 }], [{ t: t0 + 60_000, v: 90 }]).length === 0);
check('a speed sample within the tolerance window is still paired',
  toL100kmSeries([{ t: t0, v: 10 }], [{ t: t0 + 1500, v: 100 }]).length === 1);
check('empty inputs produce an empty series, never a crash',
  toL100kmSeries([], []).length === 0 && toL100kmSeries(null, null).length === 0);
check('unsorted input is handled',
  toL100kmSeries(
    [{ t: t0 + 1000, v: 10 }, { t: t0, v: 10 }],
    [{ t: t0 + 1000, v: 100 }, { t: t0, v: 100 }],
  ).length === 2);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Swiping off the end of the data\n');

const pts = [
  { t: t0, v: 1 },
  { t: t0 + 10_000, v: 2 },
  { t: t0 + 900_000, v: 3 },
];

check('swiping left finds the last point before the empty view',
  findNeighborPoint(pts, t0 + 500_000, 'past')?.t === t0 + 10_000);
check('swiping right finds the next point ahead',
  findNeighborPoint(pts, t0 + 500_000, 'future')?.t === t0 + 900_000);
check('nothing further back returns null (nowhere to jump)',
  findNeighborPoint(pts, t0 - 1, 'past') === null);
check('nothing further ahead returns null',
  findNeighborPoint(pts, t0 + 900_001, 'future') === null);
check('an empty history is safe', findNeighborPoint([], t0, 'past') === null);

const now = t0 + 1_000_000;
const off = panOffsetCentering(t0 + 900_000, 60_000, now);
check('jumping centres the target point in the window',
  off === now - (t0 + 900_000) - 30_000, String(off));
check('never pans into the future', panOffsetCentering(now + 999_999, 60_000, now) === 0);

check('the jump label shows a readable stamp',
  typeof formatPointDate(t0) === 'string' && formatPointDate(t0).length > 0,
  formatPointDate(t0));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Window presets and persistence\n');

check('5 seconds is the default window', DEFAULT_WINDOW_MS === 5000);
check('a 5 СЕК preset is offered', WINDOW_PRESETS.some(p => p.ms === 5000));
check('longer windows are still available for history',
  WINDOW_PRESETS.some(p => p.ms === 24 * 60 * 60 * 1000));

const mem = new Map();
const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };

check('with nothing saved, a graph opens at 5 seconds',
  loadWindowMs('SPEED', storage) === 5000);
saveWindowMs('SPEED', 60_000, storage);
check('a chosen window is remembered for that graph',
  loadWindowMs('SPEED', storage) === 60_000);
check('the choice is per-graph, not global',
  loadWindowMs('RPM', storage) === 5000);
saveWindowMs('SPEED', 123, storage);
check('a bogus stored value falls back to the default',
  loadWindowMs('SPEED', storage) === 5000);

const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
check('storage being unavailable does not break the graph',
  loadWindowMs('SPEED', throwing) === 5000);
saveWindowMs('SPEED', 5000, throwing);   // must not throw
check('saving with storage unavailable does not throw', true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
