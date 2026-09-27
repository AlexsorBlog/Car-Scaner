/**
 * The caching system around nearby services: what must and must not hit the
 * network, and what the user sees while it happens.
 *
 * Run: node src/services/__tests__/shops.test.mjs   (from mobile_app/)
 */

import { createShopsService } from '../shops.js';
import { createShopsCache } from '../shopsCache.js';

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

const makeStore = (seed = new Map()) => ({
  map: seed,
  getItem: (k) => (seed.has(k) ? seed.get(k) : null),
  setItem: (k, v) => seed.set(k, String(v)),
});

const KYIV = [50.4501, 30.5234];
const LVIV = [49.8397, 24.0297];
const shopsOf = (n, tag = 's') =>
  Array.from({ length: n }, (_, i) => ({ id: `node/${tag}${i}`, name: `СТО ${tag}${i}`, lat: 50.45, lon: 30.52 }));

/** A fetcher that counts calls and can be made to fail or hang. */
function makeFetcher({ result = shopsOf(5), failWith = null, delayMs = 0 } = {}) {
  const f = async () => {
    f.calls++;
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    if (failWith) throw new Error(failWith);
    return typeof result === 'function' ? result() : result;
  };
  f.calls = 0;
  return f;
}

const freshSetup = (fetcherOpts) => {
  const cache = createShopsCache(makeStore());
  const fetcher = makeFetcher(fetcherOpts);
  return { cache, fetcher, svc: createShopsService({ cache, fetcher }) };
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] A cached area costs no network\n');

