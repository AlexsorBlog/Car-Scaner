/**
 * services/geoService.js — app-lifetime GPS watch.
 *
 * The location watch used to live inside ServicesPage's useEffect. Switching
 * tabs unmounts that page, so the cleanup cleared the watch and threw away the
 * last known position — coming back to the map meant a cold restart: spinner,
 * permission round-trip, and 5-30s of waiting for a fresh fix, every single
 * time. On a moving car that also meant losing the track.
 *
 * Holding the watch at module scope instead means:
 *   - the GPS watch keeps running while the user is on other tabs
 *   - returning to the map shows the last known position instantly
 *   - only ONE watch exists no matter how many components subscribe
 *
 * The watch is deliberately NOT stopped on unsubscribe. It stops only when
 * stop() is called explicitly (logout), because tab switching is the exact
 * case we're keeping it alive for.
 */

import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';

class GeoService {
  constructor() {
    this.position = null;     // [lat, lon] of the most recent real fix
    this.error = null;        // human-readable reason we have no fix
    this.lastFixAt = null;
    this._listeners = new Set();
    this._starting = null;    // in-flight start(), so concurrent calls share it
    this._webWatchId = null;
    this._nativeWatchId = null;
  }

  get isWatching() {
    return this._webWatchId != null || this._nativeWatchId != null;
  }

  _emit() {
    for (const fn of this._listeners) {
      try { fn({ position: this.position, error: this.error, lastFixAt: this.lastFixAt }); }
      catch (err) { console.warn('[geo] listener failed:', err); }
    }
  }

  _onFix(lat, lon) {
    this.position = [lat, lon];
    this.error = null;        // a real fix supersedes any earlier failure
    this.lastFixAt = Date.now();
    this._emit();
  }

  _onFailure(message) {
    // Never clobber a good position with an error — a transient failure while
    // driving through a tunnel shouldn't blank the map.
    this.error = message;
    this._emit();
  }

  /**
   * Subscribe to position updates. The callback fires immediately with the
   * cached state, so a remounting page renders the last known position on its
   * first paint instead of a spinner.
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    this._listeners.add(fn);
    fn({ position: this.position, error: this.error, lastFixAt: this.lastFixAt });
    return () => this._listeners.delete(fn);
  }

  /** Begin watching. Idempotent — safe to call from every mount. */
  async start() {
    if (this.isWatching) return true;
    if (this._starting) return this._starting;

    this._starting = (async () => {
      try {
        if (Capacitor.isNativePlatform()) {
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            throw new Error('Дозвіл на геолокацію відхилено');
          }
          this._nativeWatchId = await Geolocation.watchPosition(
            { enableHighAccuracy: true },
            (pos, err) => {
              if (err) { console.warn('[geo] watch error:', err); return; }
              if (pos) this._onFix(pos.coords.latitude, pos.coords.longitude);
            },
          );
        } else if (navigator.geolocation) {
          this._webWatchId = navigator.geolocation.watchPosition(
            (p) => this._onFix(p.coords.latitude, p.coords.longitude),
            (err) => this._onFailure(err?.message || 'Не вдалось визначити локацію'),
            { enableHighAccuracy: true },
          );
        } else {
          throw new Error('Геолокація не підтримується на цьому пристрої');
        }
        return true;
      } catch (err) {
        this._onFailure(err.message || 'Не вдалось визначити локацію');
        return false;
      } finally {
        this._starting = null;
      }
    })();

    return this._starting;
  }

  /** Explicit teardown — logout, not unmount. */
  stop() {
    if (this._webWatchId != null) {
      try { navigator.geolocation.clearWatch(this._webWatchId); } catch { /* already gone */ }
      this._webWatchId = null;
    }
    if (this._nativeWatchId != null) {
      Geolocation.clearWatch({ id: this._nativeWatchId }).catch(() => {});
      this._nativeWatchId = null;
    }
  }
}

export const geoService = new GeoService();

/**
 * Shops cache, kept for the same reason as the position: returning to the map
 * shouldn't re-hit Overpass and show an empty map while it loads. Keyed by a
 * coarse position so a genuinely different area still triggers a fresh query.
 */
export const shopsCache = {
  key: null,
  shops: [],
  fetchedAt: 0,
  keyFor([lat, lon], radiusM) {
    // ~1km granularity — moving a couple of streets reuses the cache, driving
    // to another district does not.
    return `${lat.toFixed(2)},${lon.toFixed(2)}@${radiusM}`;
  },
  get(pos, radiusM, maxAgeMs = 5 * 60 * 1000) {
    if (!pos) return null;
    if (this.key !== this.keyFor(pos, radiusM)) return null;
    if (Date.now() - this.fetchedAt > maxAgeMs) return null;
    return this.shops;
  },
  set(pos, radiusM, shops) {
    if (!pos) return;
    this.key = this.keyFor(pos, radiusM);
    this.shops = shops;
    this.fetchedAt = Date.now();
  },
};
