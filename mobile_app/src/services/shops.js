/**
 * services/shops.js — the one way to get nearby car services.
 *
 * Owns the whole path: cache → instant paint → network → store. The page just
 * asks for shops and gets called back; it no longer knows about Overpass,
 * retries, or caching.
 *
 * The goal is that opening the Services page almost never waits on the network:
 *
 *   1. PREFETCH. At launch the shops around the last known position are fetched
 *      in the background (App.jsx), using the STORED position so GPS — and the
 *      permission prompt — is never touched. By the time the user taps the tab,
 *      the answer is already cached.
 *   2. INSTANT PAINT. Opening the page draws whatever the cache holds for that
 *      area straight away, even if it was stored at a different zoom level, so
 *      the map is never empty while a request is in flight.
 *   3. REVALIDATE QUIETLY. If what we painted was not an exact match, a refresh
 *      runs behind it and the markers update when it lands. If that refresh
 *      fails, the user keeps the good data instead of getting an error.
 *
 * Why not just make the query faster? Because it is not the query. Measured on
 * one mirror, back to back: 5km/7 tags/200 results took 2.8s, while 2km/2 tags/
 * 40 results took 13.1s. Overpass latency is queue time, so a cold fetch cannot
 * be made to feel instant — it can only be avoided.
 */

import { fetchNearbyShops } from './overpass.js';
import { shopsCache as defaultCache } from './shopsCache.js';

/**
 * @param {{cache?: object, fetcher?: (pos:[number,number], radiusM:number)=>Promise<Array>}} deps
 *        Injectable so the behaviour can be tested without a network or a
 *        browser: see __tests__/shops.test.mjs.
 */
export function createShopsService({ cache = defaultCache, fetcher = fetchNearbyShops } = {}) {
  // In-flight requests keyed by area+radius, so a page opening while the
  // prefetch is still running joins that request instead of starting a second.
  const inFlight = new Map();

  const keyFor = (pos, radiusM) => `${pos[0].toFixed(3)},${pos[1].toFixed(3)}@${radiusM}`;

  function fetchOnce(pos, radiusM) {
    const key = keyFor(pos, radiusM);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const p = fetcher(pos, radiusM)
      .then((shops) => {
        cache.set(pos, radiusM, shops);
        return shops;
      })
      .finally(() => inFlight.delete(key));

    inFlight.set(key, p);
    return p;
  }

  /**
   * Get shops for a position.
   *
   * @param {[number,number]} pos
   * @param {number} radiusM
   * @param {{onInstant?: (p:{shops:Array,ts:number,stale:boolean})=>void, force?: boolean}} [opts]
   *   onInstant — called with cached shops before any network work so the map can
   *               draw immediately. May not be called at all.
   *   force     — skip the cache (the manual refresh button).
   * @returns {Promise<Array>} the freshest shops available.
   */
  async function loadShops(pos, radiusM = 5000, opts = {}) {
    const { onInstant, force = false } = opts;
    if (!pos) return [];

    if (!force) {
      // An exact, same-day hit for this zoom: no network at all.
      const exact = cache.get(pos, radiusM);
      if (exact) {
        onInstant?.({ shops: exact, ts: Date.now(), stale: false });
        return exact;
      }

      // Otherwise draw whatever is close enough to be useful, then refresh.
      const paint = cache.getForInstantPaint(pos, radiusM);
      if (paint) {
        onInstant?.({ shops: paint.shops, ts: paint.ts, stale: true });
        try {
          return await fetchOnce(pos, radiusM);
        } catch {
          // The user is looking at real, recent data. Keep it rather than
          // replacing a usable map with an error because a refresh failed.
          return paint.shops;
        }
      }
    }

    return fetchOnce(pos, radiusM);
  }

  /**
   * Warm the cache in the background. Never throws, never blocks — fire and
   * forget. Skipped when this area is already cached, so repeated calls are free.
   * @returns {boolean} whether a fetch was actually started
   */
  function prefetchShops(pos, radiusM = 5000) {
    if (!pos) return false;
    if (cache.get(pos, radiusM)) return false;
    fetchOnce(pos, radiusM).catch(() => {
      // A failed warm-up is invisible by design; the page retries when opened.
    });
    return true;
  }

  return {
    loadShops,
    prefetchShops,
    stats: () => ({ ...cache.stats(), inFlight: inFlight.size }),
  };
}

const defaultService = createShopsService();

export const loadShops = defaultService.loadShops;
export const prefetchShops = defaultService.prefetchShops;
export const cacheStats = defaultService.stats;
