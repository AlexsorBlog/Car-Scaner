/**
 * services/shopsCache.js — persistent cache of nearby car services.
 *
 * Replaces a single-entry, in-memory, 5-minute cache. That one lost everything
 * when the app was closed and evicted itself the moment the user panned away and
 * back, so almost every visit paid a full Overpass round trip.
 *
 * Why this matters more than making the query cheaper: Overpass latency is
 * queue time, not query cost. Measured on one mirror, back to back:
 *
 *     5km / 7 tags / limit 200  ->  200 results in  2.8s
 *     2km / 2 tags / limit 40   ->    3 results in 13.1s
 *
 * A smaller request was over four times SLOWER. So there is no query shape that
 * makes a cold fetch feel instant — only not having to make one does. Hence a
 * cache that survives restarts, holds several areas, and is allowed to serve
 * slightly stale data immediately while a refresh happens behind it.
 *
 * Matching rules, which map onto how people actually use the page:
 *   - reopening at the same place on the same day  -> hit (no request)
 *   - walking/driving a few streets                -> hit (proximity tolerance)
 *   - zooming, i.e. changing the radius            -> miss (different radius)
 *   - searching a different area                   -> miss (too far away)
 */

const STORAGE_KEY = 'carsense_shops_cache_v1';

/** Same-day freshness. Shop data barely changes; this is about not re-querying. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Keep a handful of areas so panning between two districts stops refetching. */
export const MAX_ENTRIES = 16;

/**
 * How far the user may have moved and still reuse an entry. Scaled to the search
 * radius (a 15km search tolerates more drift than a 2km one) but never more than
 * 1.5km, or results would be noticeably off-centre.
 */
export function toleranceFor(radiusM) {
  return Math.min(1500, Math.max(300, radiusM * 0.15));
}

const R_EARTH_KM = 6371;

export function distanceM([lat1, lon1], [lat2, lon2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a))) * 1000;
}

/**
 * @param {object} [storage] anything with getItem/setItem (defaults to
 *        localStorage when available). Injectable so it can be tested.
 */
export function createShopsCache(storage) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);

  const read = () => {
    try {
      const raw = store?.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupted or unreadable (private mode, cleared site data) — start fresh
      // rather than letting the page fail to load.
      return [];
    }
  };

  const write = (entries) => {
    try {
      store?.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // Quota exceeded or storage disabled. Caching is an optimisation; never
      // break the page over it.
    }
  };

  return {
    /**
     * Best entry for this position/radius, or null.
     * @param {[number,number]} pos
     * @param {number} radiusM
     * @param {{maxAgeMs?:number, anyRadius?:boolean}} [opts]
     *        anyRadius — accept an entry recorded at a different zoom level.
     *        Used for the instant first paint, where showing roughly-right
     *        markers immediately beats an empty map.
     */
    find(pos, radiusM, opts = {}) {
      if (!pos) return null;
      const { maxAgeMs = MAX_AGE_MS, anyRadius = false } = opts;
      const now = Date.now();
      const tol = toleranceFor(radiusM);

      const candidates = read()
        .filter(e => Array.isArray(e?.shops) && Array.isArray(e?.pos))
        .filter(e => now - (e.ts || 0) <= maxAgeMs)
        .filter(e => (anyRadius ? true : e.radiusM === radiusM))
        .map(e => ({ entry: e, dist: distanceM(pos, e.pos) }))
        .filter(x => x.dist <= (anyRadius ? Math.max(tol, toleranceFor(x.entry.radiusM)) : tol))
        // Closest first, then freshest — the most representative entry.
        .sort((a, b) => a.dist - b.dist || b.entry.ts - a.entry.ts);

      return candidates.length ? candidates[0].entry : null;
    },

    /** Shops for an exact-radius, in-tolerance, same-day hit. */
    get(pos, radiusM, maxAgeMs = MAX_AGE_MS) {
      return this.find(pos, radiusM, { maxAgeMs })?.shops ?? null;
    },

    /**
     * Anything usable for an immediate paint, including a different zoom level.
     * Returns { shops, ts, radiusM, stale } so the caller can decide whether to
     * revalidate and can tell the user how old it is.
     */
    getForInstantPaint(pos, radiusM) {
      const entry = this.find(pos, radiusM, { anyRadius: true });
      if (!entry) return null;
      return {
        shops: entry.shops,
        ts: entry.ts,
        radiusM: entry.radiusM,
        stale: entry.radiusM !== radiusM,
      };
    },

    set(pos, radiusM, shops) {
      if (!pos || !Array.isArray(shops)) return;
      const entries = read()
        // Replace any entry for effectively the same area+zoom instead of piling
        // up near-duplicates.
        .filter(e => !(e.radiusM === radiusM
          && Array.isArray(e.pos)
          && distanceM(pos, e.pos) <= toleranceFor(radiusM) / 2));

      // Newest goes to the FRONT and the tail is trimmed, so recency is a
      // property of position rather than of the timestamp. Sorting by ts looked
      // equivalent but was not: two writes inside the same millisecond compare
      // equal, and a stable sort then left the newest entry last — exactly the
      // one that got trimmed. Panning quickly could evict what just arrived.
      entries.unshift({ pos: [pos[0], pos[1]], radiusM, ts: Date.now(), shops });
      write(entries.slice(0, MAX_ENTRIES));
    },

    /** Entries currently held (diagnostics/tests). */
    stats() {
      const now = Date.now();
      const all = read();
      return {
        entries: all.length,
        fresh: all.filter(e => now - (e.ts || 0) <= MAX_AGE_MS).length,
        shops: all.reduce((n, e) => n + (e.shops?.length || 0), 0),
      };
    },

    clear() {
      write([]);
    },
  };
}

export const shopsCache = createShopsCache();
