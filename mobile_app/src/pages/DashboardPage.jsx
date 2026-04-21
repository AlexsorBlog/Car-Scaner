import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useTelemetry } from '../hooks/useTelemetry';
import { obdScanner } from '../services/bleService.js';
import { obd } from '../obd/index.js';
import { commands } from '../obd/commands.js';

// Імпорт ваших SVG іконок
import HideIcon from '../assets/hide.svg';
import ShowIcon from '../assets/show.svg';

const INITIAL_LAYOUT = [
  { id: 'SPEED', visible: true, size: 'col-span-3' },
  { id: 'RPM', visible: true, size: 'col-span-1' },
  { id: 'COOLANT_TEMP', visible: true, size: 'col-span-1' },
  { id: 'FUEL_LEVEL', visible: true, size: 'col-span-1' },
  { id: 'ENGINE_LOAD', visible: true, size: 'col-span-1' },
  { id: 'INTAKE_TEMP', visible: true, size: 'col-span-1' },
  { id: 'THROTTLE_POS', visible: true, size: 'col-span-1' }
];

const MiniGraph = ({ data, color, label, unit, onClick }) => {
  if (!data || data.length === 0) return (
    <div className="flex flex-col bg-[#111318] p-3 rounded-xl border border-gray-800">
      <div className="flex justify-between items-end mb-2">
        <span className="text-[10px] text-gray-500 font-bold">{label}</span>
      </div>
      <div className="h-10 w-full bg-gray-900/50 rounded-lg flex items-center justify-center">
        <span className="text-[9px] text-gray-600">Немає даних</span>
      </div>
    </div>
  );

  const values = data.map(d => d.v);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min === 0 ? 1 : max - min;
  
  const points = data.map((d, i) => `${(i / (data.length - 1)) * 100},${100 - (((d.v - min) / range) * 100)}`).join(' ');

  return (
    <div onClick={onClick} className="flex flex-col bg-[#111318] p-3 rounded-xl border border-gray-800 cursor-pointer hover:border-gray-600 transition-colors">
      <div className="flex justify-between items-end mb-1">
        <span className="text-[10px] text-gray-500 font-bold">{label}</span>
        <span className="text-xs font-bold" style={{ color }}>{values[values.length-1]} <span className="text-[9px]">{unit}</span></span>
      </div>
      <svg viewBox="0 0 100 100" className="w-full h-10 overflow-visible" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={points} className="drop-shadow-md" />
        <polygon fill={`${color}20`} points={`0,100 ${points} 100,100`} />
      </svg>
    </div>
  );
};

