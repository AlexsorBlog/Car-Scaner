// ServicesPage.jsx — full replacement

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { Geolocation } from '@capacitor/geolocation';
import { Capacitor } from '@capacitor/core';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

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

// ── Map drag event listener ──────────────────────────────────────────────────
function MapEvents({ onBoundsChange }) {
  const map = useMap();
  
  useEffect(() => {
    let timeout;
    const handleMoveEnd = () => {
      clearTimeout(timeout);
      // Debounce the call so we don't spam the API while the user is actively panning
      timeout = setTimeout(() => {
        const center = map.getCenter();
        onBoundsChange([center.lat, center.lng]);
      }, 800); 
    };

    map.on('moveend', handleMoveEnd);
    map.on('zoomend', handleMoveEnd);

    return () => {
      map.off('moveend', handleMoveEnd);
      map.off('zoomend', handleMoveEnd);
      clearTimeout(timeout);
    };
  }, [map, onBoundsChange]);

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

// ── Overpass query ────────────────────────────────────────────────────────────

async function fetchNearbyShops([lat, lon], radiusM = 5000) {
  const query = `
    [out:json][timeout:15];
    (
      node["shop"="car_repair"](around:${radiusM},${lat},${lon});
      way["shop"="car_repair"](around:${radiusM},${lat},${lon});
      node["amenity"="car_repair"](around:${radiusM},${lat},${lon});
    );
    out center 40;
  `;
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
  });
  const json = await res.json();
  return (json.elements || []).map(el => ({
    id: el.id,
    name: el.tags?.name || 'СТО без назви',
    lat: el.lat ?? el.center?.lat,
    lon: el.lon ?? el.center?.lon,
    phone: el.tags?.phone || el.tags?.['contact:phone'] || null,
    opening: el.tags?.opening_hours || null,
    isPartner: false, // hook for future partner flagging
  })).filter(s => s.lat && s.lon);
}

// ── Open native maps ──────────────────────────────────────────────────────────

