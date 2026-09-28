// ServicesPage.jsx — full replacement

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import { geoService } from '../services/geoService.js';
import { loadShops as loadShopsService } from '../services/shops.js';
import { Capacitor } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const KYIV_FALLBACK = [50.4501, 30.5234];

// ── Map tiles ─────────────────────────────────────────────────────────────────
// We used to use CARTO's dark basemap. CARTO now requires an API key and serves
// every tile stamped with a diagonal "API KEY REQUIRED — carto.com/basemaps/apikey"
// watermark — verified by fetching a tile directly and looking at it. The map
// still drew, which is why it looked like a rendering glitch rather than an
// account problem, and it got more obvious when zoomed in because more tiles
// are on screen.
//
// Dark basemap = keyless raster tiles + a CSS filter (.dark-tiles in App.css).
//
// A real dark VECTOR style (OpenFreeMap) was tried and reverted: maplibre-gl
// loads its renderer in a web worker, which failed to start here ("Worker failed
// to load"), and a WebGL map inside a Capacitor WebView is a lot of moving parts
// to bet a working screen on. Raster tiles always draw.
//
// Provider notes, all verified by fetching a tile and looking at it:
//   - CARTO dark_all  — every tile is now stamped "API KEY REQUIRED". Unusable.
//   - Stadia dark     — HTTP 401 without a key.
//   - Esri Dark Gray  — keyless and genuinely dark, but ArcGIS terms are murky
//                       for commercial use. Set VITE_MAP_TILE_URL to use it:
//     https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}
//   - OSM standard    — keyless, reliable, light; darkened in CSS. The default.
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL
  || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = import.meta.env.VITE_MAP_TILE_ATTRIBUTION
  || '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// A provider that already ships dark tiles should skip the CSS inversion.
const TILES_NEED_DARKENING = import.meta.env.VITE_MAP_TILE_DARK !== 'preset';

// ── 1. NEW COMPONENT: Fix Map Sizing ──────────────────────────────────────────
// Цей компонент вирішує проблему "чорного екрану", примусово змушуючи
// Leaflet перемалювати тайли після того, як контейнер отримав свої розміри.
function FixMapRender() {
  const map = useMap();
  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 400);
    return () => clearTimeout(timer);
  }, [map]);
  return null;
}

// ── Map centering helper ───────────────────────────────────────────────────────
function RecenterMap({ position }) {
  const map = useMap();
  const lastPos = useRef(null);
  useEffect(() => {
    if (!position) return;
    const same = lastPos.current &&
      lastPos.current[0] === position[0] &&
      lastPos.current[1] === position[1];
    if (!same) {
      map.flyTo(position, map.getZoom(), { animate: true, duration: 0.8 });
      lastPos.current = position;
    }
  }, [position, map]);
  return null;
}

