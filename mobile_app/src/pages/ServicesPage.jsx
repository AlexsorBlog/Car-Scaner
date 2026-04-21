import React from 'react';

export default function ServicesPage() {
  return (
    <div className="relative h-screen w-full bg-[#050505] overflow-hidden animate-in fade-in duration-500">
      
      {/* Симуляція темної карти */}
      <div className="absolute inset-0 z-0 opacity-20" 
           style={{ backgroundImage: 'linear-gradient(#333 1px, transparent 1px), linear-gradient(90deg, #333 1px, transparent 1px)', backgroundSize: '40px 40px' }}>
      </div>
      
      {/* Пошук */}
      <div className="absolute top-5 left-5 right-5 z-10 flex items-center gap-3">
        <div className="flex-1 bg-gray-900/80 backdrop-blur-md border border-gray-700 rounded-full flex items-center px-4 py-3">
          <svg className="w-5 h-5 text-gray-400 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
          <input type="text" placeholder="Шукати СТО..." className="bg-transparent border-none text-sm text-white w-full focus:outline-none placeholder-gray-500" />
        </div>
        <div className="w-12 h-12 bg-gray-900/80 backdrop-blur-md rounded-full border border-gray-700 flex items-center justify-center">
          <span className="text-sm">👤</span>
        </div>
      </div>

      {/* Маркери на "Карті" */}
      <div className="absolute top-1/3 left-1/4 z-10">
        <div className="w-4 h-4 bg-gray-500 rounded-full border-2 border-black"></div>
      </div>
      <div className="absolute top-1/2 right-1/3 z-10 flex flex-col items-center">
        <div className="w-8 h-8 bg-blue-600 rounded-full border-2 border-black flex items-center justify-center shadow-[0_0_15px_rgba(37,99,235,0.6)]">
          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
        </div>
        <span className="text-[10px] font-bold mt-1 bg-black/50 px-2 py-0.5 rounded text-gray-300">AutoCare Center</span>
      </div>

      {/* Картка знизу */}
      <div className="absolute bottom-28 left-5 right-5 z-10">
        <div className="bg-[#111318]/95 backdrop-blur-xl rounded-3xl p-5 border border-gray-800 shadow-2xl">
          <div className="text-[10px] font-bold tracking-widest uppercase text-blue-500 mb-1">Преміум Партнер</div>
          <h2 className="text-2xl font-bold text-white">AutoCare Center</h2>
          <div className="flex items-center text-sm text-gray-400 mt-1 mb-5">
            <span className="text-yellow-500 mr-1">★ 4.8</span> • 1.2 км звідси
          </div>

          <div className="flex gap-3">
            <button className="flex-1 bg-gray-800 hover:bg-gray-700 text-white font-bold py-3.5 rounded-xl border border-gray-700 flex items-center justify-center gap-2 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z"></path></svg>
              Дзвінок
            </button>
            <button className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-bold py-3.5 rounded-xl shadow-[0_0_15px_rgba(37,99,235,0.4)] flex items-center justify-center gap-2 transition-transform">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
              Маршрут
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}