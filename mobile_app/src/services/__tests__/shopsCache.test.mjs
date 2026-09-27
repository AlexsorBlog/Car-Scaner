/**
 * Reopening the Services page at the same place on the same day must not
 * re-request anything; zooming or searching elsewhere must.
 *
 * Run: node src/services/__tests__/shopsCache.test.mjs   (from mobile_app/)
 */

import {
  createShopsCache, toleranceFor, distanceM, MAX_AGE_MS, MAX_ENTRIES,
} from '../shopsCache.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// A stand-in for localStorage that we can also survive "restarting" the app with.
const makeStore = (seed = new Map()) => {
  const m = seed;
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
};

const KYIV = [50.4501, 30.5234];
const shopsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `node/${i}`, name: `СТО ${i}`, lat: 50.45, lon: 30.52 }));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The same place on the same day costs nothing\n');

let store = makeStore();
let cache = createShopsCache(store);

check('nothing cached at first', cache.get(KYIV, 5000) === null);

cache.set(KYIV, 5000, shopsOf(12));
check('a hit right after storing', cache.get(KYIV, 5000)?.length === 12);

// The old cache was in-memory: closing the app lost it. This is the key fix.
const survived = createShopsCache(makeStore(store.map));
check('CACHE SURVIVES AN APP RESTART (was in-memory before)',
  survived.get(KYIV, 5000)?.length === 12);

check('a few streets away still hits — same area, no refetch',
  cache.get([50.4525, 30.5270], 5000)?.length === 12,
  `${Math.round(distanceM(KYIV, [50.4525, 30.5270]))}m away`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Zoom and a different area must refetch\n');

check('a different radius (zoom) is a miss', cache.get(KYIV, 15000) === null);
check('a different city is a miss',
  cache.get([49.8397, 24.0297], 5000) === null);
check('just outside the tolerance is a miss',
  cache.get([50.4501 + 0.05, 30.5234], 5000) === null,
  `${Math.round(distanceM(KYIV, [50.5001, 30.5234]))}m away`);

check('tolerance scales with the search radius',
  toleranceFor(2000) < toleranceFor(15000));
check('tolerance is capped so results stay roughly centred',
  toleranceFor(100000) <= 1500, String(toleranceFor(100000)));
check('tolerance has a floor for tiny radii', toleranceFor(100) >= 300);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Expiry\n');

const oldStore = makeStore();
const oldCache = createShopsCache(oldStore);
oldCache.set(KYIV, 5000, shopsOf(3));
// Age the stored entry past the window.
const aged = JSON.parse(oldStore.getItem('carsense_shops_cache_v1'));
aged[0].ts = Date.now() - (MAX_AGE_MS + 60_000);
oldStore.setItem('carsense_shops_cache_v1', JSON.stringify(aged));
check('an entry older than the window is not served',
  createShopsCache(oldStore).get(KYIV, 5000) === null);

const freshEnough = JSON.parse(oldStore.getItem('carsense_shops_cache_v1'));
freshEnough[0].ts = Date.now() - (MAX_AGE_MS - 60_000);
oldStore.setItem('carsense_shops_cache_v1', JSON.stringify(freshEnough));
check('an entry just inside the window is still served',
  createShopsCache(oldStore).get(KYIV, 5000)?.length === 3);
check('the window is a full day, so same-day reopens always hit',
  MAX_AGE_MS >= 24 * 60 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Instant paint — show something now, refresh behind it\n');

store = makeStore();
cache = createShopsCache(store);
cache.set(KYIV, 5000, shopsOf(9));

const paint = cache.getForInstantPaint(KYIV, 15000);
check('a different zoom still gives something to draw immediately',
  paint?.shops.length === 9, JSON.stringify(paint && { n: paint.shops.length, stale: paint.stale }));
check('and it is flagged stale so the caller knows to revalidate',
  paint?.stale === true);
check('it reports when it was captured, so the UI can say so',
  typeof paint?.ts === 'number' && paint.ts > 0);

const exact = cache.getForInstantPaint(KYIV, 5000);
check('an exact-radius hit is not flagged stale', exact?.stale === false);
check('nothing nearby yields null rather than someone else\'s city',
  cache.getForInstantPaint([49.8397, 24.0297], 5000) === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Several areas, bounded\n');

store = makeStore();
cache = createShopsCache(store);
cache.set(KYIV, 5000, shopsOf(5));
cache.set([49.8397, 24.0297], 5000, shopsOf(7));   // Lviv
cache.set([46.4825, 30.7233], 5000, shopsOf(4));   // Odesa
check('panning between districts/cities keeps all of them cached',
  cache.get(KYIV, 5000)?.length === 5
  && cache.get([49.8397, 24.0297], 5000)?.length === 7
  && cache.get([46.4825, 30.7233], 5000)?.length === 4);
check('all three are stored', cache.stats().entries === 3, JSON.stringify(cache.stats()));

// Re-storing the same area replaces rather than accumulates.
cache.set(KYIV, 5000, shopsOf(6));
check('re-fetching the same area replaces its entry, not duplicates it',
  cache.stats().entries === 3 && cache.get(KYIV, 5000)?.length === 6,
  JSON.stringify(cache.stats()));

store = makeStore();
cache = createShopsCache(store);
for (let i = 0; i < MAX_ENTRIES + 8; i++) {
  cache.set([50 + i * 0.5, 30 + i * 0.5], 5000, shopsOf(1));
}
check('storage cannot grow without bound',
  cache.stats().entries <= MAX_ENTRIES, `${cache.stats().entries}`);
check('the most recent area is kept when trimming',
  cache.get([50 + (MAX_ENTRIES + 7) * 0.5, 30 + (MAX_ENTRIES + 7) * 0.5], 5000)?.length === 1);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] Hostile storage must never break the page\n');

const corrupt = makeStore(new Map([['carsense_shops_cache_v1', '{not json']]));
check('corrupted cache data reads as empty, not a crash',
  createShopsCache(corrupt).get(KYIV, 5000) === null);

const wrongShape = makeStore(new Map([['carsense_shops_cache_v1', '{"a":1}']]));
check('unexpected shape reads as empty',
  createShopsCache(wrongShape).get(KYIV, 5000) === null);

const junkEntries = makeStore(new Map([['carsense_shops_cache_v1',
  JSON.stringify([{ pos: null, shops: 'nope', ts: Date.now() }, { ts: Date.now() }])]]));
check('malformed entries are skipped',
  createShopsCache(junkEntries).get(KYIV, 5000) === null);

const throwing = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('quota'); },
};
const blocked = createShopsCache(throwing);
check('storage that throws on read is survivable', blocked.get(KYIV, 5000) === null);
blocked.set(KYIV, 5000, shopsOf(2));   // must not throw
check('storage that throws on write is survivable', true);

const noStore = createShopsCache(null);
check('no storage at all is survivable',
  noStore.get(KYIV, 5000) === null && noStore.stats().entries === 0);

cache.clear();
check('clear() empties the cache', cache.stats().entries === 0);
check('bad input is ignored',
  (cache.set(null, 5000, shopsOf(1)), cache.set(KYIV, 5000, null), cache.stats().entries === 0));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
