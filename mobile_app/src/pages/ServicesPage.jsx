// ServicesPage.jsx — full replacement

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const KYIV_FALLBACK = [50.4501, 30.5234];

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
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const OVERPASS_TIMEOUT_MS = 8000;

async function fetchNearbyShops([lat, lon], radiusM = 5000, attempt = 1) {
  const query = `
    [out:json][timeout:15];
    (
      node["shop"="car_repair"](around:${radiusM},${lat},${lon});
      way["shop"="car_repair"](around:${radiusM},${lat},${lon});
      node["amenity"="car_repair"](around:${radiusM},${lat},${lon});
    );
    out center 40;
  `;
  const failures = [];

  // Race all mirrors at once instead of trying them one after another. Trying
  // them in sequence meant a worst case of endpoints × timeout (~36s+), which
  // reads as "infinite loading" to the user when the primary is hung. Racing
  // makes the wait equal to the FASTEST healthy mirror — normally well under a
  // second — and caps the failure case at a single timeout.
  const attemptOne = async (endpoint) => {
    // fetch() has no built-in timeout and will otherwise wait indefinitely.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), OVERPASS_TIMEOUT_MS);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // Without this, fetch() defaults the body to text/plain, and Overpass's
        // server rejects that outright with 406 Not Acceptable — confirmed by
        // reproducing the exact request outside the app; it fails identically
        // regardless of radius since the request never reaches the query engine.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      return (json.elements || []).map(el => ({
        id: el.id,
        name: el.tags?.name || 'СТО без назви',
        lat: el.lat ?? el.center?.lat,
        lon: el.lon ?? el.center?.lon,
        phone: el.tags?.phone || el.tags?.['contact:phone'] || null,
        opening: el.tags?.opening_hours || null,
        isPartner: false,
      })).filter(s => s.lat && s.lon);
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timeout >${OVERPASS_TIMEOUT_MS / 1000}s` : err.message;
      console.warn(`[Services] ${endpoint} failed: ${reason}`);
      failures.push(`${new URL(endpoint).hostname}: ${reason}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Promise.any resolves on the first SUCCESS and only rejects if every
    // mirror fails, which is exactly the semantics we want here.
    return await Promise.any(OVERPASS_ENDPOINTS.map(attemptOne));
  } catch {
    // Every mirror failed. One short retry covers a transient overload spike,
    // then give up rather than leaving the user on a spinner.
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 1200));
      return fetchNearbyShops([lat, lon], radiusM, attempt + 1);
    }
    const err = new Error('Сервіс карт недоступний. Спробуйте ще раз за хвилину.');
    err.detail = failures.join(' | ');
    throw err;
  }
}

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
  const loadShops = useCallback(async (pos, radiusM = 5000) => {
    setIsFetchingShops(true);
    setShopsError(null);
    try {
      const found = await fetchNearbyShops(pos, radiusM);
      const withDist = found.map(s => ({
        ...s,
        distKm: haversineKm(pos, [s.lat, s.lon]),
      })).sort((a, b) => a.distKm - b.distKm);

      setShops(withDist);
      if (withDist.length > 0) {
        setClosestShop(withDist[0]);
        setSelectedShop(withDist[0]);
      }
    } catch (err) {
      console.error('[Services] fetchNearbyShops failed:', err);
      setShopsError(err.message || 'Не вдалося завантажити СТО');
      setShops([]);
    } finally {
      setIsFetchingShops(false);
    }
  }, []);

  // ── Live location watch — dot follows the real position continuously ────────
  useEffect(() => {
    let cancelled = false;
    let webWatchId = null;
    let nativeWatchId = null;

    const onFix = (lat, lon) => {
      if (cancelled) return;
      const pos = [lat, lon];
      setPosition(pos);
      setIsLocating(false);
      setLocationError(null); // a real fix arrived — clear any earlier fallback warning
      if (isFollowingRef.current) setMapCenter(pos);
    };

    const applyFallbackLocation = () => {
      if (cancelled) return;
      setLocationError('Не вдалось визначити локацію');
      setPosition(KYIV_FALLBACK);
      setMapCenter(KYIV_FALLBACK);
      setIsLocating(false);
    };

    (async () => {
      if (Capacitor.isNativePlatform()) {
        try {
          const perm = await Geolocation.requestPermissions();
          if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
            throw new Error('Дозвіл відхилено');
          }
          nativeWatchId = await Geolocation.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
            if (err) { console.warn('[Services] geolocation watch error:', err); return; }
            if (pos) onFix(pos.coords.latitude, pos.coords.longitude);
          });
        } catch {
          applyFallbackLocation();
        }
      } else if (navigator.geolocation) {
        webWatchId = navigator.geolocation.watchPosition(
          p => onFix(p.coords.latitude, p.coords.longitude),
          applyFallbackLocation,
          { enableHighAccuracy: true }
        );
      } else {
        applyFallbackLocation();
      }
    })();

    return () => {
      cancelled = true;
      if (webWatchId != null) navigator.geolocation.clearWatch(webWatchId);
      if (nativeWatchId != null) Geolocation.clearWatch({ id: nativeWatchId }).catch(() => {});
    };
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
      const found = await fetchNearbyShops(newPos, 5000);

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
              style={{ height: '100%', width: '100%', background: '#050505' }}
            >
              {/* Примусовий ререндер розміру карти для мобільних */}
              <FixMapRender />

              <TileLayer
                attribution='© <a href="https://carto.com/attributions">CARTO</a>'
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
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
                onClick={() => position && loadShops(position)}
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
