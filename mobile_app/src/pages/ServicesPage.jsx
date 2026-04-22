import React, { useState, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Компонент для автоматичного центрування карти на користувачі
function LocationMarker({ position }) {
  const map = useMap();
  useEffect(() => {
    if (position) {
      map.flyTo(position, 14, { animate: true });
    }
  }, [position, map]);
  return null;
}

// Кастомна іконка для користувача (синя крапка)
const userIcon = new L.DivIcon({
  className: 'bg-transparent',
  html: `<div class="w-5 h-5 bg-blue-500 rounded-full border-4 border-white shadow-[0_0_15px_rgba(59,130,246,0.8)] animate-pulse"></div>`,
  iconSize: [20, 20],
  iconAnchor: [10, 10]
});

// Кастомна іконка для СТО (червоний маркер)
const stoIcon = new L.DivIcon({
  className: 'bg-transparent',
  html: `
    <div class="flex flex-col items-center">
      <div class="w-8 h-8 bg-[#111318] rounded-full border-2 border-red-500 flex items-center justify-center shadow-[0_0_15px_rgba(239,68,68,0.6)]">
        <svg class="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
      </div>
    </div>
  `,
  iconSize: [32, 32],
  iconAnchor: [16, 16]
});

export default function ServicesPage() {
  const [position, setPosition] = useState(null);
  const [stoLocation, setStoLocation] = useState(null);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);

  useEffect(() => {
    // Отримання геолокації пристрою (ноутбук або смартфон)
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userPos = [pos.coords.latitude, pos.coords.longitude];
          setPosition(userPos);
          // Генеруємо фейкове СТО поруч із користувачем (+0.005 градусів на північ/схід)
          setStoLocation([pos.coords.latitude + 0.005, pos.coords.longitude + 0.005]);
          setIsLoadingLocation(false);
        },
        (err) => {
          console.warn("Геолокація недоступна або відхилена, встановлено координати за замовчуванням.", err);
          // Дефолтні координати (Київ)
          const defaultPos = [50.4501, 30.5234];
          setPosition(defaultPos);
          setStoLocation([50.4551, 30.5284]);
          setIsLoadingLocation(false);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    } else {
      const defaultPos = [50.4501, 30.5234];
      setPosition(defaultPos);
      setStoLocation([50.4551, 30.5284]);
      setIsLoadingLocation(false);
    }
  }, []);

  return (
    <div className="relative h-screen w-full bg-[#050505] overflow-hidden animate-in fade-in duration-500">
      
      {/* Карта Leaflet */}
      <div className="absolute inset-0 z-0">
        {!isLoadingLocation && position && (
          <MapContainer 
            center={position} 
            zoom={14} 
            zoomControl={false} // Вимикаємо стандартні кнопки зуму для чистішого UI
            style={{ height: "100%", width: "100%", background: "#050505" }}
          >
            {/* Темні тайли карти (CartoDB Dark Matter) */}
            <TileLayer
              attribution='&copy; <a href="https://carto.com/attributions">CARTO</a>'
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            />
            
            {/* Маркер користувача */}
            <Marker position={position} icon={userIcon} />
            
            {/* Маркер СТО */}
            {stoLocation && (
              <Marker position={stoLocation} icon={stoIcon} />
            )}

            <LocationMarker position={position} />
          </MapContainer>
        )}
        
        {/* Стан завантаження */}
        {isLoadingLocation && (
          <div className="w-full h-full flex flex-col items-center justify-center bg-[#050505] text-gray-500 text-xs gap-3">
             <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
             Шукаємо ваше розташування...
          </div>
        )}
      </div>
      
      {/* Пошук (z-[1000] щоб бути поверх Leaflet) */}
      <div className="absolute top-5 left-5 right-5 z-[1000] flex items-center gap-3">
        <div className="flex-1 bg-[#111318]/90 backdrop-blur-md border border-gray-800 rounded-2xl flex items-center px-4 py-3 shadow-lg">
          <svg className="w-5 h-5 text-gray-400 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
          <input type="text" placeholder="Шукати СТО..." className="bg-transparent border-none text-sm text-white w-full focus:outline-none placeholder-gray-500" />
        </div>
        <div className="w-12 h-12 bg-[#111318]/90 backdrop-blur-md rounded-2xl border border-gray-800 flex items-center justify-center shadow-lg active:scale-95 transition-transform cursor-pointer">
          <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"></path></svg>
        </div>
      </div>

      {/* Кнопка центрування локації */}
      <button 
        onClick={() => {
          if (position && "geolocation" in navigator) {
            navigator.geolocation.getCurrentPosition(pos => setPosition([pos.coords.latitude, pos.coords.longitude]));
          }
        }}
        className="absolute top-24 right-5 z-[1000] w-12 h-12 bg-[#111318]/90 backdrop-blur-md border border-gray-800 rounded-2xl flex items-center justify-center text-white shadow-lg hover:bg-gray-900 transition-colors"
      >
        <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
      </button>

      {/* Картка знизу (z-[1000] поверх карти) */}
      <div className="absolute bottom-28 left-5 right-5 z-[1000]">
        <div className="bg-[#111318]/95 backdrop-blur-xl rounded-3xl p-5 border border-gray-800 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
          <div className="flex justify-between items-start mb-1">
            <div className="text-[10px] font-bold tracking-widest uppercase text-blue-500">Преміум Партнер</div>
            <div className="bg-green-500/20 text-green-400 px-2 py-0.5 rounded text-[10px] font-bold">ВІДКРИТО</div>
          </div>
          
          <h2 className="text-2xl font-black text-white">AutoCare Center</h2>
          
          <div className="flex items-center text-xs text-gray-400 mt-1 mb-5">
            <span className="text-yellow-500 mr-1 text-sm">★ 4.8</span> 
            <span className="mx-2">•</span> 
            <span>1.2 км звідси</span>
            <span className="mx-2">•</span> 
            <span>Кузовний ремонт, Електрика</span>
          </div>

          <div className="flex gap-3">
            <button className="flex-1 bg-gray-900 hover:bg-gray-800 text-white font-bold py-3.5 rounded-xl border border-gray-700 flex items-center justify-center gap-2 transition-colors active:scale-[0.98]">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
              Дзвінок
            </button>
            <button className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center justify-center gap-2 transition-transform active:scale-[0.98]">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
              Маршрут
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}