{
  const { svc, fetcher, cache } = freshSetup();
  await svc.loadShops(KYIV, 5000);
  check('first load fetches once', fetcher.calls === 1, String(fetcher.calls));
  check('and stores the result', cache.get(KYIV, 5000)?.length === 5);

  const instants = [];
  const again = await svc.loadShops(KYIV, 5000, { onInstant: p => instants.push(p) });
  check('REOPENING THE SAME AREA MAKES NO REQUEST', fetcher.calls === 1, String(fetcher.calls));
  check('and returns the cached shops', again.length === 5);
  check('drawn immediately, not flagged stale',
    instants.length === 1 && instants[0].stale === false);

  await svc.loadShops([50.4525, 30.5270], 5000);
  check('a few streets away also makes no request', fetcher.calls === 1, String(fetcher.calls));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Zoom and a new area do refetch\n');

{
  const { svc, fetcher } = freshSetup();
  await svc.loadShops(KYIV, 5000);
  await svc.loadShops(KYIV, 15000);
  check('zooming out (new radius) fetches again', fetcher.calls === 2, String(fetcher.calls));
  await svc.loadShops(LVIV, 5000);
  check('searching another city fetches again', fetcher.calls === 3, String(fetcher.calls));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Instant paint, then quiet revalidation\n');

{
  // The seed and the refresh must differ, otherwise "painted" and "final" are
  // indistinguishable and the assertion proves nothing.
  let call = 0;
  const { svc, fetcher } = freshSetup({ result: () => (++call === 1 ? shopsOf(5) : shopsOf(9, 'new')) });
  await svc.loadShops(KYIV, 5000);              // seeds the cache at 5km with 5

  const instants = [];
  const final = await svc.loadShops(KYIV, 15000, { onInstant: p => instants.push(p) });
  check('a different zoom still paints something immediately', instants.length === 1);
  check('marked stale so the UI knows a refresh is running',
    instants[0]?.stale === true);
  check('painted BEFORE the network result arrives',
    instants[0].shops.length === 5 && final.length === 9,
    `painted ${instants[0].shops.length}, final ${final.length}`);
  check('the refresh did run', fetcher.calls === 2, String(fetcher.calls));
}

{
  // A refresh that fails must not wipe a usable map.
  const cache = createShopsCache(makeStore());
  const good = createShopsService({ cache, fetcher: makeFetcher({ result: shopsOf(7) }) });
  await good.loadShops(KYIV, 5000);

  const failing = makeFetcher({ failWith: 'Сервіс карт недоступний' });
  const svc = createShopsService({ cache, fetcher: failing });
  const instants = [];
  const result = await svc.loadShops(KYIV, 15000, { onInstant: p => instants.push(p) });
  check('a failed refresh keeps the cached shops instead of erroring',
    result.length === 7 && instants.length === 1, `${result.length}`);
}

{
  // Nothing cached and the network fails: the caller must see the error.
  const { svc } = freshSetup({ failWith: 'boom' });
  let threw = false;
  try { await svc.loadShops(KYIV, 5000); } catch { threw = true; }
  check('with nothing to show, the failure propagates so the page can report it', threw);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] force — the manual refresh button\n');

{
  const { svc, fetcher } = freshSetup();
  await svc.loadShops(KYIV, 5000);
  await svc.loadShops(KYIV, 5000, { force: true });
  check('force bypasses the cache and refetches', fetcher.calls === 2, String(fetcher.calls));
  const instants = [];
  await svc.loadShops(KYIV, 5000, { force: true, onInstant: p => instants.push(p) });
  check('force does not paint stale data first', instants.length === 0);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Prefetch — why the first open is instant\n');

{
  const { svc, fetcher, cache } = freshSetup();
  const started = svc.prefetchShops(KYIV);
  check('prefetch starts a fetch when nothing is cached', started === true);
  await new Promise(r => setTimeout(r, 10));
  check('it fills the cache', cache.get(KYIV, 5000)?.length === 5);

  const instants = [];
  await svc.loadShops(KYIV, 5000, { onInstant: p => instants.push(p) });
  check('OPENING THE PAGE AFTER A PREFETCH MAKES NO REQUEST',
    fetcher.calls === 1, String(fetcher.calls));
  check('and paints straight away', instants.length === 1 && instants[0].stale === false);

  check('prefetching an already-cached area does nothing',
    svc.prefetchShops(KYIV) === false && fetcher.calls === 1);
  check('prefetch with no position is a no-op', svc.prefetchShops(null) === false);
}

{
  // A failed warm-up must be completely silent — it runs at app launch.
  const { svc } = freshSetup({ failWith: 'offline' });
  let unhandled = null;
  const handler = (e) => { unhandled = e; };
  process.on('unhandledRejection', handler);
  svc.prefetchShops(KYIV);
  await new Promise(r => setTimeout(r, 30));
  process.off('unhandledRejection', handler);
  check('a failed prefetch never surfaces an unhandled rejection', unhandled === null,
    String(unhandled));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[6] The page opening mid-prefetch must not double-fetch\n');

{
  const { svc, fetcher } = freshSetup({ delayMs: 40 });
  svc.prefetchShops(KYIV);                       // still in flight
  const shops = await svc.loadShops(KYIV, 5000); // joins it
  check('two requests for the same area collapse into one',
    fetcher.calls === 1, String(fetcher.calls));
  check('and both get the data', shops.length === 5);
}

{
  const { svc, fetcher } = freshSetup({ delayMs: 30 });
  const [a, b, c] = await Promise.all([
    svc.loadShops(KYIV, 5000),
    svc.loadShops(KYIV, 5000),
    svc.loadShops(KYIV, 5000),
  ]);
  check('three concurrent loads make one request',
    fetcher.calls === 1, String(fetcher.calls));
  check('all callers receive the result',
    a.length === 5 && b.length === 5 && c.length === 5);
  check('after settling, a later identical call is served from cache',
    (await svc.loadShops(KYIV, 5000)) && fetcher.calls === 1, String(fetcher.calls));
}

{
  const { svc, fetcher } = freshSetup({ delayMs: 20 });
  await Promise.all([svc.loadShops(KYIV, 5000), svc.loadShops(LVIV, 5000)]);
  check('different areas are NOT collapsed together',
    fetcher.calls === 2, String(fetcher.calls));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[7] Misuse\n');

{
  const { svc, fetcher } = freshSetup();
  check('no position returns an empty list without fetching',
    (await svc.loadShops(null)).length === 0 && fetcher.calls === 0);
  const s = svc.stats();
  check('stats report cache and in-flight state',
    typeof s.entries === 'number' && typeof s.inFlight === 'number', JSON.stringify(s));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