// ── Map drag/move event listener ──────────────────────────────────────────────
function MapEvents({ onBoundsChange, onUserDrag }) {
  const map = useMap();

  useEffect(() => {
    let timeout;
    const handleMoveEnd = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const center = map.getCenter();
        onBoundsChange([center.lat, center.lng]);
      }, 800);
    };
    // Fires only on a real user-initiated drag — NOT on our own
    // programmatic flyTo() — this is how we know to stop auto-following.
    const handleDragStart = () => onUserDrag?.();

    map.on('moveend', handleMoveEnd);
    map.on('zoomend', handleMoveEnd);
    map.on('dragstart', handleDragStart);

    return () => {
      map.off('moveend', handleMoveEnd);
      map.off('zoomend', handleMoveEnd);
      map.off('dragstart', handleDragStart);
      clearTimeout(timeout);
    };
  }, [map, onBoundsChange, onUserDrag]);

  return null;
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const userIcon = new L.DivIcon({
  className: '',
  html: `<div style="width:20px;height:20px;background:#3b82f6;border-radius:50%;border:3px solid white;box-shadow:0 0 14px rgba(59,130,246,0.9)"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

const makeShopIcon = (isClosest, isPartner) => {
  const size     = isClosest ? 38 : 30;
  const color    = isClosest ? '#3b82f6' : isPartner ? '#f59e0b' : '#6b7280';
  const stroke   = isClosest ? '#3b82f6' : isPartner ? '#f59e0b' : '#9ca3af';
  const glow     = isClosest
    ? 'rgba(59,130,246,0.8)'
    : isPartner ? 'rgba(245,158,11,0.5)' : 'rgba(0,0,0,0.3)';
  const glowPx   = isClosest ? 16 : 8;
  const iconSize = isClosest ? 18 : 14;
  const dot      = isClosest
    ? '<div style="width:6px;height:6px;background:#3b82f6;border-radius:50%;margin-top:2px;box-shadow:0 0 6px #3b82f6"></div>'
    : '';

  const html = [
    '<div style="display:flex;flex-direction:column;align-items:center">',
      '<div style="',
        'width:' + size + 'px;',
        'height:' + size + 'px;',
        'background:#111318;',
        'border-radius:50%;',
        'border:2px solid ' + color + ';',
        'display:flex;align-items:center;justify-content:center;',
        'box-shadow:0 0 ' + glowPx + 'px ' + glow + ';',
      '">',
        '<svg width="' + iconSize + '" height="' + iconSize + '" fill="none" stroke="' + stroke + '" viewBox="0 0 24 24">',
          '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"',
            ' d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>',
        '</svg>',
      '</div>',
      dot,
    '</div>',
  ].join('');

  return new L.DivIcon({
    className: '',
    html,
    iconSize:   isClosest ? [38, 46] : [30, 30],
    iconAnchor: isClosest ? [19, 46] : [15, 30],
  });
};

// ── Distance helper (Haversine) ───────────────────────────────────────────────
function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Overpass query — the free public instance occasionally times out under
// load (a real, external reliability issue, not a query bug); retry once
// before giving up instead of silently returning nothing ─────────────────────
// Global Overpass instances, tried in order. The free public API is routinely
// overloaded — measured directly: overpass-api.de answered fine earlier in
// development and later timed out completely on the same query, which is
// exactly the "Не вдалося завантажити СТО" the user hit with GPS working fine.
// One endpoint is therefore a single point of failure.
//
// Deliberately GLOBAL instances only. overpass.osm.ch was tested and rejected:
// it answers HTTP 200 in 0.4s but carries Switzerland data only, so a Kyiv
// query returns zero elements — which would show as "no service stations
// nearby" and be far more misleading than an outright error.
// Endpoint list and timeout live in services/overpass.js so they can be
// asserted in tests — two of the three mirrors used here were measured dead,
// and the old 8000ms abort was SHORTER than the working mirror's real 8.1s
// response, cancelling requests that were about to succeed.

// fetchNearbyShops now lives in services/overpass.js (shared with the
// background prefetch in services/shops.js).

// ── Open native maps ──────────────────────────────────────────────────────────
function openMapsRoute(userPos, shop) {
  const dest = `${shop.lat},${shop.lon}`;
  const label = encodeURIComponent(shop.name);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    window.open(`maps://?daddr=${dest}&dirflg=d`, '_system');
  } else {
    const geoIntent = `geo:${dest}?q=${dest}(${label})`;
    const webFallback = `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
    if (Capacitor.isNativePlatform()) {
      window.open(geoIntent, '_system');
    } else {
      window.open(webFallback, '_blank');
    }
  }
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ServicesPage() {
  const [position, setPosition]           = useState(null);
  const [shops, setShops]                 = useState([]);
  const [selectedShop, setSelectedShop]   = useState(null);
  const [closestShop, setClosestShop]     = useState(null);
  const [isLocating, setIsLocating]       = useState(true);
  const [isFetchingShops, setIsFetchingShops] = useState(false);
  const [shopsError, setShopsError]       = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [mapCenter, setMapCenter]         = useState(null);
  // Auto-follow the live GPS dot until the user manually drags the map —
  // exactly like every other navigation/maps app.
  const [isFollowing, setIsFollowing]     = useState(true);

  const isFollowingRef = useRef(true);
  useEffect(() => { isFollowingRef.current = isFollowing; }, [isFollowing]);

  const hasFetchedInitialRef = useRef(false);

  // ── Load shops around a point (initial load, retry, radius expand) ──────────
  // Caching, the instant first paint and the network retries all live in
  // services/shops.js. This only decides what to do with the results.
  const loadShops = useCallback(async (pos, radiusM = 5000, { force = false } = {}) => {
    const applyShops = (list) => {
      const withDist = list.map(s => ({
        ...s,
        distKm: haversineKm(pos, [s.lat, s.lon]),
      })).sort((a, b) => a.distKm - b.distKm);
      setShops(withDist);
      if (withDist.length > 0) {
        setClosestShop(withDist[0]);
        setSelectedShop(withDist[0]);
      }
      return withDist;
    };

    setShopsError(null);
    let painted = false;
    try {
      const found = await loadShopsService(pos, radiusM, {
        force,
        // Draw cached results the moment they are available, so the map is
        // never empty while a request is in flight. `stale` means the entry
        // came from a different zoom and a refresh is running behind it.
        onInstant: ({ shops: cached, stale }) => {
          applyShops(cached);
          painted = true;
          setIsFetchingShops(stale);
        },
        // Phone numbers arrive a beat after the list: the search index has no
        // tags, so they are looked up per shop once the map is already drawn.
        onEnriched: (withContacts) => {
          applyShops(withContacts);
          setSelectedShop((prev) => (prev
            ? withContacts.find(s => s.id === prev.id) || prev
            : prev));
        },
      });
      if (!painted) setIsFetchingShops(true);
      applyShops(found);
    } catch (err) {
      console.error('[Services] loadShops failed:', err);
      // Only surface an error if there is nothing on screen — replacing a
      // usable map with an error message because a refresh failed is worse.
      if (!painted) {
        setShopsError(err.message || 'Не вдалося завантажити СТО');
        setShops([]);
      }
    } finally {
      setIsFetchingShops(false);
    }
  }, []);

  // ── Live location watch — dot follows the real position continuously ────────
  // Subscribe to the app-lifetime GPS watch rather than owning one. The watch
  // keeps running while the user is on other tabs, so coming back here renders
  // the last known position immediately instead of restarting the whole
  // permission + acquisition cycle. See services/geoService.js.
  useEffect(() => {
    const unsubscribe = geoService.subscribe(({ position: pos, error }) => {
      if (pos) {
        setPosition(pos);
        setIsLocating(false);
        setLocationError(null);
        if (isFollowingRef.current) setMapCenter(pos);
      } else if (error) {
        // Only fall back to a placeholder if we have never had a real fix —
        // a transient error must not throw away a good position.
        setLocationError(error);
        setPosition((prev) => prev ?? KYIV_FALLBACK);
        setMapCenter((prev) => prev ?? KYIV_FALLBACK);
        setIsLocating(false);
      }
    });
    geoService.start();
    // Deliberately does NOT stop the watch — that's the whole point.
    return unsubscribe;
  }, []);

  // ── Fetch shops once, on the first position fix only — further fetches
  // happen as the user pans the map (handleMapBoundsChange below) ─────────────
  useEffect(() => {
    if (!position || hasFetchedInitialRef.current) return;
    hasFetchedInitialRef.current = true;
    loadShops(position);
  }, [position, loadShops]);

  // ── Recenter to user — re-enables auto-follow too ────────────────────────────
  const recenter = useCallback(() => {
    setIsFollowing(true);
    if (position) setMapCenter(position);
  }, [position]);

  // ── Filter ────────────────────────────────────────────────────────────────
  const filtered = shops.filter(s =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Handle Map Movement ───────────────────────────────────────────────────
  const handleMapBoundsChange = useCallback(async (newPos) => {
    if (isLocating || !newPos) return;

    setIsFetchingShops(true);
    setShopsError(null);
    try {
      const found = await loadShopsService(newPos, 5000);

      setShops(prevShops => {
        const shopMap = new Map();
        prevShops.forEach(s => shopMap.set(s.id, s));

        found.forEach(s => {
          const refPos = position || newPos;
          shopMap.set(s.id, {
            ...s,
            distKm: haversineKm(refPos, [s.lat, s.lon])
          });
        });

        return Array.from(shopMap.values()).sort((a, b) => a.distKm - b.distKm);
      });
    } catch (err) {
      console.warn('[Services] Failed to fetch more shops:', err);
      // Don't clobber existing shops on a pan-triggered refresh failure —
      // only the initial load shows the hard error state.
    } finally {
      setIsFetchingShops(false);
    }
  }, [isLocating, position]);

  const selectShop = (shop) => {
    setSelectedShop(shop);
    setMapCenter([shop.lat, shop.lon]);
    setIsFollowing(false); // looking at a shop, not tracking the user anymore
  };

  const isOpen = (hours) => {
    if (!hours) return null;
    if (hours.toLowerCase().includes('24/7')) return true;
    return null;
  };

  const fmtDist = (km) => km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`;

  return (
    // 1. Бронебійний Flex-контейнер на всю висоту екрану
    <div className="relative w-full bg-[#050505] overflow-hidden flex flex-col" style={{ height: 'var(--app-height)' }}>

      {/* No safe-area spacer here — #root already insets the whole app by
          --safe-top, and #safe-top-cover masks the status bar. Adding one here
          double-counted the notch and left this page with a visible gap that
          no other page had. */}

      {/* Головна обгортка для карти (flex-1 гарантує, що вона заповнить залишок екрану) */}
      <div className="relative flex-1 w-full z-0">

        {/* MAP */}
        <div className="absolute inset-0 z-0">
          {position && (
            <MapContainer
              center={position}
              zoom={14}
              zoomControl={false}
              className={TILES_NEED_DARKENING ? 'dark-tiles' : undefined}
              style={{ height: '100%', width: '100%', background: '#050505' }}
            >
              {/* Примусовий ререндер розміру карти для мобільних */}
              <FixMapRender />

              <TileLayer
                attribution={TILE_ATTRIBUTION}
                url={TILE_URL}
                maxZoom={19}
              />

              {/* User dot */}
              <Marker position={position} icon={userIcon} />

              {/* Shop markers */}
              {filtered.map(shop => (
                <Marker
                  key={shop.id}
                  position={[shop.lat, shop.lon]}
                  icon={makeShopIcon(shop.id === closestShop?.id, shop.isPartner)}
                  eventHandlers={{ click: () => selectShop(shop) }}
                />
              ))}

              <RecenterMap position={mapCenter} />
              <MapEvents onBoundsChange={handleMapBoundsChange} onUserDrag={() => setIsFollowing(false)} />
            </MapContainer>
          )}

          {isLocating && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#050505] gap-3 z-10">
              <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-gray-500">Визначаємо розташування...</span>
            </div>
          )}
        </div>

        {/* SEARCH BAR (Тепер він всередині безпечної зони і не сховається під чубчиком) */}
        <div className="absolute top-5 left-5 right-5 z-[1000] flex items-center gap-3">
          <div className="flex-1 bg-[#111318]/90 backdrop-blur-md border border-gray-800 rounded-2xl flex items-center px-4 py-3 shadow-lg">
            <svg className="w-5 h-5 text-gray-400 mr-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Шукати СТО..."
              className="bg-transparent border-none text-sm text-white w-full focus:outline-none placeholder-gray-500"
            />
            {isFetchingShops && (
              <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin flex-shrink-0 ml-2" />
            )}
          </div>

          {/* Recenter button — highlighted blue while auto-following the live
              GPS position, plain gray once the user has panned away */}
          <button
            onClick={recenter}
            aria-label="Показати моє місцезнаходження"
            className={`w-12 h-12 backdrop-blur-md rounded-2xl border flex items-center justify-center shadow-lg active:scale-95 transition-all ${
              isFollowing
                ? 'bg-blue-600/90 border-blue-500'
                : 'bg-[#111318]/90 border-gray-800'
            }`}
          >
            <svg className={`w-5 h-5 ${isFollowing ? 'text-white' : 'text-blue-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>

        {/* Stacked banners below the search bar — a flex column instead of
            independently-hardcoded top offsets so they never overlap
            regardless of which combination is showing */}
        <div className="absolute top-20 left-5 right-5 z-[1000] flex flex-col items-start gap-2">
          {locationError && (
            <div className="w-full bg-amber-950/80 border border-amber-800/40 backdrop-blur-md px-3 py-2 rounded-xl flex items-center gap-2">
              <span className="text-amber-400 text-xs flex-shrink-0">⚠</span>
              <span className="text-[10px] text-amber-300">{locationError} — показано Київ як приклад</span>
            </div>
          )}

          {closestShop && selectedShop?.id === closestShop.id && (
            <div className="flex items-center gap-1.5 bg-blue-600/20 border border-blue-500/30 px-3 py-1.5 rounded-full backdrop-blur-sm">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">Найближче</span>
              <span className="text-[10px] text-blue-300">{fmtDist(closestShop.distKm)}</span>
            </div>
          )}
        </div>

        {/* BOTTOM SHEET */}
        {selectedShop && (
          <div className="absolute bottom-6 left-5 right-5 z-[1000] animate-in slide-in-from-bottom-4 duration-300">
            <div className="bg-[#111318]/95 backdrop-blur-xl rounded-3xl border border-gray-800 shadow-[0_-10px_40px_rgba(0,0,0,0.6)] overflow-hidden">
              {filtered.length > 1 && (
                <div className="flex gap-2 px-4 pt-4 pb-2 overflow-x-auto scrollbar-hide">
                  {filtered.slice(0, 8).map(s => (
                    <button
                      key={s.id}
                      onClick={() => selectShop(s)}
                      className={`flex-shrink-0 px-3 py-1.5 rounded-full text-[10px] font-bold transition-all border
                        ${selectedShop.id === s.id
                          ? 'bg-blue-600 text-white border-blue-500 shadow-md'
                          : s.id === closestShop?.id
                            ? 'bg-blue-600/10 text-blue-400 border-blue-700/40'
                            : 'bg-gray-900 text-gray-400 border-gray-800'
                        }`}
                    >
                      {s.id === closestShop?.id ? '📍 ' : ''}{s.name.length > 18 ? s.name.slice(0, 18) + '…' : s.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="p-5 pt-3">
                <div className="flex justify-between items-start mb-1">
                  <div className="flex items-center gap-2">
                    {selectedShop.id === closestShop?.id && (
                      <span className="text-[9px] font-bold tracking-widest uppercase text-blue-400 bg-blue-600/10 border border-blue-700/30 px-2 py-0.5 rounded-full">Найближче</span>
                    )}
                    {selectedShop.isPartner && (
                      <span className="text-[9px] font-bold tracking-widest uppercase text-amber-400 bg-amber-500/10 border border-amber-700/30 px-2 py-0.5 rounded-full">Партнер</span>
                    )}
                  </div>
                  {isOpen(selectedShop.opening) === true && (
                    <span className="text-[9px] font-bold text-green-400 bg-green-500/10 border border-green-700/30 px-2 py-0.5 rounded-full">ВІДКРИТО</span>
                  )}
                </div>

                <h2 className="text-xl font-black text-white mt-1">{selectedShop.name}</h2>

                <div className="flex items-center gap-3 text-xs text-gray-400 mt-1.5 mb-4 flex-wrap">
                  <span className="flex items-center gap-1">
                    <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/>
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>
                    </svg>
                    {fmtDist(selectedShop.distKm)}
                  </span>
                  {selectedShop.categoryLabel && (
                    <>
                      <span className="text-gray-700">•</span>
                      <span className="text-[10px] text-gray-400">{selectedShop.categoryLabel}</span>
                    </>
                  )}
                  {/* Show the number itself, not just a call button — people
                      read it, save it, or dial it from another phone. */}
                  {selectedShop.phone && (
                    <>
                      <span className="text-gray-700">•</span>
                      <a href={`tel:${selectedShop.phone}`}
                         className="text-[11px] text-blue-400 font-semibold whitespace-nowrap">
                        {selectedShop.phone}
                      </a>
                    </>
                  )}
                  {selectedShop.opening && (
                    <>
                      <span className="text-gray-700">•</span>
                      <span className="text-gray-500 text-[10px] truncate max-w-[140px]">{selectedShop.opening}</span>
                    </>
                  )}
                </div>

                <div className="flex gap-3">
                  {selectedShop.phone ? (
                      <a href={`tel:${selectedShop.phone}`}
                      className="flex-1 bg-gray-900 hover:bg-gray-800 text-white font-bold py-3.5 rounded-xl border border-gray-700 flex items-center justify-center gap-2 transition-colors active:scale-[0.98] text-xs"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                      </svg>
                      Дзвінок
                    </a>
                  ) : (
                    <button disabled className="flex-1 bg-gray-900/50 text-gray-600 font-bold py-3.5 rounded-xl border border-gray-800 flex items-center justify-center gap-2 text-xs cursor-not-allowed">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"/>
                      </svg>
                      Немає тел.
                    </button>
                  )}

                  <button
                    onClick={() => openMapsRoute(position, selectedShop)}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center justify-center gap-2 transition-transform active:scale-[0.98] text-xs"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                    </svg>
                    Маршрут
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error state — a failed/timed-out request, distinct from "genuinely
            nothing nearby" so users aren't left thinking there's just no СТО */}
        {shopsError && !isFetchingShops && shops.length === 0 && (
          <div className="absolute bottom-28 left-5 right-5 z-[1000]">
            <div className="bg-[#111318]/95 border border-red-900/40 rounded-2xl p-5 text-center">
              <p className="text-red-400 text-xs font-bold mb-1">Не вдалося завантажити СТО</p>
              <p className="text-gray-500 text-[10px] mb-3">Проблема з мережею або сервісом карт. Спробуйте ще раз.</p>
              <button
                onClick={() => position && loadShops(position, 5000, { force: true })}
                className="text-blue-400 text-xs font-bold underline"
              >
                Спробувати ще раз
              </button>
            </div>
          </div>
        )}

        {/* Empty state — request succeeded, genuinely nothing nearby */}
        {!shopsError && !isFetchingShops && !isLocating && shops.length === 0 && (
          <div className="absolute bottom-28 left-5 right-5 z-[1000]">
            <div className="bg-[#111318]/95 border border-gray-800 rounded-2xl p-5 text-center">
              <p className="text-gray-500 text-xs">СТО не знайдено в радіусі 5 км</p>
              <button
                onClick={() => position && loadShops(position, 15000)}
                className="mt-3 text-blue-400 text-xs underline"
              >
                Розширити пошук до 15 км
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Bottom home-indicator inset also comes from #root's padding-bottom —
          a spacer here would double it, same as the top one did. */}
    </div>
  );
}
