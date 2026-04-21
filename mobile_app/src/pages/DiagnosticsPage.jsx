import React from 'react';
import { useTelemetry } from '../hooks/useTelemetry';

export default function DiagnosticsPage() {
  const telemetry = useTelemetry();

  // Перевіряємо, чи дані ще завантажуються
  if (telemetry.isLoading) {
    return (
      <div className="min-h-screen bg-[#050505] flex justify-center items-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="p-5 flex flex-col gap-6 animate-in slide-in-from-right-4 duration-300">
      <div className="mt-4">
        <h2 className="text-xs text-gray-500 font-bold tracking-widest uppercase mb-2">Здоров'я системи</h2>
        <h1 className="text-4xl font-black uppercase leading-tight text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]">
          Виявлено<br />критичні<br />загрози
        </h1>
        <p className="text-sm text-gray-400 mt-4 leading-relaxed pr-8">
          Продуктивність автомобіля наразі під загрозою. OBD-II сканер виявив {telemetry.errors.length} активні несправності, що потребують негайної уваги.
        </p>
      </div>

      <div className="flex justify-start my-4">
        <div className="relative w-32 h-32 rounded-full border-[4px] border-red-900/30 flex flex-col justify-center items-center shadow-[0_0_30px_rgba(239,68,68,0.2)]">
          <svg className="absolute inset-0 w-full h-full transform -rotate-90">
             <circle 
               cx="64" cy="64" r="60" 
               stroke="#ef4444" 
               strokeWidth="4" 
               fill="none" 
               strokeDasharray="377" 
               strokeDashoffset="100" 
               strokeLinecap="round"
               className="drop-shadow-[0_0_8px_rgba(239,68,68,0.8)] animate-pulse"
             />
          </svg>
          <span className="text-4xl font-black text-white">{telemetry.errors.length}</span>
          <span className="text-[9px] text-gray-400 font-bold tracking-widest mt-1">ПОМИЛКИ</span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {telemetry.errors.map((error, index) => (
          <div key={index} className="bg-[#111318] rounded-2xl p-5 border border-red-900/50 shadow-[0_8px_30px_rgba(0,0,0,0.5)] relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500 shadow-[0_0_10px_#ef4444]"></div>
            
            <div className="flex justify-between items-start mb-3">
              <span className="bg-blue-900/30 text-blue-400 border border-blue-800/50 px-2 py-0.5 rounded text-xs font-bold font-mono">
                {error.code}
              </span>
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            </div>

            <h3 className="text-xl font-bold text-white mb-2">{error.title}</h3>
            
            <p className="text-xs text-gray-400 mb-4 leading-relaxed">
              Випадкові або множинні пропуски запалювання. Це означає, що комп'ютер двигуна виявив неправильну роботу одного або кількох циліндрів.
            </p>

            <div className="flex justify-between border-t border-gray-800 pt-3 mb-4">
               <div>
                  <span className="block text-[10px] text-gray-500 font-bold">СЕРЙОЗНІСТЬ</span>
                  <span className="text-xs font-bold text-red-400">{error.severity}</span>
               </div>
               <div className="text-right">
                  <span className="block text-[10px] text-gray-500 font-bold">ОЦІНОЧНА ВАРТІСТЬ</span>
                  <span className="text-xs font-bold text-white">{error.cost}</span>
               </div>
            </div>

            <button className="w-full bg-gray-900 hover:bg-gray-800 text-gray-300 text-xs font-bold py-3 rounded-xl border border-gray-700 flex items-center justify-center gap-2 transition-all">
              <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
              ШІ Аналіз проблеми
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}