export default function DashboardPage() {
  const telemetry = useTelemetry();
  
  const [useEmulator, setUseEmulator] = useState(true);
  const [timerState, setTimerState] = useState('idle');
  const [time, setTime] = useState(0);
  
  const [layout, setLayout] = useState(() => {
    const saved = localStorage.getItem('dashboardLayout');
    return saved ? JSON.parse(saved) : INITIAL_LAYOUT;
  });
  const [originalLayout, setOriginalLayout] = useState(layout);
  const [isEditMode, setIsEditMode] = useState(false);
  
  const [selectedError, setSelectedError] = useState(null);
  const [selectedGraph, setSelectedGraph] = useState(null);
  const [graphTimeframe, setGraphTimeframe] = useState('1h');

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);

  const dragItem = useRef(null);
  const dragOverItem = useRef(null);
  const resizingItem = useRef(null);
  const startX = useRef(0);

  useEffect(() => {
    const activeSensors = layout.filter(item => item.visible).map(item => item.id);
    telemetry.updateActiveSensors(activeSensors);
  }, [layout, telemetry]);

  useEffect(() => {
    let interval;
    if (timerState === 'running') {
      interval = setInterval(() => setTime((prev) => prev + 10), 10);
      if (time > 4220) { setTimerState('finished'); clearInterval(interval); }
    }
    return () => clearInterval(interval);
  }, [timerState, time]);

  const handleStartTimer = () => { setTime(0); setTimerState('running'); };
  const handleResetTimer = () => { setTimerState('idle'); setTime(0); };
  const formatTime = (ms) => {
    const s = Math.floor(ms / 1000); const m = Math.floor((ms % 1000) / 10);
    return `${s < 10 ? '0' : ''}${s}.${m < 10 ? '0' : ''}${m}`;
  };

  const toggleMode = () => {
    const newMode = !useEmulator;
    setUseEmulator(newMode);
    obdScanner.setMode(newMode); 
  };

  const handleEditToggle = () => {
    if (isEditMode) localStorage.setItem('dashboardLayout', JSON.stringify(layout));
    else setOriginalLayout([...layout]);
    setIsEditMode(!isEditMode);
  };
  const handleCancelEdit = () => { setLayout(originalLayout); setIsEditMode(false); };

  const handleResizeStart = (e, id) => { e.stopPropagation(); resizingItem.current = id; startX.current = e.clientX || e.touches[0].clientX; };
  const handleResizeMove = (e) => {
    if (!resizingItem.current) return;
    const currentX = e.clientX || (e.touches && e.touches[0].clientX);
    const diff = currentX - startX.current;
    if (Math.abs(diff) > 50) {
      const sizes = ['col-span-1', 'col-span-2', 'col-span-3'];
      setLayout(prev => prev.map(item => {
        if (item.id === resizingItem.current) {
          let currIdx = sizes.indexOf(item.size);
          if (diff > 0 && currIdx < 2) currIdx++;
          if (diff < 0 && currIdx > 0) currIdx--;
          return { ...item, size: sizes[currIdx] };
        }
        return item;
      }));
      startX.current = currentX;
    }
  };
  const handleResizeEnd = () => { resizingItem.current = null; };

  useEffect(() => {
    if (isEditMode) {
      window.addEventListener('mousemove', handleResizeMove); window.addEventListener('mouseup', handleResizeEnd);
      window.addEventListener('touchmove', handleResizeMove, { passive: false }); window.addEventListener('touchend', handleResizeEnd);
    }
    return () => {
      window.removeEventListener('mousemove', handleResizeMove); window.removeEventListener('mouseup', handleResizeEnd);
      window.removeEventListener('touchmove', handleResizeMove); window.removeEventListener('touchend', handleResizeEnd);
    };
  }, [isEditMode, layout]);

  const handleSort = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    let _layout = [...layout];
    const draggedItemContent = _layout.splice(dragItem.current, 1)[0];
    _layout.splice(dragOverItem.current, 0, draggedItemContent);
    dragItem.current = null; dragOverItem.current = null;
    setLayout(_layout);
  };

  const toggleVisibility = (id) => setLayout(prev => prev.map(item => item.id === id ? { ...item, visible: !item.visible } : item));

  const runDetailedAnalysis = async () => {
    if (!telemetry.isConnected) return;
    if (!window.confirm("Повний аналіз всіх блоків може зайняти до 30 секунд. Продовжити?")) return;
    setIsAnalyzing(true); setShowAnalysisModal(true); setAnalysisResults([]); setAnalysisProgress(0);
    telemetry.setPaused(true);
    const allCommands = Object.values(commands);
    const totalCmds = allCommands.length;
    const results = [];
    for (let i = 0; i < totalCmds; i++) {
      const cmd = allCommands[i];
      setAnalysisProgress(Math.round(((i + 1) / totalCmds) * 100));
      try {
        const res = await obd.query(cmd);
        if (res && res.value !== null && res.value !== 'NO DATA' && res.value !== 'ERROR') {
          results.push({ name: cmd.name, desc: cmd.desc, value: res.value, unit: res.unit || '' });
        }
      } catch (err) {}
      await new Promise(r => setTimeout(r, 150));
    }
    setAnalysisResults(results); setIsAnalyzing(false); telemetry.setPaused(false);
  };

  // --- ЛОГІКА ДЕТАЛЬНОГО ГРАФІКА ---
  const renderDetailedGraph = () => {
    if (!selectedGraph) return null;
    const fullData = telemetry.history[selectedGraph.id];
    if (!fullData || fullData.length === 0) return <div className="text-center py-10 text-gray-500">Немає даних</div>;
    
    const now = Date.now();
    let timeLimit = now;
    if (graphTimeframe === '1m') timeLimit = now - (60 * 1000);
    if (graphTimeframe === '30m') timeLimit = now - (30 * 60 * 1000);
    if (graphTimeframe === '1h') timeLimit = now - (60 * 60 * 1000);
    if (graphTimeframe === '24h') timeLimit = now - (24 * 60 * 60 * 1000);

    const filteredData = fullData.filter(d => d.t >= timeLimit);
    
    if (filteredData.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center py-10">
          <div className="text-gray-500 mb-2 text-xs">Немає активних даних за цей період.</div>
          <div className="text-[10px] text-gray-600">Остання активність: {new Date(fullData[fullData.length-1].t).toLocaleString('uk-UA')}</div>
        </div>
      );
    }

    const values = filteredData.map(d => d.v);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min === 0 ? 1 : max - min;
    
    const firstPointTime = filteredData[0].t;
    const lastPointTime = filteredData[filteredData.length - 1].t;
    const totalTimeSpan = now - firstPointTime; 
    
    const isOfflineNow = (now - lastPointTime) > 15000; 

    const points = filteredData.map((d) => {
      const x = ((d.t - firstPointTime) / totalTimeSpan) * 100;
      const y = 100 - (((d.v - min) / range) * 100);
      return `${x},${y}`;
    }).join(' ');

    const lastX = ((lastPointTime - firstPointTime) / totalTimeSpan) * 100;
    const lastY = 100 - (((filteredData[filteredData.length - 1].v - min) / range) * 100);

    return (
      <div className="flex flex-col relative w-full h-[240px]">
        <div className="flex gap-2 mb-2 justify-center">
          {['1m', '30m', '1h', '24h'].map(tf => (
            <button key={tf} onClick={() => setGraphTimeframe(tf)} className={`px-3 py-1 rounded-full text-[10px] font-bold ${graphTimeframe === tf ? 'bg-gray-700 text-white' : 'bg-gray-900/50 text-gray-500 border border-gray-800'}`}>
              {tf.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="absolute top-10 right-2 text-[10px] font-bold" style={{ color: selectedGraph.color }}>
          Макс: {Math.round(max)} {selectedGraph.unit}
        </div>
        
        <div className="flex-1 relative mt-2">
          <svg viewBox="0 0 100 100" className="w-full h-full overflow-visible" preserveAspectRatio="none">
            {filteredData.length > 1 ? (
              <polyline fill="none" stroke={selectedGraph.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" points={points} className="drop-shadow-lg" />
            ) : (
              <circle cx={lastX} cy={lastY} r="2" fill={selectedGraph.color} />
            )}
            
            {filteredData.length > 1 && (
              <polygon fill={`${selectedGraph.color}15`} points={`0,100 ${points} ${lastX},100`} />
            )}
            
            {isOfflineNow && (
              <>
                <line x1={lastX} y1={lastY} x2="100" y2={lastY} stroke="#4b5563" strokeWidth="2" strokeDasharray="2,2" />
                <rect x={lastX} y="0" width={100 - lastX} height="100" fill="url(#diagonalHatch)" opacity="0.3" />
                <defs>
                  <pattern id="diagonalHatch" width="4" height="4" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                    <line x1="0" y1="0" x2="0" y2="4" stroke="#4b5563" strokeWidth="1" />
                  </pattern>
                </defs>
              </>
            )}
          </svg>
        </div>
        
        <div className="flex justify-between mt-2 border-t border-gray-800/50 pt-2 text-[9px] text-gray-500 font-mono relative">
          <span>{new Date(firstPointTime).toLocaleTimeString('uk-UA', {hour:'2-digit', minute:'2-digit'})}</span>
          {isOfflineNow && <span className="absolute left-[80%] -translate-x-1/2 text-gray-600">Втрата зв'язку</span>}
          <span className={isOfflineNow ? 'text-gray-600' : 'text-gray-300'}>ЗАРАЗ</span>
        </div>
      </div>
    );
  };

  const renderMetricCard = (item, index) => {
    const cmdInfo = commands[item.id];
    const metricData = telemetry.metrics[item.id] ? telemetry.metrics[item.id] : { value: '--', unit: cmdInfo?.unit || '' };
    const isSpeedHero = item.id === 'SPEED' && item.size === 'col-span-3';

    return (
      <div key={item.id} draggable={isEditMode && !resizingItem.current} onDragStart={(e) => (dragItem.current = index)} onDragEnter={(e) => (dragOverItem.current = index)} onDragEnd={handleSort} onDragOver={(e) => e.preventDefault()}
        className={`relative ${item.size} bg-[#111318] p-4 rounded-2xl border ${isEditMode ? 'border-blue-500/50 cursor-move' : 'border-gray-800'} flex flex-col items-center justify-center transition-all duration-200 ${!item.visible && !isEditMode ? 'hidden' : ''} ${!item.visible && isEditMode ? 'opacity-30' : ''}`}
      >
        {isEditMode && (
          <>
            {/* КОМПАКТНІ ІКОНКИ ЗАМІСТЬ ТЕКСТУ */}
            <div className="absolute top-2 right-2 flex gap-1 z-10">
              <button 
                onClick={(e) => { e.stopPropagation(); setLayout(prev => prev.map(i => i.id === item.id ? {...i, size: 'col-span-1'} : i)); }} 
                className="p-1.5 rounded-lg border bg-gray-900/80 border-gray-700 hover:bg-gray-800 transition-colors"
                title="Скинути розмір"
              >
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" /></svg>
              </button>
              <button 
                onClick={(e) => { e.stopPropagation(); toggleVisibility(item.id); }} 
                className={`p-1.5 rounded-lg border flex items-center justify-center ${item.visible ? 'bg-gray-900/80 border-gray-700 hover:bg-gray-800' : 'bg-red-900/50 border-red-800/50'}`}
                title={item.visible ? 'Сховати' : 'Показати'}
              >
                <img src={item.visible ? HideIcon : ShowIcon} alt="toggle" className="w-3.5 h-3.5 opacity-80" />
              </button>
            </div>
            <div onMouseDown={(e) => handleResizeStart(e, item.id)} onTouchStart={(e) => handleResizeStart(e, item.id)} className="absolute bottom-0 right-0 w-8 h-8 cursor-ew-resize flex items-end justify-end p-1.5 z-20 opacity-50 hover:opacity-100">
              <div className="w-2.5 h-2.5 border-r-2 border-b-2 border-blue-400"></div>
            </div>
          </>
        )}

        {!telemetry.isConnected && !isEditMode && <div className="absolute top-3 left-3 w-1.5 h-1.5 rounded-full bg-gray-700/50"></div>}

        {isSpeedHero ? (
          <div className="relative w-56 h-56 rounded-full border-[6px] border-gray-800/80 flex flex-col justify-center items-center shadow-[0_0_30px_rgba(59,130,246,0.05)] bg-gradient-to-b from-[#0b0c10] to-[#111318]">
            <svg className="absolute inset-0 w-full h-full transform -rotate-90">
               <circle cx="106" cy="106" r="98" stroke="url(#blue-gradient)" strokeWidth="6" fill="none" strokeDasharray="615" strokeDashoffset={615 - ((metricData.value === '--' ? 0 : metricData.value) / 200 * 615)} strokeLinecap="round" className="transition-all duration-500 ease-out opacity-80" />
               <defs><linearGradient id="blue-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#60a5fa" /><stop offset="100%" stopColor="#2563eb" /></linearGradient></defs>
            </svg>
            <span className="text-6xl font-black tracking-tighter tabular-nums text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-400">{metricData.value}</span>
            <span className="text-[10px] text-gray-500 font-bold tracking-widest mt-1">КМ/ГОД</span>
          </div>
        ) : (
          <>
            <span className={`font-bold ${item.size === 'col-span-1' ? 'text-2xl' : 'text-4xl'} ${metricData.value === '--' ? 'text-gray-600' : 'text-white'}`}>
              {metricData.value}
              <span className="text-[10px] text-gray-500 ml-1 font-medium">{metricData.unit}</span>
            </span>
            <span className="text-[10px] text-gray-500/80 font-bold mt-1 text-center leading-tight uppercase tracking-wider">{cmdInfo?.desc || item.id}</span>
          </>
        )}
      </div>
    );
  };

  if (telemetry.isLoading) return <div className="min-h-screen bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;

  return (
    // Збільшено padding-bottom (pb-28), щоб контент не перекривався новим футером
    <div className="p-5 flex flex-col gap-5 animate-in fade-in duration-500 min-h-screen bg-[#050505] text-white overflow-x-hidden pb-28">
      
      <div className="bg-[#111318] p-1 rounded-xl border border-gray-800/80 flex relative">
        <button onClick={toggleMode} disabled={telemetry.isConnected} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all z-10 ${useEmulator ? 'text-white' : 'text-gray-500'}`}>💻 ЕМУЛЯТОР</button>
        <button onClick={toggleMode} disabled={telemetry.isConnected} className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all z-10 ${!useEmulator ? 'text-white' : 'text-gray-500'}`}>🚗 BLUETOOTH</button>
        <div className={`absolute top-1 bottom-1 w-[calc(50%-4px)] bg-blue-600/90 rounded-lg transition-all duration-300 ${useEmulator ? 'left-1' : 'left-[calc(50%+2px)]'}`} />
      </div>

      <header className="flex justify-between items-center">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border ${telemetry.isConnected ? 'bg-blue-500/10 border-blue-500/20' : 'bg-gray-900 border-gray-800'}`}>
          <div className={`w-1.5 h-1.5 rounded-full ${telemetry.isConnected ? 'bg-blue-500 animate-pulse' : 'bg-gray-600'}`}></div>
          <span className={`text-[10px] font-bold tracking-wider uppercase ${telemetry.isConnected ? 'text-blue-400' : 'text-gray-500'}`}>
            {telemetry.isConnected ? 'Підключено' : 'Офлайн'}
          </span>
        </div>
        
        <div className="flex gap-2">
          {isEditMode && <button onClick={handleCancelEdit} className="px-3 py-1.5 rounded-full text-[10px] font-bold bg-gray-800 text-gray-400 border border-gray-700">✕ СКАСУВАТИ</button>}
          <button onClick={handleEditToggle} className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${isEditMode ? 'bg-green-600/20 text-green-400 border border-green-500/30' : 'bg-gray-800/50 text-gray-400 border border-gray-700'}`}>
            {isEditMode ? '💾 ЗБЕРЕГТИ' : '⚙️ НАЛАШТУВАТИ'}
          </button>
        </div>
      </header>

      {!telemetry.isConnected ? (
        <button onClick={telemetry.connectOBD} disabled={telemetry.isConnecting} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-3.5 rounded-xl shadow-[0_0_15px_rgba(37,99,235,0.3)] transition-all text-sm">
          {telemetry.isConnecting ? 'З\'ЄДНАННЯ...' : 'ПІДКЛЮЧИТИ СКАНЕР'}
        </button>
      ) : (
        <button onClick={telemetry.disconnectOBD} className="w-full bg-red-950/40 hover:bg-red-900/50 text-red-400 font-bold py-3.5 rounded-xl border border-red-900/30 transition-all text-sm">
          ВІДКЛЮЧИТИ
        </button>
      )}

      <div className="grid grid-cols-3 gap-3">
        {layout.map((item, index) => renderMetricCard(item, index))}
      </div>

      <div className="bg-[#111318] rounded-2xl p-4 border border-gray-800/80">
        <h3 className="text-xs font-bold tracking-wide text-gray-300 mb-4 flex justify-between items-center">
          <span>Історія телеметрії</span>
          <span className="text-[9px] bg-gray-800 px-2 py-1 rounded text-gray-500 uppercase tracking-widest">Локальна БД</span>
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <MiniGraph data={telemetry.history.speed} color="#60a5fa" label="ШВИДКІСТЬ" unit="км/год" onClick={() => setSelectedGraph({ id: 'speed', label: 'Швидкість', color: '#60a5fa', unit: 'км/год' })} />
          <MiniGraph data={telemetry.history.fuel} color="#f472b6" label="ВИТРАТА" unit="%" onClick={() => setSelectedGraph({ id: 'fuel', label: 'Витрата палива', color: '#f472b6', unit: '%' })} />
          <MiniGraph data={telemetry.history.rpm} color="#a78bfa" label="ОБЕРТИ" unit="rpm" onClick={() => setSelectedGraph({ id: 'rpm', label: 'Оберти', color: '#a78bfa', unit: 'rpm' })} />
          <MiniGraph data={telemetry.history.temp} color="#34d399" label="ТЕМПЕРАТУРА" unit="°C" onClick={() => setSelectedGraph({ id: 'temp', label: 'Температура', color: '#34d399', unit: '°C' })} />
        </div>
      </div>

      <div className="bg-[#111318] rounded-2xl p-5 border border-gray-800/80 relative overflow-hidden">
        <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl ${telemetry.hasScannedErrors ? (telemetry.errors.length > 0 ? 'bg-red-500/10' : 'bg-green-500/5') : 'bg-gray-500/5'}`}></div>
        
        <div className="flex justify-between items-center mb-4 relative z-10">
          <h3 className="text-xs font-bold tracking-wide text-gray-300 uppercase">Діагностика ЕБУ (DTC)</h3>
          {telemetry.hasScannedErrors && <span className="text-[9px] text-gray-500">Останнє: {telemetry.lastScanTime}</span>}
        </div>
        
        {!telemetry.hasScannedErrors ? (
          <div className="text-center py-4 relative z-10">
            <div className="text-gray-500 text-xs mb-3">Статус системи невідомий.</div>
            <button onClick={telemetry.scanErrors} disabled={!telemetry.isConnected || telemetry.isCheckingErrors} className="bg-blue-600/10 text-blue-400 border border-blue-500/20 px-4 py-2 rounded-lg text-xs font-bold hover:bg-blue-600/20 disabled:opacity-30 transition-all">
              {telemetry.isCheckingErrors ? "СКАНУЮ..." : "ЗАПУСТИТИ АНАЛІЗ"}
            </button>
            {!telemetry.isConnected && <p className="text-[9px] text-red-400/80 mt-2">Потрібне підключення до авто</p>}
          </div>
        ) : telemetry.errors.length > 0 ? (
          <div className="space-y-2 relative z-10">
            <div className="text-[10px] text-red-400 font-bold mb-2 uppercase tracking-widest">{telemetry.errors.length} Помилки виявлено</div>
            {telemetry.errors.map((err, i) => (
              <div key={i} onClick={() => setSelectedError(err)} className="flex items-center justify-between bg-red-950/20 p-3 rounded-xl border border-red-900/30 cursor-pointer hover:bg-red-900/40 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 font-bold text-[10px]">!</div>
                  <div>
                    <div className="text-xs font-bold text-gray-200">{err.code}</div>
                    <div className="text-[10px] text-gray-500 truncate w-40">{err.title}</div>
                  </div>
                </div>
              </div>
            ))}
            <div className="flex gap-2 mt-4">
              <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.scanErrors} className="flex-1 bg-gray-800/50 border border-gray-700 py-2.5 rounded-xl text-[10px] text-gray-400 hover:text-white disabled:opacity-30 transition-colors font-bold">ОНОВИТИ</button>
              <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.clearErrors} className="flex-1 bg-red-950/50 border border-red-900/50 text-red-400 py-2.5 rounded-xl text-[10px] hover:bg-red-900 disabled:opacity-30 transition-colors font-bold">СТЕРТИ (04)</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-4 relative z-10">
            <div className="w-8 h-8 rounded-full bg-green-500/10 text-green-400 flex items-center justify-center mb-2 text-sm">✓</div>
            <div className="text-xs font-bold text-green-400/80">Система в нормі</div>
            <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.scanErrors} className="mt-2 text-[10px] text-gray-500 underline disabled:opacity-30">Пересканувати</button>
          </div>
        )}
      </div>

      <button onClick={runDetailedAnalysis} disabled={!telemetry.isConnected || isAnalyzing} className="w-full bg-[#111318] hover:bg-gray-900 disabled:bg-[#111318] text-blue-400/80 disabled:text-gray-600 font-bold py-4 rounded-2xl border border-gray-800 disabled:border-gray-800/50 transition-all flex items-center justify-center gap-2 text-xs tracking-wider">
        {!telemetry.isConnected ? 'ПІДКЛЮЧІТЬСЯ ДЛЯ АНАЛІЗУ' : 'РОЗШИРЕНИЙ АНАЛІЗ ECU'}
      </button>

      {/* НОВА ЕЛЕГАНТНА МОДАЛКА ГРАФІКІВ (BOTTOM SHEET) */}
      {selectedGraph && (
        <div className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm flex flex-col justify-end animate-in fade-in duration-200">
          <div className="bg-[#0b0c10] w-full rounded-t-3xl border-t border-gray-800 shadow-[0_-10px_40px_rgba(0,0,0,0.5)] pb-safe pt-2 px-5 animate-in slide-in-from-bottom-10">
            
            {/* Маленька "ручка" для свайпу (візуальна) */}
            <div className="w-12 h-1.5 bg-gray-800 rounded-full mx-auto mb-4"></div>
            
            <div className="flex justify-between items-center mb-2">
               <h2 className="text-lg font-bold text-white">
                 {selectedGraph.label}
               </h2>
               <button onClick={() => setSelectedGraph(null)} className="text-gray-400 bg-gray-900 p-1.5 rounded-full hover:bg-gray-800">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
               </button>
            </div>
            
            {/* Графік поміщений у контейнер фіксованої висоти */}
            <div className="bg-[#111318] p-3 rounded-2xl border border-gray-800/80 mb-6">
              {renderDetailedGraph()}
            </div>
          </div>
        </div>
      )}

      {/* МОДАЛКА ПОМИЛОК */}
      {selectedError && (
        <div className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-end justify-center animate-in fade-in">
          <div className="bg-[#0b0c10] border-t border-gray-800 rounded-t-3xl w-full flex flex-col shadow-2xl pb-8 animate-in slide-in-from-bottom-10">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318] rounded-t-3xl">
              <h2 className="font-bold text-sm text-white uppercase tracking-wider">Деталі помилки</h2>
              <button onClick={() => setSelectedError(null)} className="text-gray-500 p-1">✕</button>
            </div>
            
            <div className="p-6">
              <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
                <span className="text-xl font-black text-red-500">{selectedError.code}</span>
              </div>
              <h3 className="text-center text-sm font-bold text-gray-200 mb-2">{selectedError.title}</h3>
              <p className="text-center text-xs text-gray-500 mb-6 px-4">{selectedError.desc}</p>
              
              <div className="bg-blue-900/10 border border-blue-800/20 p-4 rounded-xl">
                <h4 className="text-[10px] font-bold text-blue-400 mb-2 uppercase tracking-wider">Розумна Діагностика</h4>
                <p className="text-[10px] text-gray-400 mb-4 leading-relaxed">
                  Наш ШІ може проаналізувати дані вашого авто за останні 7 днів, специфікації {telemetry.user?.make} {telemetry.user?.model} та цю помилку, щоб дати рекомендації та знайти найближче СТО.
                </p>
                <button className="w-full bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 font-bold py-3 rounded-xl flex justify-center items-center gap-2 text-xs transition-all">
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