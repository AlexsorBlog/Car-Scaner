import React from 'react';
import { useTelemetry } from '../hooks/useTelemetry';

export default function ScanPage() {
  // ДОДАНО = [] щоб уникнути помилки undefined
  const { scans = [], isLoading } = useTelemetry();

   if (isLoading) {
    return <div className="min-h-screen bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;
   }

  return (
    <div className="p-5 flex flex-col gap-6 animate-in fade-in duration-500">
      
      {/* Головний віджет ШІ аналізу */}
      <div className="bg-gradient-to-b from-blue-900/20 to-[#111318] rounded-3xl p-5 border border-blue-900/30 relative overflow-hidden shadow-[0_0_30px_rgba(37,99,235,0.1)] mt-4">
        <div className="absolute top-2 left-1/2 transform -translate-x-1/2 flex items-center gap-2 bg-black/50 px-3 py-1 rounded-full border border-gray-700 backdrop-blur-md">
          <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse"></div>
          <span className="text-[9px] font-bold tracking-widest uppercase text-gray-300">Аналіз наживо</span>
        </div>

        <div className="mt-8 mb-6 h-40 border-2 border-dashed border-blue-500/30 rounded-xl flex items-center justify-center bg-blue-500/5 relative">
           <svg className="w-12 h-12 text-blue-500/50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
           <div className="absolute inset-0 bg-gradient-to-b from-transparent to-blue-500/10 animate-[scan_2s_ease-in-out_infinite]"></div>
        </div>

        <h3 className="text-xs font-bold text-gray-400 mb-2 uppercase tracking-wider">Звіт нейромережі</h3>
        <div className="flex items-start gap-3 mb-2">
          <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center mt-0.5"><svg className="w-3 h-3 text-green-500" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"></path></svg></div>
          <div>
            <div className="text-sm font-bold text-white">Виявлено: Подряпина бампера</div>
            <div className="text-[10px] text-gray-500">Впевненість: 98.4%</div>
          </div>
        </div>

        <div className="flex justify-center gap-4 mt-6">
          <button className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 hover:bg-gray-700 transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg></button>
          <button className="w-14 h-14 rounded-full bg-blue-600 flex items-center justify-center shadow-[0_0_20px_rgba(37,99,235,0.4)] hover:scale-105 transition-transform"><svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path></svg></button>
          <button className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center border border-gray-700 hover:bg-gray-700 transition-colors"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg></button>
        </div>
      </div>

      {/* Історія */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-sm font-bold tracking-wide text-gray-300">ІСТОРІЯ СКАНУВАНЬ</h3>
          <span className="text-[10px] text-gray-500 font-bold">{scans.length} ЗВІТІВ</span>
        </div>
        
        <div className="flex flex-col gap-3">
          {scans.map(scan => (
            <div key={scan.id} className="bg-[#111318] p-4 rounded-xl border border-gray-800 flex justify-between items-center hover:bg-gray-800/50 transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-gray-800 flex items-center justify-center text-xs">🔍</div>
                <div>
                  <div className="text-sm font-bold text-white">{scan.part}</div>
                  <div className="text-[10px] text-gray-500">{scan.issue} • {scan.date}</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-[9px] font-bold px-2 py-1 rounded ${scan.bg} ${scan.color}`}>{scan.status}</span>
                <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7"></path></svg>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}