function openMapsRoute(userPos, shop) {
  const dest = `${shop.lat},${shop.lon}`;
  const label = encodeURIComponent(shop.name);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if (isIOS) {
    // Apple Maps deeplink (works in Safari + Capacitor iOS)
    window.open(`maps://?daddr=${dest}&dirflg=d`, '_system');
  } else {
    // Google Maps intent (Android) — geo: URI triggers the chooser
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
  const [locationError, setLocationError] = useState(null);
  const [searchQuery, setSearchQuery]     = useState('');
  const [mapCenter, setMapCenter]         = useState(null);

  // ── Get user location ───────────────────────────────────────────────────────

  const getLocation = useCallback(async () => {
    setIsLocating(true);
    setLocationError(null);
    try {
      let pos;
      if (Capacitor.isNativePlatform()) {
        const perm = await Geolocation.requestPermissions();
        if (perm.location !== 'granted') throw new Error('Дозвіл відхилено');
        const coords = await Geolocation.getCurrentPosition({ enableHighAccuracy: true });
        pos = [coords.coords.latitude, coords.coords.longitude];
      } else {
        pos = await new Promise((res, rej) =>
          navigator.geolocation.getCurrentPosition(
            p => res([p.coords.latitude, p.coords.longitude]),
            e => rej(e),
            { enableHighAccuracy: true }
          )
        );
      }
      setPosition(pos);
      setMapCenter(pos);
      return pos;
    } catch (err) {
      setLocationError('Не вдалось визначити локацію');
      const fallback = [50.4501, 30.5234]; // Kyiv
      setPosition(fallback);
      setMapCenter(fallback);
      return fallback;
    } finally {
      setIsLocating(false);
    }
  }, []);

  // ── Fetch shops once we have location ─────────────────────────────────────

  useEffect(() => {
    getLocation().then(async (pos) => {
      setIsFetchingShops(true);
      try {
        const found = await fetchNearbyShops(pos, 5000);
        // Attach distance
        const withDist = found.map(s => ({
          ...s,
          distKm: haversineKm(pos, [s.lat, s.lon]),
        })).sort((a, b) => a.distKm - b.distKm);

        setShops(withDist);
        if (withDist.length > 0) {
          setClosestShop(withDist[0]);
          setSelectedShop(withDist[0]);
        }
      } catch {
        setShops([]);
      } finally {
        setIsFetchingShops(false);
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Recenter to user ───────────────────────────────────────────────────────

  const recenter = useCallback(async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const coords = await Geolocation.getCurrentPosition();
        const p = [coords.coords.latitude, coords.coords.longitude];
        setPosition(p);
        setMapCenter(p);
      } catch (_) {}
    } else {
      navigator.geolocation.getCurrentPosition(p => {
        const pos = [p.coords.latitude, p.coords.longitude];
        setPosition(pos);
        setMapCenter(pos);
      });
    }
  }, []);

  // ── Filter ────────────────────────────────────────────────────────────────

  const filtered = shops.filter(s =>
    s.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Handle Map Movement ───────────────────────────────────────────────────

  const handleMapBoundsChange = useCallback(async (newPos) => {
    // Prevent fetching if we are already doing an initial location fetch
    if (isLocating || !newPos) return;
    
    setIsFetchingShops(true);
    try {
      const found = await fetchNearbyShops(newPos, 5000);
      
      setShops(prevShops => {
        // Merge new shops with existing ones to avoid screen flickering,
        // using Map to ensure uniqueness by ID
        const shopMap = new Map();
        prevShops.forEach(s => shopMap.set(s.id, s));
        
        found.forEach(s => {
          // Keep user's actual physical position for distance calculation if available, 
          // otherwise fallback to the map center they dragged to
          const refPos = position || newPos;
          shopMap.set(s.id, {
            ...s,
            distKm: haversineKm(refPos, [s.lat, s.lon])
          });
        });
        
        return Array.from(shopMap.values()).sort((a, b) => a.distKm - b.distKm);
      });
    } catch (err) {
      console.warn("Failed to fetch more shops:", err);
    } finally {
      setIsFetchingShops(false);
    }
  }, [isLocating, position]);

  const isOpen = (hours) => {
    if (!hours) return null;
    if (hours.toLowerCase().includes('24/7')) return true;
    // simple heuristic — full parser would be overkill here
    return null;
  };

  // ── Format distance ───────────────────────────────────────────────────────

  const fmtDist = (km) => km < 1 ? `${Math.round(km * 1000)} м` : `${km.toFixed(1)} км`;

  return (
    <div className="relative w-full bg-[#050505] overflow-hidden" style={{ height: 'calc(100vh - var(--safe-top) - var(--safe-bottom))' }}>

      {/* MAP */}
      <div className="absolute inset-0 z-0">
        {position && (
          <MapContainer
            center={position}
            zoom={14}
            zoomControl={false}
            style={{ height: '100%', width: '100%', background: '#050505' }}
          >
            <TileLayer
              attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />

            {/* User dot */}
            <Marker position={position} icon={userIcon} />

          {/* Shop markers */}
            {filtered.map(shop => (
              <Marker
                key={shop.id}
                position={[shop.lat, shop.lon]}
                icon={makeShopIcon(shop.id === closestShop?.id, shop.isPartner)}
                eventHandlers={{ click: () => { setSelectedShop(shop); setMapCenter([shop.lat, shop.lon]); } }}
              />
            ))}

            <RecenterMap position={mapCenter} />
            {/* ADD THE NEW COMPONENT HERE: */}
            <MapEvents onBoundsChange={handleMapBoundsChange} />
          </MapContainer>
        )}

        {isLocating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#050505] gap-3 z-10">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <span className="text-xs text-gray-500">Визначаємо розташування...</span>
          </div>
        )}
      </div>

      {/* SEARCH BAR */}
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

        {/* Recenter */}
        <button
          onClick={recenter}
          className="w-12 h-12 bg-[#111318]/90 backdrop-blur-md rounded-2xl border border-gray-800 flex items-center justify-center shadow-lg active:scale-95 transition-transform"
        >
          <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* CLOSEST BADGE — shown when no shop selected or closest is selected */}
      {closestShop && selectedShop?.id === closestShop.id && (
        <div className="absolute top-24 left-5 z-[1000]">
          <div className="flex items-center gap-1.5 bg-blue-600/20 border border-blue-500/30 px-3 py-1.5 rounded-full backdrop-blur-sm">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] font-bold text-blue-400 uppercase tracking-widest">Найближче</span>
            <span className="text-[10px] text-blue-300">{fmtDist(closestShop.distKm)}</span>
          </div>
        </div>
      )}

      {/* BOTTOM SHEET */}
      {selectedShop && (
        <div className="absolute bottom-28 left-5 right-5 z-[1000] animate-in slide-in-from-bottom-4 duration-300">
          <div className="bg-[#111318]/95 backdrop-blur-xl rounded-3xl border border-gray-800 shadow-[0_-10px_40px_rgba(0,0,0,0.6)] overflow-hidden">

            {/* Shop list pill row — scroll horizontally */}
            {filtered.length > 1 && (
              <div className="flex gap-2 px-4 pt-4 pb-2 overflow-x-auto scrollbar-hide">
                {filtered.slice(0, 8).map(s => (
                  <button
                    key={s.id}
                    onClick={() => { setSelectedShop(s); setMapCenter([s.lat, s.lon]); }}
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

            {/* Selected shop detail */}
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

      {/* Empty state */}
      {!isFetchingShops && !isLocating && shops.length === 0 && (
        <div className="absolute bottom-36 left-5 right-5 z-[1000]">
          <div className="bg-[#111318]/95 border border-gray-800 rounded-2xl p-5 text-center">
            <p className="text-gray-500 text-xs">СТО не знайдено в радіусі 5 км</p>
            <button
              onClick={() => position && fetchNearbyShops(position, 15000).then(s => setShops(s))}
              className="mt-3 text-blue-400 text-xs underline"
            >
              Розширити пошук до 15 км
            </button>
          </div>
        </div>
      )}
    </div>
  );
}