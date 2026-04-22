import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTelemetry } from '../hooks/useTelemetry';
import { getDiagnosticReports } from '../services/db.js';

export default function DiagnosticsPage() {
  const telemetry = useTelemetry();
  const location = useLocation();
  const navigate = useNavigate();

  const [selectedError, setSelectedError] = useState(null);
  const [lastErrors, setLastErrors] = useState([]);
  const [lastScanTime, setLastScanTime] = useState('Невідомо');

  useEffect(() => {
    if (location.state?.selectedError) {
      setSelectedError(location.state.selectedError);
    }
  }, [location.state]);

  useEffect(() => {
    const loadErrors = async () => {
      if (telemetry.hasScannedErrors) {
        setLastErrors(telemetry.errors);
        setLastScanTime(telemetry.lastScanTime || new Date().toLocaleTimeString('uk-UA'));
      } else {
        const reports = await getDiagnosticReports('scanned_errors', 1);
        if (reports && reports.length > 0) {
          setLastErrors(reports[0].data);
          setLastScanTime(new Date(reports[0].timestamp).toLocaleString('uk-UA'));
        }
      }
    };
    loadErrors();
  }, [telemetry.hasScannedErrors, telemetry.errors, telemetry.lastScanTime]);

  if (telemetry.isLoading) {
    return (
      <div className="min-h-screen bg-[#050505] flex justify-center items-center">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  const hasErrors = lastErrors.length > 0;

  return (
    <div className="p-5 flex flex-col gap-6 animate-in slide-in-from-right-4 duration-300 pb-28 min-h-screen bg-[#050505]">
      
      {/* HEADER */}
      <div className="flex justify-between items-center mt-2">
        <button onClick={() => navigate(-1)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors">
           <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
        </button>
        <h2 className="text-xs text-gray-500 font-bold tracking-widest uppercase">Діагностика ЕБУ</h2>
        <div className="w-9"></div>
      </div>

      {/* STATUS BLOCK */}
      <div>
        <h1 className={`text-4xl font-black uppercase leading-tight text-transparent bg-clip-text ${hasErrors ? 'bg-gradient-to-r from-red-500 to-orange-400 drop-shadow-[0_0_10px_rgba(239,68,68,0.5)]' : 'bg-gradient-to-r from-green-400 to-emerald-600 drop-shadow-[0_0_10px_rgba(52,211,153,0.5)]'}`}>
          {hasErrors ? <>Виявлено<br />критичні<br />загрози</> : <>Система<br />в нормі<br />(Без помилок)</>}
        </h1>
        <p className="text-sm text-gray-400 mt-4 leading-relaxed pr-8">
          {hasErrors 
            ? `Продуктивність автомобіля наразі під загрозою. Останній аналіз виявив ${lastErrors.length} активні несправності.` 
            : "Останнє сканування не виявило жодних помилок у роботі систем автомобіля."}
          <br /><span className="text-[10px] text-gray-500 mt-1 block">Останнє сканування: {lastScanTime}</span>
        </p>
      </div>

      {/* CONTROLS */}
      <div className="flex gap-3 my-2">
        <button 
           onClick={telemetry.scanErrors} 
           disabled={!telemetry.isConnected || telemetry.isCheckingErrors} 
           className="flex-1 bg-blue-600/20 text-blue-400 border border-blue-500/30 py-3.5 rounded-xl font-bold text-xs hover:bg-blue-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {telemetry.isCheckingErrors ? "СКАНУЮ..." : "ЗАПУСТИТИ АНАЛІЗ"}
        </button>
        {hasErrors && (
          <button 
             onClick={telemetry.clearErrors} 
             disabled={!telemetry.isConnected || telemetry.isCheckingErrors}
             className="flex-1 bg-red-950/40 text-red-400 border border-red-900/40 py-3.5 rounded-xl font-bold text-xs hover:bg-red-900/60 transition-all disabled:opacity-50"
          >
            СТЕРТИ (04)
          </button>
        )}
      </div>

      {/* ВІДЦЕНТРОВАНИЙ І ВИПРАВЛЕНИЙ КРУГОВИЙ ІНДИКАТОР */}
      <div className="flex justify-center my-6 relative">
        <div className={`relative w-32 h-32 rounded-full flex flex-col justify-center items-center ${hasErrors ? 'shadow-[0_0_30px_rgba(239,68,68,0.2)]' : 'shadow-[0_0_30px_rgba(52,211,153,0.2)]'}`}>
          
          {/* Фонове коло (Замінює CSS border-[4px] для ідеально рівних країв) */}
          <svg viewBox="0 0 128 128" className="absolute inset-0 w-full h-full overflow-visible">
            <circle 
              cx="64" cy="64" r="60" 
              stroke={hasErrors ? "#450a0a" : "#064e3b"} 
              strokeWidth="4" fill="none" 
            />
          </svg>

          {/* Основний індикатор */}
          <svg viewBox="0 0 128 128" className="absolute inset-0 w-full h-full transform -rotate-90 overflow-visible">
             <circle 
               cx="64" cy="64" r="60" 
               stroke={hasErrors ? "#ef4444" : "#10b981"} 
               strokeWidth="4" 
               fill="none" 
               strokeDasharray="377" 
               strokeDashoffset={hasErrors ? "100" : "0"} 
               strokeLinecap="round"
               className={`transition-all duration-1000 ease-out ${hasErrors ? 'drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'drop-shadow-[0_0_8px_rgba(16,185,129,0.8)]'}`}
             />
          </svg>

          <span className="text-4xl font-black text-white relative z-10">{lastErrors.length}</span>
          <span className="text-[9px] text-gray-400 font-bold tracking-widest mt-1 relative z-10">{hasErrors ? 'ПОМИЛКИ' : 'ЧИСТО'}</span>
        </div>
      </div>

      {/* ERRORS LIST */}
      <div className="flex flex-col gap-4">
        {lastErrors.map((error, index) => (
          <div key={index} onClick={() => setSelectedError(error)} className="bg-[#111318] rounded-2xl p-5 border border-red-900/50 shadow-[0_8px_30px_rgba(0,0,0,0.5)] relative overflow-hidden cursor-pointer hover:bg-[#161922] transition-colors">
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500 shadow-[0_0_10px_#ef4444]"></div>
            
            <div className="flex justify-between items-start mb-3">
              <span className="bg-blue-900/30 text-blue-400 border border-blue-800/50 px-2 py-0.5 rounded text-xs font-bold font-mono">
                {error.code}
              </span>
              <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
            </div>

            <h3 className="text-xl font-bold text-white mb-2">{error.title}</h3>
            
            <p className="text-xs text-gray-400 mb-4 leading-relaxed line-clamp-2">
              {error.desc || "Специфічна помилка, що потребує додаткової перевірки системами."}
            </p>

            <button className="w-full bg-gray-900 hover:bg-gray-800 text-gray-300 text-xs font-bold py-3 rounded-xl border border-gray-700 flex items-center justify-center gap-2 transition-all">
              ДЕТАЛЬНІШЕ
            </button>
          </div>
        ))}
      </div>

      {/* МОДАЛКА ДЕТАЛЕЙ ПОМИЛКИ */}
      {selectedError && (
        <div className="fixed inset-0 z-[130] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in p-safe">
          <div className="bg-[#0b0c10] border-t border-gray-800 rounded-t-3xl w-full flex flex-col shadow-2xl pb-8 animate-in slide-in-from-bottom-10">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318] rounded-t-3xl">
              <h2 className="font-bold text-sm text-white uppercase tracking-wider">Деталі помилки</h2>
              <button onClick={() => setSelectedError(null)} className="text-gray-500 p-1 hover:text-white transition-colors">✕</button>
            </div>
            <div className="p-6">
              <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
                <span className="text-xl font-black text-red-500">{selectedError.code}</span>
              </div>
              <h3 className="text-center text-sm font-bold text-gray-200 mb-2">{selectedError.title}</h3>
              <p className="text-center text-xs text-gray-500 mb-6 px-4">{selectedError.desc || "Специфічна помилка, що потребує додаткової перевірки системами."}</p>
              
              <div className="bg-blue-900/10 border border-blue-800/20 p-4 rounded-xl shadow-inner">
                <h4 className="text-[10px] font-bold text-blue-400 mb-2 uppercase tracking-wider">Розумна Діагностика</h4>
                <p className="text-[10px] text-gray-400 mb-4 leading-relaxed">
                  Наш ШІ може проаналізувати дані вашого авто за останні 7 днів та цю помилку, щоб дати рекомендації та знайти найближче СТО.
                </p>
                <button className="w-full bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 font-bold py-3 rounded-xl flex justify-center items-center gap-2 text-xs transition-all shadow-md">
                  АНАЛІЗУВАТИ З AI
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}