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
import {
  fetchPhotonShops, enrichFromOsm, dedupeShops, PHOTON_SECONDARY_TAGS,
} from './photon.js';
import { shopsCache as defaultCache } from './shopsCache.js';

/** How many shops get a phone-number lookup up front. */
const ENRICH_HEAD = 12;

// Optional chaining because `import.meta.env` exists only under Vite — the
// test runner imports this module in plain Node, where it is undefined.
const API_BASE = import.meta.env?.VITE_API_URL || 'http://localhost:3000';

/**
 * Our own server first, then the public providers directly.
 *
 * The server does the same search but from ONE address with ONE shared cache,
 * which matters because these are free public services with fair-use limits:
 * during development a single machine bursting searches got blocked outright by
 * Photon, every request then failing at the connection level. Every phone
 * querying them independently is both rude and fragile. It also turns up to
 * fifteen mobile requests (searches + per-shop phone lookups) into one, and the
 * second person to search a district gets the first person's answer instantly.
 *
 * The direct paths remain as fallbacks so the screen still works if our server
 * is unreachable.
 */
export async function fetchShopsBestSource(pos, radiusM) {
  try {
    const token = localStorage.getItem('obd_token');
    const url = `${API_BASE}/api/places/nearby?lat=${pos[0]}&lon=${pos[1]}&radius_m=${radiusM}`;
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.shops) && data.shops.length > 0) {
        // The server already resolved phone numbers for the head of the list.
        return data.shops.map(s => ({ ...s, enrichTried: true }));
      }
    } else {
      console.warn('[Services] server search HTTP', res.status);
    }
  } catch (err) {
    console.warn('[Services] server search unavailable:', err.message);
  }

  // ── Fallbacks: query the providers straight from the phone ────────────────
  try {
    const viaPhoton = await fetchPhotonShops(pos, radiusM);
    if (viaPhoton.length > 0) return viaPhoton;
  } catch (err) {
    console.warn('[Services] Photon failed, falling back to Overpass:', err.message);
  }
  // Overpass carries phone numbers itself, so no enrichment pass is needed.
  const viaOverpass = await fetchNearbyShops(pos, radiusM);
  return viaOverpass.map(s => ({ ...s, enrichTried: true }));
}

/**
 * @param {{cache?: object, fetcher?: (pos:[number,number], radiusM:number)=>Promise<Array>}} deps
 *        Injectable so the behaviour can be tested without a network or a
 *        browser: see __tests__/shops.test.mjs.
 */
export function createShopsService({
  cache = defaultCache,
  fetcher = fetchShopsBestSource,
  enrich = enrichFromOsm,
} = {}) {
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
  /** True when the head of the list still has numbers we have not looked up. */
  function needsEnrichment(shops) {
    return shops.slice(0, ENRICH_HEAD).some(s => !s.enrichTried && !s.phone);
  }

  /**
   * Fill in phone numbers after the list is already on screen. Photon has no
   * tags, so numbers arrive a beat later rather than holding up the search.
   * Silent on failure and re-cached on success.
   */
  function enrichInBackground(pos, radiusM, shops, onEnriched) {
    if (!onEnriched) return;

    Promise.resolve()
      // The less-urgent categories (dealers, car washes, moto) are fetched here
      // rather than up front, so the first paint costs 4 requests instead of 7.
      .then(async () => {
        try {
          const extra = await fetchPhotonShops(pos, radiusM, { tags: PHOTON_SECONDARY_TAGS });
          return extra.length ? dedupeShops([shops, extra]) : shops;
        } catch {
          return shops;   // secondary categories are optional
        }
      })
      .then(async (merged) => (needsEnrichment(merged)
        ? enrich(merged, { max: ENRICH_HEAD })
        : merged))
      .then((finalShops) => {
        if (finalShops === shops) return;   // nothing new to report
        cache.set(pos, radiusM, finalShops);
        onEnriched(finalShops);
      })
      .catch(() => { /* extras and numbers are a bonus; the list already works */ });
  }

  async function loadShops(pos, radiusM = 5000, opts = {}) {
    const { onInstant, onEnriched, force = false } = opts;
    if (!pos) return [];

    if (!force) {
      // An exact, same-day hit for this zoom: no network at all.
      const exact = cache.get(pos, radiusM);
      if (exact) {
        onInstant?.({ shops: exact, ts: Date.now(), stale: false });
        // Cached before its numbers arrived? Finish the job without refetching.
        enrichInBackground(pos, radiusM, exact, onEnriched);
        return exact;
      }

      // Otherwise draw whatever is close enough to be useful, then refresh.
      const paint = cache.getForInstantPaint(pos, radiusM);
      if (paint) {
        onInstant?.({ shops: paint.shops, ts: paint.ts, stale: true });
        try {
          const fresh = await fetchOnce(pos, radiusM);
          enrichInBackground(pos, radiusM, fresh, onEnriched);
          return fresh;
        } catch {
          // The user is looking at real, recent data. Keep it rather than
          // replacing a usable map with an error because a refresh failed.
          return paint.shops;
        }
      }
    }

    const fresh = await fetchOnce(pos, radiusM);
    enrichInBackground(pos, radiusM, fresh, onEnriched);
    return fresh;
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
