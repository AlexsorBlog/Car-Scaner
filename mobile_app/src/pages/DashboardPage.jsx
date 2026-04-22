import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useTelemetry } from '../hooks/useTelemetry';
import { obdScanner } from '../services/bleService.js';
import { obd } from '../obd/index.js';
import { commands } from '../obd/commands.js';
import { getRecentTelemetry, saveDiagnosticReport, getDiagnosticReports } from '../services/db.js';
import { useNavigate } from 'react-router-dom';
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
    <div onClick={onClick} className="flex flex-col bg-[#111318] p-3 rounded-xl border border-gray-800 cursor-pointer hover:border-gray-600 transition-colors shadow-md">
      <div className="flex justify-between items-end mb-1">
        <span className="text-[10px] text-gray-500 font-bold">{label}</span>
        <span className="text-xs font-bold transition-all duration-300" style={{ color }}>{values[values.length-1]} <span className="text-[9px]">{unit}</span></span>
      </div>
      <svg viewBox="0 0 100 100" className="w-full h-10 overflow-visible" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" points={points} className="drop-shadow-md" />
        <polygon fill={`${color}20`} points={`0,100 ${points} 100,100`} />
      </svg>
    </div>
  );
};

export default function DashboardPage() {
  const navigate = useNavigate(); // Moved INSIDE the component
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
  
  const [selectedGraph, setSelectedGraph] = useState(null);
  const [graphTimeframe, setGraphTimeframe] = useState('1h');
  
  const [dbGraphData, setDbGraphData] = useState([]);
  const [isGraphLoading, setIsGraphLoading] = useState(false);

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [liveAnalysisResults, setLiveAnalysisResults] = useState([]); 
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  
  // History States
  const [diagnosticHistory, setDiagnosticHistory] = useState([]);
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [errorHistory, setErrorHistory] = useState([]);
  const [showErrorHistoryModal, setShowErrorHistoryModal] = useState(false);

  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  useEffect(() => {
    const activeSensors = layout.filter(item => item.visible).map(item => item.id);
    telemetry.updateActiveSensors(activeSensors);
    localStorage.setItem('obd_active_sensors', JSON.stringify(activeSensors));
  }, [layout, telemetry]);

  useEffect(() => {
    let interval;
    if (timerState === 'running') {
      interval = setInterval(() => setTime((prev) => prev + 10), 10);
      if (time > 4220) { setTimerState('finished'); clearInterval(interval); }
    }
    return () => clearInterval(interval);
  }, [timerState, time]);

  useEffect(() => {
    if (!selectedGraph) return;
    let isActive = true;
    const loadData = async () => {
      setIsGraphLoading(true);
      let ms = 60 * 1000;
      if (graphTimeframe === '30m') ms = 30 * 60 * 1000;
      if (graphTimeframe === '1h') ms = 60 * 60 * 1000;
      if (graphTimeframe === '24h') ms = 24 * 60 * 60 * 1000;
      const since = Date.now() - ms;
      
      const history = await getRecentTelemetry(5000, since);
      if (!isActive) return;
      
      const formatted = history
          .filter(d => d[selectedGraph.id.toLowerCase()] !== undefined)
          .map(d => ({ t: d.timestamp, v: d[selectedGraph.id.toLowerCase()] }));
      
      setDbGraphData(formatted);
      setIsGraphLoading(false);
    };
    loadData();
    return () => { isActive = false; };
  }, [selectedGraph, graphTimeframe]);

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

  const adjustSize = (id, delta) => {
    const sizes = ['col-span-1', 'col-span-2', 'col-span-3'];
    setLayout(prev => prev.map(item => {
      if (item.id === id) {
        let currIdx = sizes.indexOf(item.size);
        currIdx += delta;
        if (currIdx < 0) currIdx = 0;
        if (currIdx > 2) currIdx = 2;
        return { ...item, size: sizes[currIdx] };
      }
      return item;
    }));
  };

  const handleSort = () => {
    if (dragItem.current === null || dragOverItem.current === null) return;
    let _layout = [...layout];
    const draggedItemContent = _layout.splice(dragItem.current, 1)[0];
    _layout.splice(dragOverItem.current, 0, draggedItemContent);
    dragItem.current = null; dragOverItem.current = null;
    setLayout(_layout);
  };

  const toggleVisibility = (id) => setLayout(prev => prev.map(item => item.id === id ? { ...item, visible: !item.visible } : item));

  // Load history helpers
  const fetchAnalysisHistory = async () => {
    const reports = await getDiagnosticReports('detailed_analysis', 20);
    setDiagnosticHistory(reports);
  };

  const fetchErrorHistory = async () => {
    const reports = await getDiagnosticReports('scanned_errors', 20);
    setErrorHistory(reports);
  };

  const openAnalysisModal = () => {
    setShowAnalysisModal(true);
    fetchAnalysisHistory();
    setSelectedHistoryId("");
    if (liveAnalysisResults.length > 0) {
      setAnalysisResults(liveAnalysisResults);
    } else {
      setAnalysisResults([]);
    }
  };

  const runDetailedAnalysis = async () => {
    if (!telemetry.isConnected) return;
    if (!window.confirm("Повний аналіз всіх блоків може зайняти до 30 секунд. Продовжити?")) return;
    
    setIsAnalyzing(true); 
    setAnalysisResults([]); 
    setAnalysisProgress(0);
    setSelectedHistoryId(""); // Switch to live view
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
    
    setAnalysisResults(results); 
    setLiveAnalysisResults(results);
    setIsAnalyzing(false); 
    telemetry.setPaused(false);

    if (results.length > 0) {
      await saveDiagnosticReport('detailed_analysis', results);
      fetchAnalysisHistory(); // Refresh history list
    }
  };

  useEffect(() => {
    if (telemetry.hasScannedErrors && telemetry.errors.length > 0) {
      saveDiagnosticReport('scanned_errors', telemetry.errors);
    }
  }, [telemetry.hasScannedErrors, telemetry.errors]);

  const formatStepTime = (timestamp, timeframe) => {
    const date = new Date(timestamp);
    if (timeframe === '1m') return `${date.getSeconds()}s`;
    if (timeframe === '24h') return `${date.getHours()}:00`;
    return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  };

  const renderDetailedGraph = () => {
    if (!selectedGraph) return null;
    
    const liveData = telemetry.history[selectedGraph.id.toLowerCase()] || [];
    const dataMap = new Map();
    dbGraphData.forEach(d => dataMap.set(d.t, d.v));
    liveData.forEach(d => dataMap.set(d.t, d.v));

    const now = Date.now();
    let msLimit = 60 * 1000;
    if (graphTimeframe === '30m') msLimit = 30 * 60 * 1000;
    if (graphTimeframe === '1h') msLimit = 60 * 60 * 1000;
    if (graphTimeframe === '24h') msLimit = 24 * 60 * 60 * 1000;

    const minTime = now - msLimit;
    const totalTimeSpan = msLimit;

    const visibleData = Array.from(dataMap.entries())
      .map(([t, v]) => ({ t, v }))
      .filter(d => d.t >= minTime && d.t <= now)
      .sort((a, b) => a.t - b.t);

    if (isGraphLoading && visibleData.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center">
           <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
           <span className="text-gray-500 text-xs">Завантаження з БД...</span>
        </div>
      );
    }

    if (visibleData.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center py-10">
          <div className="text-gray-500 mb-2 text-xs">Немає активних даних за обраний період.</div>
        </div>
      );
    }

    const values = visibleData.map(d => d.v);
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const MathRange = max - min === 0 ? 1 : max - min; 

    const GAP_THRESHOLD = 15000; 
    const gaps = [];
    const segments = [];
    
    let currentSegment = [visibleData[0]];
    
    if (visibleData[0].t - minTime > GAP_THRESHOLD) {
        gaps.push({ start: minTime, end: visibleData[0].t });
    }
    
    for(let i = 1; i < visibleData.length; i++) {
       if(visibleData[i].t - visibleData[i-1].t > GAP_THRESHOLD) {
           gaps.push({ start: visibleData[i-1].t, end: visibleData[i].t });
           segments.push(currentSegment);
           currentSegment = [visibleData[i]];
       } else {
           currentSegment.push(visibleData[i]);
       }
    }
    segments.push(currentSegment);
    
    if (now - visibleData[visibleData.length-1].t > GAP_THRESHOLD) {
       gaps.push({ start: visibleData[visibleData.length-1].t, end: now });
    }

    const steps = [];
    const stepMs = msLimit / 4;
    for(let i = 0; i <= 4; i++) {
       steps.push(minTime + (i * stepMs));
    }

    return (
      <div className="flex flex-col relative w-full h-full min-h-[280px]">
        <div className="flex gap-2 mb-4 justify-center">
          {['1m', '30m', '1h', '24h'].map(tf => (
            <button key={tf} onClick={() => setGraphTimeframe(tf)} className={`px-4 py-1.5 rounded-full text-xs font-bold transition-colors ${graphTimeframe === tf ? 'bg-blue-600 text-white' : 'bg-gray-900/50 text-gray-400 border border-gray-800 hover:bg-gray-800'}`}>
              {tf.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="absolute top-14 right-2 text-xs font-bold z-20 bg-[#0b0c10]/80 px-2 py-1 rounded" style={{ color: selectedGraph.color }}>
          Макс: {Math.round(max)} {selectedGraph.unit}
        </div>
        
        <div className="flex-1 relative mt-2 border-b border-l border-gray-800/80">
          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full overflow-visible" preserveAspectRatio="none">
            <defs>
              <pattern id="diagonalHatch" width="4" height="4" patternTransform="rotate(45 0 0)" patternUnits="userSpaceOnUse">
                <line x1="0" y1="0" x2="0" y2="4" stroke="#4b5563" strokeWidth="1" />
              </pattern>
            </defs>
            
            {gaps.map((gap, idx) => {
               const x1 = ((gap.start - minTime) / totalTimeSpan) * 100;
               const x2 = ((gap.end - minTime) / totalTimeSpan) * 100;
               const safeX1 = Math.max(0, x1);
               const safeX2 = Math.min(100, x2);
               if (safeX2 <= safeX1) return null;
               
               return <rect key={`gap-${idx}`} x={safeX1} y="0" width={safeX2 - safeX1} height="100" fill="url(#diagonalHatch)" opacity="0.4" />
            })}

            {segments.map((seg, idx) => {
               if (seg.length === 1) {
                 const x = ((seg[0].t - minTime) / totalTimeSpan) * 100;
                 const y = 100 - (((seg[0].v - min) / MathRange) * 100);
                 return <circle key={`seg-dot-${idx}`} cx={x} cy={y} r="2" fill={selectedGraph.color} />;
               }
               
               const pts = seg.map((d) => {
                 const x = ((d.t - minTime) / totalTimeSpan) * 100;
                 const y = 100 - (((d.v - min) / MathRange) * 100);
                 return `${x},${y}`;
               }).join(' ');

               const firstX = ((seg[0].t - minTime) / totalTimeSpan) * 100;
               const lastX = ((seg[seg.length - 1].t - minTime) / totalTimeSpan) * 100;

               return (
                 <g key={`seg-group-${idx}`}>
                   <polygon fill={`${selectedGraph.color}20`} points={`${firstX},100 ${pts} ${lastX},100`} />
                   <polyline fill="none" stroke={selectedGraph.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points={pts} className="drop-shadow-lg" />
                 </g>
               );
            })}
          </svg>
        </div>
        
        <div className="flex justify-between w-full px-1 text-[9px] text-gray-500 font-mono mt-2">
            {steps.map((time, i) => (
                <span key={i}>{formatStepTime(time, graphTimeframe)}</span>
            ))}
        </div>
      </div>
    );
  };

  const renderMetricCard = (item, index) => {
    const cmdInfo = commands[item.id];
    const metricData = telemetry.metrics[item.id] ? telemetry.metrics[item.id] : { value: '--', unit: cmdInfo?.unit || '' };
    const isSpeedHero = item.id === 'SPEED' && item.size === 'col-span-3';
    
    const speedVal = metricData.value !== '--' ? Number(metricData.value) : 0;
    const normalizedSpeed = Math.min(Math.max(speedVal, 0), 220); 
    const needleAngle = -135 + ((normalizedSpeed / 220) * 270);
    const dynamicGlow = `0 0 ${15 + (speedVal / 3)}px rgba(59,130,246,${0.1 + (speedVal / 250)})`;

    return (
      <div key={item.id} draggable={isEditMode} onDragStart={(e) => (dragItem.current = index)} onDragEnter={(e) => (dragOverItem.current = index)} onDragEnd={handleSort} onDragOver={(e) => e.preventDefault()}
        className={`relative ${item.size} bg-[#111318] p-4 rounded-2xl border ${isEditMode ? 'border-blue-500/50 cursor-move pb-16' : 'border-gray-800'} flex flex-col items-center justify-center transition-all duration-300 ease-in-out ${!item.visible && !isEditMode ? 'hidden' : ''} ${!item.visible && isEditMode ? 'opacity-30' : ''}`}
      >
        {isEditMode && (
          <>
            <div className="absolute top-2 right-2 flex gap-1 z-10">
              <button onClick={(e) => { e.stopPropagation(); toggleVisibility(item.id); }} className={`p-1.5 rounded-lg border flex items-center justify-center ${item.visible ? 'bg-gray-900/80 border-gray-700 hover:bg-gray-800' : 'bg-red-900/50 border-red-800/50'}`} title={item.visible ? 'Сховати' : 'Показати'}>
                <img src={item.visible ? HideIcon : ShowIcon} alt="toggle" className="w-4 h-4 opacity-80" />
              </button>
            </div>
            <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-6 z-20">
              <button onClick={(e) => { e.stopPropagation(); adjustSize(item.id, -1); }} className="w-10 h-10 rounded-full bg-gray-900 border-2 border-gray-700 text-white font-black text-xl flex items-center justify-center hover:bg-gray-800 shadow-lg active:scale-95 transition-transform">-</button>
              <button onClick={(e) => { e.stopPropagation(); adjustSize(item.id, 1); }} className="w-10 h-10 rounded-full bg-gray-900 border-2 border-gray-700 text-white font-black text-xl flex items-center justify-center hover:bg-gray-800 shadow-lg active:scale-95 transition-transform">+</button>
            </div>
          </>
        )}

        {!telemetry.isConnected && !isEditMode && <div className="absolute top-3 left-3 w-1.5 h-1.5 rounded-full bg-gray-700/50"></div>}

        {isSpeedHero ? (
          <div className="relative w-56 h-56 rounded-full border-[6px] border-gray-800/80 flex flex-col justify-center items-center bg-gradient-to-b from-[#0b0c10] to-[#111318] transition-shadow duration-300" style={{ boxShadow: dynamicGlow }}>
            <svg className="absolute inset-0 w-full h-full transform -rotate-[135deg]">
               <circle cx="106" cy="106" r="98" stroke="url(#blue-gradient)" strokeWidth="6" fill="none" strokeDasharray="615" strokeDashoffset={615 - ((normalizedSpeed) / 220 * 461)} strokeLinecap="round" className="transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] opacity-90" />
               <defs><linearGradient id="blue-gradient" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#60a5fa" /><stop offset="100%" stopColor="#2563eb" /></linearGradient></defs>
            </svg>
            <div className="absolute inset-0 flex justify-center items-center pointer-events-none" style={{ transform: `rotate(${needleAngle}deg)`, transition: 'transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
               <div className="w-1.5 h-[90px] bg-red-500 rounded-full absolute bottom-1/2 shadow-[0_0_10px_rgba(239,68,68,0.8)] origin-bottom"></div>
               <div className="w-5 h-5 bg-[#0b0c10] border-[4px] border-red-500 rounded-full absolute"></div>
            </div>
            <span className="text-6xl font-black tracking-tighter tabular-nums text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-400 relative z-10 pt-10">{metricData.value}</span>
            <span className="text-[10px] text-gray-500 font-bold tracking-widest mt-1 relative z-10">КМ/ГОД</span>
          </div>
        ) : (
          <>
            <span className={`font-bold transition-all duration-300 tabular-nums ${item.size === 'col-span-1' ? 'text-2xl' : 'text-4xl'} ${metricData.value === '--' ? 'text-gray-600' : 'text-white'}`}>
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
          <button onClick={handleEditToggle} className={`px-3 py-1.5 rounded-full text-[10px] font-bold transition-all ${isEditMode ? 'bg-green-600/20 text-green-400 border border-green-500/30 shadow-md' : 'bg-gray-800/50 text-gray-400 border border-gray-700'}`}>
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

      <div className="bg-[#111318] rounded-2xl p-4 border border-gray-800/80 shadow-lg">
        <h3 className="text-xs font-bold tracking-wide text-gray-300 mb-4 flex justify-between items-center">
          <span>Історія телеметрії</span>
          <span className="text-[9px] bg-gray-800 px-2 py-1 rounded text-gray-500 uppercase tracking-widest">БД Графіки</span>
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <MiniGraph data={telemetry.history.speed} color="#60a5fa" label="ШВИДКІСТЬ" unit="км/год" onClick={() => setSelectedGraph({ id: 'SPEED', label: 'Швидкість', color: '#60a5fa', unit: 'км/год' })} />
          <MiniGraph data={telemetry.history.fuel} color="#f472b6" label="ВИТРАТА" unit="%" onClick={() => setSelectedGraph({ id: 'FUEL_LEVEL', label: 'Витрата палива', color: '#f472b6', unit: '%' })} />
          <MiniGraph data={telemetry.history.rpm} color="#a78bfa" label="ОБЕРТИ" unit="rpm" onClick={() => setSelectedGraph({ id: 'RPM', label: 'Оберти', color: '#a78bfa', unit: 'rpm' })} />
          <MiniGraph data={telemetry.history.temp} color="#34d399" label="ТЕМПЕРАТУРА" unit="°C" onClick={() => setSelectedGraph({ id: 'COOLANT_TEMP', label: 'Температура', color: '#34d399', unit: '°C' })} />
        </div>
      </div>

      <div className="bg-[#111318] rounded-2xl p-5 border border-gray-800/80 relative overflow-hidden shadow-lg">
        <div className={`absolute top-0 right-0 w-32 h-32 rounded-full blur-3xl ${telemetry.hasScannedErrors ? (telemetry.errors.length > 0 ? 'bg-red-500/10' : 'bg-green-500/5') : 'bg-gray-500/5'}`}></div>
        
        <div className="flex justify-between items-center mb-4 relative z-10">
          <h3 className="text-xs font-bold tracking-wide text-gray-300 uppercase">Діагностика ЕБУ (DTC)</h3>
          <button onClick={() => { fetchErrorHistory(); setShowErrorHistoryModal(true); }} className="text-[9px] bg-gray-800 text-gray-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors uppercase font-bold tracking-widest">Історія</button>
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
            <div className="flex justify-between items-center mb-2">
              <span className="text-[10px] text-red-400 font-bold uppercase tracking-widest">{telemetry.errors.length} Помилки виявлено</span>
              <span className="text-[9px] text-gray-500">{telemetry.lastScanTime}</span>
            </div>
            {telemetry.errors.map((err, i) => (
              <div key={i} onClick={() => navigate('/diagnostics', { state: { selectedError: err } })} className="flex items-center justify-between bg-red-950/20 p-3 rounded-xl border border-red-900/30 cursor-pointer hover:bg-red-900/40 transition-colors shadow-sm">
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
              <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.scanErrors} className="flex-1 bg-gray-800/50 border border-gray-700 py-2.5 rounded-xl text-[10px] text-gray-400 hover:text-white disabled:opacity-30 transition-colors font-bold shadow-sm">ОНОВИТИ</button>
              <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.clearErrors} className="flex-1 bg-red-950/50 border border-red-900/50 text-red-400 py-2.5 rounded-xl text-[10px] hover:bg-red-900 disabled:opacity-30 transition-colors font-bold shadow-sm">СТЕРТИ (04)</button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-4 relative z-10">
            <div className="w-8 h-8 rounded-full bg-green-500/10 text-green-400 flex items-center justify-center mb-2 text-sm shadow-sm">✓</div>
            <div className="text-xs font-bold text-green-400/80">Система в нормі</div>
            <span className="text-[9px] text-gray-500 mt-1">{telemetry.lastScanTime}</span>
            <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.scanErrors} className="mt-2 text-[10px] text-gray-500 underline disabled:opacity-30 hover:text-gray-400 transition-colors">Пересканувати</button>
          </div>
        )}
      </div>

      <button onClick={openAnalysisModal} className="w-full bg-[#111318] hover:bg-gray-900 text-blue-400/80 font-bold py-4 rounded-2xl border border-gray-800 transition-all flex items-center justify-center gap-2 text-xs tracking-wider shadow-md active:scale-[0.98]">
        РОЗШИРЕНИЙ ЗВІТ ЕБУ (ІСТОРІЯ)
      </button>

      {/* РОЗШИРЕНИЙ АНАЛІЗ ECU МОДАЛКА З ІСТОРІЄЮ */}
      {showAnalysisModal && (
        <div className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-end md:items-center justify-center animate-in fade-in duration-200">
          <div className="bg-[#0b0c10] w-full md:w-3/4 max-w-2xl rounded-t-3xl md:rounded-3xl border border-gray-800 shadow-2xl h-[85vh] md:h-[70vh] flex flex-col animate-in slide-in-from-bottom-10">
            <div className="p-5 border-b border-gray-800 flex flex-col gap-3 bg-[#111318] rounded-t-3xl">
              <div className="flex justify-between items-center">
                <h2 className="font-bold text-sm text-blue-400 uppercase tracking-wider flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                  Звіт ЕБУ
                </h2>
                <button onClick={() => setShowAnalysisModal(false)} className="text-gray-500 hover:text-white p-1">✕</button>
              </div>
              <div className="flex gap-2 items-center">
                <select 
                  className="bg-gray-900 border border-gray-700 text-xs text-white rounded-lg px-2 py-2 flex-1 focus:outline-none"
                  value={selectedHistoryId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedHistoryId(id);
                    if (id === "") {
                      setAnalysisResults(liveAnalysisResults);
                    } else {
                      const rep = diagnosticHistory.find(r => r.id.toString() === id);
                      if (rep) setAnalysisResults(rep.data);
                    }
                  }}
                >
                  <option value="">Поточна сесія (Сьогодні)</option>
                  {diagnosticHistory.map(r => (
                    <option key={r.id} value={r.id}>
                      {new Date(r.timestamp).toLocaleString('uk-UA')} ({r.data.length} блоків)
                    </option>
                  ))}
                </select>
                <button onClick={runDetailedAnalysis} disabled={!telemetry.isConnected || isAnalyzing} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-3 py-2 rounded-lg text-xs font-bold transition-colors">
                  НОВИЙ
                </button>
              </div>
            </div>
            
            <div className="p-5 flex-1 overflow-y-auto">
              {isAnalyzing ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <div className="relative w-24 h-24 mb-6 flex items-center justify-center">
                    <div className="absolute inset-0 border-4 border-gray-800 rounded-full"></div>
                    <div className="absolute inset-0 border-4 border-blue-500 rounded-full border-t-transparent animate-spin"></div>
                    <span className="text-xs font-bold text-blue-400">{analysisProgress}%</span>
                  </div>
                  <h3 className="text-gray-300 font-bold mb-2">Опитування блоків...</h3>
                  <p className="text-[10px] text-gray-500">Будь ласка, не вимикайте запалювання</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {analysisResults.length > 0 ? (
                    analysisResults.map((res, i) => (
                      <div key={i} className="flex justify-between items-center bg-[#111318] p-4 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors">
                        <div className="pr-4">
                          <div className="text-xs font-bold text-gray-200">{res.name}</div>
                          <div className="text-[10px] text-gray-500 leading-tight mt-1">{res.desc}</div>
                        </div>
                        <div className="text-right whitespace-nowrap">
                          <span className="text-lg font-black text-blue-400 tabular-nums">{res.value}</span>
                          <span className="text-[10px] text-gray-500 ml-1 font-medium">{res.unit}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-center py-20 text-gray-500 text-sm flex flex-col items-center">
                      <svg className="w-10 h-10 mb-4 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                      Немає даних аналізу
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ІСТОРІЯ ПОМИЛОК (DTC) МОДАЛКА */}
      {showErrorHistoryModal && (
         <div className="fixed inset-0 z-[115] bg-black/80 backdrop-blur-md flex items-end md:items-center justify-center animate-in fade-in p-4">
           <div className="bg-[#0b0c10] w-full max-w-2xl rounded-3xl border border-gray-800 shadow-2xl h-[70vh] flex flex-col animate-in zoom-in-95 overflow-hidden">
             <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
               <h2 className="text-sm font-bold text-white uppercase tracking-widest">Історія помилок (БД)</h2>
               <button onClick={() => setShowErrorHistoryModal(false)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
               </button>
             </div>
             <div className="flex-1 p-5 overflow-y-auto space-y-4">
               {errorHistory.length === 0 ? (
                 <div className="text-center py-10 text-gray-500 text-xs">Історія пуста.</div>
               ) : (
                 errorHistory.map((report) => (
                   <div key={report.id} className="bg-[#111318] p-4 rounded-xl border border-gray-800">
                     <div className="text-[10px] text-gray-500 font-bold mb-3 border-b border-gray-800 pb-2">
                       {new Date(report.timestamp).toLocaleString('uk-UA')}
                     </div>
                     <div className="space-y-2">
                       {report.data.map((err, i) => (
                         <div key={i} onClick={() => navigate('/diagnostics', { state: { selectedError: err } })} className="flex items-center gap-3 bg-red-950/10 p-2 rounded-lg border border-red-900/20 cursor-pointer hover:bg-red-900/30 transition-colors">
                           <div className="text-xs font-bold text-red-400">{err.code}</div>
                           <div className="text-[10px] text-gray-400 truncate">{err.title}</div>
                         </div>
                       ))}
                     </div>
                   </div>
                 ))
               )}
             </div>
           </div>
         </div>
      )}

      {/* ПОВНОЕКРАННА МОДАЛКА ГРАФІКІВ */}
      {selectedGraph && (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-200 p-4">
          <div className="bg-[#0b0c10] w-full max-w-3xl rounded-3xl border border-gray-800 shadow-2xl h-[75vh] flex flex-col animate-in zoom-in-95 overflow-hidden">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
              <h2 className="text-xl font-black text-white flex items-center gap-3">
                <div className="w-3 h-3 rounded-full shadow-lg" style={{ backgroundColor: selectedGraph.color, boxShadow: `0 0 10px ${selectedGraph.color}` }}></div>
                {selectedGraph.label}
              </h2>
              <button onClick={() => setSelectedGraph(null)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <div className="flex-1 p-5 bg-[#0b0c10] flex flex-col">
              {renderDetailedGraph()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}