import React, { useState, useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { obdScanner, TRANSPORT } from '../services/bleService.js'; 
import { obd } from '../obd/index.js';
import { commands } from '../obd/commands.js';
import { getRecentTelemetry, saveDiagnosticReport, getDiagnosticReports } from '../services/db.js';
import { useNavigate } from 'react-router-dom';
import HideIcon from '../assets/hide.svg';
import ShowIcon from '../assets/show.svg';
import SpeedIcon from '../assets/speedometer.svg';
import RpmIcon from '../assets/tachometer.svg';
import CoolantIcon from '../assets/thermometer.svg';
import FuelIcon from '../assets/fuel.svg';
import EngineIcon from '../assets/engine.svg';
import IntakeIcon from '../assets/thermometer-sun.svg';
import ThrottleIcon from '../assets/bar-chart.svg';

const INITIAL_LAYOUT = [
  { id: 'SPEED', visible: true, size: 'col-span-3' },
  { id: 'RPM', visible: true, size: 'col-span-1' },
  { id: 'COOLANT_TEMP', visible: true, size: 'col-span-1' },
  { id: 'FUEL_RATE', visible: true, size: 'col-span-1' },
  { id: 'ENGINE_LOAD', visible: true, size: 'col-span-1' },
  { id: 'INTAKE_TEMP', visible: true, size: 'col-span-1' },
  { id: 'THROTTLE_POS', visible: true, size: 'col-span-1' }
];

const WIDGET_ICONS = {
  SPEED: <img src={SpeedIcon} alt="Speed" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  RPM: <img src={RpmIcon} alt="RPM" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  COOLANT_TEMP: <img src={CoolantIcon} alt="Coolant Temp" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  FUEL_RATE: <img src={FuelIcon} alt="Fuel Rate" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  ENGINE_LOAD: <img src={EngineIcon} alt="Engine Load" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  INTAKE_TEMP: <img src={IntakeIcon} alt="Intake Temp" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  THROTTLE_POS: <img src={ThrottleIcon} alt="Throttle Pos" className="w-4 h-4 opacity-70" style={{ filter: 'invert(0.8)' }} />,
  DEFAULT: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4 opacity-70"><circle cx="12" cy="12" r="10"/></svg>
};

const get24hData = (dataArray) => {
  if (!dataArray || dataArray.length === 0) return [];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  return dataArray.filter(d => d.t >= cutoff);
};

const MiniGraph = ({ data, color, label, unit, onClick }) => {
  if (!data || data.length === 0) return (
    <div className="flex flex-col bg-[#111318] p-3 rounded-xl border border-gray-800">
      <div className="flex justify-between items-end mb-2">
        <span className="text-[10px] text-gray-500 font-bold">{label}</span>
      </div>
      <div className="h-10 w-full bg-gray-900/50 rounded-lg flex items-center justify-center">
        <span className="text-[9px] text-gray-600">Немає даних за добу</span>
      </div>
    </div>
  );

  const values = data.map(d => d.v);
  const rawMax = Math.max(...values);
  const rawMin = Math.min(...values);
  const valueRange = rawMax - rawMin === 0 ? 10 : rawMax - rawMin;
  const max = rawMax + (valueRange * 0.1); 
  const min = rawMin - (valueRange * 0.1); 
  const range = max - min;
  
  const points = data.map((d, i) => `${(i / (data.length - 1)) * 100},${100 - (((d.v - min) / range) * 100)}`).join(' ');

  return (
    <div onClick={onClick} className="flex flex-col bg-[#111318] p-3 rounded-xl border border-gray-800 cursor-pointer hover:border-gray-600 transition-colors shadow-md">
      <div className="flex justify-between items-end mb-1">
        <span className="text-[10px] text-gray-500 font-bold">{label}</span>
        <span className="text-xs font-bold transition-all duration-300" style={{ color }}>{values[values.length-1]} <span className="text-[9px]">{unit}</span></span>
      </div>
      <svg viewBox="0 0 100 100" className="w-full h-10 overflow-visible" preserveAspectRatio="none">
        <polyline fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={points} className="drop-shadow-md" />
        <polygon fill={`${color}20`} points={`0,100 ${points} 100,100`} />
      </svg>
    </div>
  );
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const telemetry = useTelemetry();
  
  const isNative = Capacitor.getPlatform() !== 'web';
  const [useEmulator, setUseEmulator] = useState(!isNative);
  
  // Система профілів лайаутів
  const [layouts, setLayouts] = useState(() => {
    const saved = localStorage.getItem('dashboardLayoutProfiles');
    if (saved) return JSON.parse(saved);
    const oldSaved = localStorage.getItem('dashboardLayout');
    const baseLayout = oldSaved ? JSON.parse(oldSaved) : INITIAL_LAYOUT;
    return [{ id: 'default', name: 'Основний', items: baseLayout }];
  });
  const [activeTabId, setActiveTabId] = useState(() => localStorage.getItem('dashboardActiveTabId') || 'default');
  
  // Поточний відображуваний макет (береться з масиву layouts)
  const [layout, setLayout] = useState(() => {
    return layouts.find(l => l.id === (localStorage.getItem('dashboardActiveTabId') || 'default'))?.items || INITIAL_LAYOUT;
  });

  const [originalLayout, setOriginalLayout] = useState(layout);
  const [isEditMode, setIsEditMode] = useState(false);
  
  const [selectedGraph, setSelectedGraph] = useState(null);
  
  // Graph State
  const [dbGraphData, setDbGraphData] = useState([]);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [panOffsetMs, setPanOffsetMs] = useState(0); 
  const [graphZoomMs, setGraphZoomMs] = useState(10 * 60 * 1000); 
  const touchStartX = useRef(null);
  const hasAutoJumped = useRef(false);

  // Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  
  // History States
  const [diagnosticHistory, setDiagnosticHistory] = useState([]);
  const [errorHistory, setErrorHistory] = useState([]);
  const [showErrorHistoryModal, setShowErrorHistoryModal] = useState(false);

  // Performance State
  const [perfState, setPerfState] = useState('idle'); 
  const [perfTime, setPerfTime] = useState(0);
  const [perfRecords, setPerfRecords] = useState([]);
  const [perfFilter, setPerfFilter] = useState(100); 
  const [selectedPerfRecord, setSelectedPerfRecord] = useState(null); 

  // Trip Distance State
  const [tripDistance, setTripDistance] = useState(0); // Дистанція в кілометрах
  const lastSpeedTime = useRef(Date.now());
  
  const perfInterval = useRef(null);
  const perfStartTime = useRef(null);
  const currentRunData = useRef([]);

  const dragItem = useRef(null);
  const dragOverItem = useRef(null);

  useEffect(() => {
    telemetry.setTransportMode(isNative ? TRANSPORT.NATIVE : TRANSPORT.EMULATOR);
  }, [isNative, telemetry]);

  useEffect(() => {
    const activeSensors = layout.filter(item => item.visible).map(item => item.id);
    telemetry.updateActiveSensors(activeSensors);
    localStorage.setItem('obd_active_sensors', JSON.stringify(activeSensors));
  }, [layout, telemetry]);

  useEffect(() => {
    const loadPerfRecords = async () => {
      const records = await getDiagnosticReports('perf_0_100', 20);
      setPerfRecords(records);
    };
    loadPerfRecords();
  }, []);

  useEffect(() => {
    const speed = telemetry.speed || 0;

    if (perfState === 'ready' && speed > 0) {
      setPerfState('running');
      perfStartTime.current = Date.now();
      currentRunData.current = [];
      
      perfInterval.current = setInterval(() => {
        setPerfTime(Date.now() - perfStartTime.current);
      }, 50);
    }

    if (perfState === 'running') {
      if (currentRunData.current.length === 0 || Date.now() - currentRunData.current[currentRunData.current.length-1].t > 100) {
         const safeNum = (val) => val && val !== '--' ? Number(val) : 0;

         currentRunData.current.push({
           t: Date.now() - perfStartTime.current,
           speed: speed,
           rpm: telemetry.rpm || 0,
           load: safeNum(telemetry.metrics['ENGINE_LOAD']?.value),
           throttle: safeNum(telemetry.metrics['THROTTLE_POS']?.value),
           coolant: safeNum(telemetry.metrics['COOLANT_TEMP']?.value),
           intake: safeNum(telemetry.metrics['INTAKE_TEMP']?.value)
         });
      }
    }
  }, [telemetry.speed, perfState, telemetry]);

  useEffect(() => {
    const now = Date.now();
    const timeDiffMs = now - lastSpeedTime.current;
    lastSpeedTime.current = now;

    // Рахуємо дистанцію тільки якщо ми підключені і авто рухається
    if (telemetry.isConnected && telemetry.speed > 0) {
      // Переводимо мілісекунди в години (1 год = 3 600 000 мс)
      const hoursPassed = timeDiffMs / 3600000;
      
      // Дистанція (км) = Швидкість (км/год) * Час (год)
      const distanceDelta = telemetry.speed * hoursPassed;
      
      setTripDistance(prev => prev + distanceDelta);
    }
  }, [telemetry.speed, telemetry.isConnected]);

  const togglePerfTimer = () => {
    if (perfState === 'idle' || perfState === 'finished') {
      if ((telemetry.speed || 0) > 0) {
          setPerfState('running');
          perfStartTime.current = Date.now();
          currentRunData.current = [];
          perfInterval.current = setInterval(() => setPerfTime(Date.now() - perfStartTime.current), 50);
      } else {
          setPerfState('ready');
          setPerfTime(0);
      }
    } else if (perfState === 'ready') {
      setPerfState('idle');
    } else if (perfState === 'running') {
      clearInterval(perfInterval.current);
      setPerfState('finished');
      
      const finalTime = Date.now() - perfStartTime.current;
      setPerfTime(finalTime);
      
      const newRecord = { timeMs: finalTime, telemetry: currentRunData.current };
      saveDiagnosticReport('perf_0_100', [newRecord]).then(() => {
         getDiagnosticReports('perf_0_100', 20).then(setPerfRecords);
      });
    }
  };

  const getMilestoneTime = (telemetryArray, targetSpeed) => {
      if (!telemetryArray || telemetryArray.length === 0) return null;
      const point = telemetryArray.find(d => d.speed >= targetSpeed);
      return point ? point.t : null;
  };

  const getMilestoneDistance = (telemetryArray, targetSpeed) => {
      if (!telemetryArray || telemetryArray.length < 2) return 0;
      let distanceKm = 0;
      
      for (let i = 1; i < telemetryArray.length; i++) {
          const prev = telemetryArray[i - 1];
          const curr = telemetryArray[i];

          // Різниця в часі у годинах
          const dtHours = (curr.t - prev.t) / 3600000;
          // Середня швидкість між двома точками
          const avgSpeed = (curr.speed + prev.speed) / 2; 
          
          distanceKm += (avgSpeed * dtHours);

          // Зупиняємо підрахунок, як тільки досягли потрібної швидкості
          if (curr.speed >= targetSpeed) {
              break; 
          }
      }
      return distanceKm * 1000; // Повертаємо метри
  };

  const formatPerfTime = (ms) => ms === null ? '--' : (ms / 1000).toFixed(2) + 's';

  useEffect(() => {
    if (!selectedGraph) {
       hasAutoJumped.current = false;
       return;
    }
    
    let isActive = true;
    const loadData = async () => {
      setIsGraphLoading(true);
      const since = Date.now() - (7 * 24 * 60 * 60 * 1000); 
      
      const history = await getRecentTelemetry(50000, since);
      if (!isActive) return;
      
      const formatted = history
          .filter(d => d[selectedGraph.id.toLowerCase()] !== undefined)
          .map(d => ({ t: d.timestamp, v: d[selectedGraph.id.toLowerCase()] }));
      
      setDbGraphData(formatted);
      setIsGraphLoading(false);
      
      if (!hasAutoJumped.current) {
          setPanOffsetMs(0); 
      }
    };
    loadData();
    return () => { isActive = false; };
  }, [selectedGraph]);

  useEffect(() => {
    if (!selectedGraph || isGraphLoading || hasAutoJumped.current) return;
    
    const liveData = telemetry.history[selectedGraph.id.toLowerCase()] || [];
    if (dbGraphData.length > 0 || liveData.length > 0) {
        const now = Date.now();
        const lastLive = liveData.length > 0 ? liveData[liveData.length - 1].t : 0;
        const lastDb = dbGraphData.length > 0 ? dbGraphData[dbGraphData.length - 1].t : 0;
        const lastTime = Math.max(lastLive, lastDb);
        
        if (lastTime > 0 && lastTime < (now - graphZoomMs)) {
            setPanOffsetMs(Math.max(0, now - lastTime - (graphZoomMs * 0.2)));
        }
        hasAutoJumped.current = true;
    }
  }, [dbGraphData, isGraphLoading, selectedGraph, graphZoomMs, telemetry.history]);

  const toggleMode = () => {
    if (telemetry.isConnected) return; 
    const nextEmulator = !useEmulator;
    setUseEmulator(nextEmulator);
    telemetry.setTransportMode(nextEmulator ? TRANSPORT.EMULATOR : TRANSPORT.NATIVE); 
  };

  // --- ЛОГІКА ПРОФІЛІВ (ВКЛАДОК) ---
  const switchTab = (id) => {
    if (isEditMode) return; 
    setActiveTabId(id);
    const newLayout = layouts.find(l => l.id === id)?.items || INITIAL_LAYOUT;
    setLayout(newLayout);
    localStorage.setItem('dashboardActiveTabId', id);
  };

  const addTab = () => {
    if (layouts.length >= 4) return;
    const newId = 'custom_' + Date.now();
    const newName = `Профіль ${layouts.length}`;
    const newLayouts = [...layouts, { id: newId, name: newName, items: INITIAL_LAYOUT }];
    
    setLayouts(newLayouts);
    localStorage.setItem('dashboardLayoutProfiles', JSON.stringify(newLayouts));
    
    // Одразу активуємо нову вкладку
    setActiveTabId(newId);
    setLayout(INITIAL_LAYOUT);
    localStorage.setItem('dashboardActiveTabId', newId);
  };

  const deleteTab = (id) => {
    const newLayouts = layouts.filter(l => l.id !== id);
    setLayouts(newLayouts);
    localStorage.setItem('dashboardLayoutProfiles', JSON.stringify(newLayouts));
    
    if (activeTabId === id) {
      setActiveTabId('default');
      setLayout(newLayouts.find(l => l.id === 'default').items);
      localStorage.setItem('dashboardActiveTabId', 'default');
    }
  };

  // Функція перейменування вкладки
  const renameTab = (id, currentName) => {
    const newName = window.prompt("Введіть нову назву для вкладки:", currentName);
    if (newName && newName.trim().length > 0) {
       const newLayouts = layouts.map(l => l.id === id ? { ...l, name: newName.trim() } : l);
       setLayouts(newLayouts);
       localStorage.setItem('dashboardLayoutProfiles', JSON.stringify(newLayouts));
    }
  };

  const handleEditToggle = () => {
    if (isEditMode) {
      const newLayouts = layouts.map(l => l.id === activeTabId ? { ...l, items: layout } : l);
      setLayouts(newLayouts);
      localStorage.setItem('dashboardLayoutProfiles', JSON.stringify(newLayouts));
    } else {
      setOriginalLayout([...layout]);
    }
    setIsEditMode(!isEditMode);
  };
  
  const handleCancelEdit = () => { setLayout(originalLayout); setIsEditMode(false); };

  const adjustSize = (id, delta) => {
    const sizes = ['col-span-1', 'col-span-2', 'col-span-3'];
    setLayout(prev => prev.map(item => {
      if (item.id === id) {
        let currIdx = sizes.indexOf(item.size);
        currIdx += delta;
        currIdx = Math.max(0, Math.min(2, currIdx));
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

  const fetchAnalysisHistory = async () => {
    const reports = await getDiagnosticReports('detailed_analysis', 10);
    setDiagnosticHistory(reports);
  };

  const fetchErrorHistory = async () => {
    const reports = await getDiagnosticReports('scanned_errors', 20);
    setErrorHistory(reports);
  };

  const openAnalysisModal = () => {
    setShowAnalysisModal(true);
    fetchAnalysisHistory();
    setAnalysisResults([]); 
  };

  const runDetailedAnalysis = async () => {
    if (!telemetry.isConnected) return;
    if (!window.confirm("Аналіз може зайняти до 30 секунд. Продовжити?")) return;
    
    setIsAnalyzing(true); 
    setAnalysisResults([]); 
    setAnalysisProgress(0);
    telemetry.setPaused(true);
    
    const allCommands = Object.values(commands);
    const totalCmds = allCommands.length;
    const results = [];
    
    for (let i = 0; i < totalCmds; i++) {
      const cmd = allCommands[i];
      setAnalysisProgress(Math.round(((i + 1) / totalCmds) * 100));
      if (
        cmd.name.includes('PIDS_') ||     // Пропускаємо бітові маски (PIDS_A, DTC_PIDS_B тощо)
        cmd.name.includes('MIDS_') ||     // Пропускаємо маски моніторів (MIDS_A)
        cmd.name.startsWith('MONITOR_')   // Пропускаємо всі нерозшифровані тести Mode 06
      ) {
        continue; // Переходимо до наступної команди без запиту
      }
      try {
        const res = await obd.query(cmd);
        if (res && res.value !== null && res.value !== 'NO DATA' && res.value !== 'ERROR') {
          results.push({ name: cmd.name, desc: cmd.desc, value: res.value, unit: res.unit || '' });
        }
      } catch (err) {}
      await new Promise(r => setTimeout(r, 100));
    }
    
    setAnalysisResults(results); 
    setIsAnalyzing(false); 
    telemetry.setPaused(false);

    if (results.length > 0) {
      await saveDiagnosticReport('detailed_analysis', results);
      fetchAnalysisHistory(); 
    }
  };

  useEffect(() => {
    if (telemetry.hasScannedErrors && telemetry.errors.length > 0) {
      saveDiagnosticReport('scanned_errors', telemetry.errors);
    }
  }, [telemetry.hasScannedErrors, telemetry.errors]);

  const handleZoomChange = (newZoomMs) => {
      if (panOffsetMs > 0) {
          const currentCenterOffset = panOffsetMs + (graphZoomMs / 2);
          setPanOffsetMs(Math.max(0, currentCenterOffset - (newZoomMs / 2)));
      }
      setGraphZoomMs(newZoomMs);
  };

  const renderDetailedGraph = () => {
    if (!selectedGraph) return null;
    
    const liveData = telemetry.history[selectedGraph.id.toLowerCase()] || [];
    const dataMap = new Map();
    dbGraphData.forEach(d => dataMap.set(d.t, d.v));
    liveData.forEach(d => dataMap.set(d.t, d.v));

    const now = Date.now();
    const WINDOW_MS = graphZoomMs; 
    
    const viewEndTime = now - panOffsetMs;
    const viewStartTime = viewEndTime - WINDOW_MS;

    const visibleData = Array.from(dataMap.entries())
      .map(([t, v]) => ({ t, v }))
      .filter(d => d.t >= viewStartTime && d.t <= viewEndTime)
      .sort((a, b) => a.t - b.t);

    const jumpToLastActivity = () => {
       const allData = Array.from(dataMap.entries()).sort((a, b) => a[0] - b[0]);
       if (allData.length > 0) {
          const lastPointTime = allData[allData.length - 1][0];
          setPanOffsetMs(Math.max(0, now - lastPointTime - (graphZoomMs * 0.2)));
       }
    };

    const formatTimeAxis = (time) => {
        const date = new Date(time);
        if (WINDOW_MS >= 24 * 60 * 60 * 1000) {
           return date.toLocaleDateString('uk-UA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleTimeString('uk-UA', {hour: '2-digit', minute:'2-digit'});
    };

    if (isGraphLoading && visibleData.length === 0) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center">
           <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mb-4"></div>
           <span className="text-gray-500 text-xs">Завантаження...</span>
        </div>
      );
    }

    let max = 100;
    let min = 0;
    let MathRange = 100;

    if (visibleData.length > 0) {
        const values = visibleData.map(d => d.v);
        const rawMax = Math.max(...values);
        const rawMin = Math.min(...values);
        const valueRange = rawMax - rawMin === 0 ? 10 : rawMax - rawMin;
        max = rawMax + (valueRange * 0.1); 
        min = rawMin - (valueRange * 0.1); 
        MathRange = max - min; 
    }

    const ySteps = [0, 0.25, 0.5, 0.75, 1];
    const GAP_THRESHOLD = 15 * 60 * 1000; 
    const segments = [];
    
    if (visibleData.length > 0) {
        let currentSegment = [visibleData[0]];
        for(let i = 1; i < visibleData.length; i++) {
           if(visibleData[i].t - visibleData[i-1].t > GAP_THRESHOLD) {
               segments.push(currentSegment);
               currentSegment = [visibleData[i]];
           } else {
               currentSegment.push(visibleData[i]);
           }
        }
        segments.push(currentSegment);
    }
    
    const handleTouchStart = (e) => { touchStartX.current = e.touches[0].clientX; };
    const handleTouchMove = (e) => {
      if (touchStartX.current === null) return;
      const currentX = e.touches[0].clientX;
      const diffPixels = currentX - touchStartX.current;
      const msPerPixel = WINDOW_MS / window.innerWidth;
      
      setPanOffsetMs(prev => Math.max(0, prev + (diffPixels * msPerPixel)));
      touchStartX.current = currentX; 
    };
    const handleTouchEnd = () => { touchStartX.current = null; };

    return (
      <div className="flex flex-col relative w-full h-full min-h-[350px]">
        <div className="flex gap-2 mb-2 justify-center flex-wrap">
            {[
                { label: '1 хв', ms: 60 * 1000 },
                { label: '5 ХВ', ms: 5 * 60 * 1000 },
                { label: '30 ХВ', ms: 30 * 60 * 1000 },
                { label: '24 ГОД', ms: 24 * 60 * 60 * 1000 },
                { label: '7 ДНІВ', ms: 7 * 24 * 60 * 60 * 1000 }
            ].map(zoom => (
                <button
                    key={zoom.label}
                    onClick={() => handleZoomChange(zoom.ms)}
                    className={`px-3 py-1 rounded-full text-[10px] font-bold ${graphZoomMs === zoom.ms ? 'bg-blue-600 text-white shadow-md' : 'bg-[#111318] border border-gray-800 text-gray-500 hover:text-white'}`}
                >
                    {zoom.label}
                </button>
            ))}
        </div>
        
        <div className="flex justify-between items-end mb-4">
          <div>
            <div className="text-xl font-bold" style={{ color: selectedGraph.color }}>
              {visibleData.length > 0 ? visibleData[visibleData.length-1]?.v : '--'} {selectedGraph.unit}
            </div>
            <div className="text-[10px] text-gray-500">
              {panOffsetMs > 0 ? 'Архівне значення' : 'Поточне значення'}
            </div>
          </div>
          {panOffsetMs > 0 && (
             <button onClick={() => setPanOffsetMs(0)} className="bg-blue-600/20 text-blue-400 border border-blue-500/50 px-3 py-1 rounded-lg text-xs font-bold animate-pulse">
               ДО "ЗАРАЗ"
             </button>
          )}
        </div>
        
        <div className="flex-1 relative mt-2 border-b border-l border-gray-800/80 cursor-ew-resize touch-pan-x overflow-hidden" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
          {ySteps.map((pct, i) => {
             const val = min + (MathRange * pct);
             return (
               <div key={i} className="absolute left-[-35px] text-[9px] text-gray-500" style={{ bottom: `${pct * 100}%`, transform: 'translateY(50%)' }}>
                 {Math.round(val)}
               </div>
             )
          })}

          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full overflow-visible" preserveAspectRatio="none">
            {ySteps.map((pct, i) => (
               <line key={`grid-${i}`} x1="0" y1={100 - (pct * 100)} x2="100" y2={100 - (pct * 100)} stroke="#1f2937" strokeWidth="0.5" strokeDasharray="2,2" />
            ))}

            {segments.map((seg, idx) => {
               if (seg.length <= 1) return null;
               
               const pts = seg.map((d) => {
                 const x = ((d.t - viewStartTime) / WINDOW_MS) * 100;
                 const y = 100 - (((d.v - min) / MathRange) * 100);
                 return `${x},${y}`;
               }).join(' ');

               return (
                 <polyline key={`line-${idx}`} fill="none" stroke={selectedGraph.color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts} className="drop-shadow-lg" />
               );
            })}
          </svg>

          {visibleData.length === 0 && (
             <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span className="text-gray-500 text-xs font-bold mb-2">Немає даних</span>
                {panOffsetMs > 0 ? (
                   <span className="text-[9px] text-gray-600">Свайпайте далі або натисніть «ДО ЗАРАЗ»</span>
                ) : (
                   <span className="text-[9px] text-gray-600">Очікування підключення або змініть масштаб</span>
                )}
             </div>
          )}
        </div>
        
        <div className="flex justify-between w-full pl-2 pr-1 text-[9px] text-gray-500 font-mono mt-2">
            <span>{formatTimeAxis(viewStartTime)}</span>
            <span>{formatTimeAxis(viewStartTime + WINDOW_MS/2)}</span>
            <span>{formatTimeAxis(viewEndTime)}</span>
        </div>

        {visibleData.length === 0 && dataMap.size > 0 && (
           <div className="mt-4 flex justify-center">
              <button onClick={jumpToLastActivity} className="text-gray-300 text-xs bg-gray-800 px-4 py-2 rounded-lg border border-gray-700 shadow-md">
                 Перейти до останньої поїздки
              </button>
           </div>
        )}
      </div>
    );
  };

  const renderMetricCard = (item, index) => {
    const cmdInfo = commands[item.id];
    const metricData = telemetry.metrics[item.id] ? telemetry.metrics[item.id] : { value: '--', unit: cmdInfo?.unit || '' };
    const isSpeedHero = item.id === 'SPEED' && item.size === 'col-span-3';
    const isWaitingData = telemetry.isConnected && metricData.value === '--';

    const speedVal = metricData.value !== '--' ? Number(metricData.value) : 0;
    const normalizedSpeed = Math.min(Math.max(speedVal, 0), 220); 
    const needleAngle = -135 + ((normalizedSpeed / 220) * 270);
    const dynamicGlow = `0 0 ${15 + (speedVal / 3)}px rgba(59,130,246,${0.1 + (speedVal / 250)})`;

    return (
      <div key={item.id} draggable={isEditMode} onDragStart={(e) => (dragItem.current = index)} onDragEnter={(e) => (dragOverItem.current = index)} onDragEnd={handleSort} onDragOver={(e) => e.preventDefault()}
        className={`relative ${item.size} bg-[#111318] p-4 rounded-2xl border ${isEditMode ? 'border-blue-500/50 cursor-move pb-16' : 'border-gray-800'} flex flex-col items-center justify-center transition-all duration-300 ease-in-out ${!item.visible && !isEditMode ? 'hidden' : ''} ${!item.visible && isEditMode ? 'opacity-30' : ''}`}
      >
        {!isSpeedHero && !isEditMode && (
          <div className="absolute top-2 right-2 text-gray-700">
            {WIDGET_ICONS[item.id] || WIDGET_ICONS.DEFAULT}
          </div>
        )}

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
            
            {isWaitingData ? (
               <div className="text-gray-600 animate-pulse mt-4">Очікування...</div>
            ) : (
               <span className="text-6xl font-black tracking-tighter tabular-nums text-transparent bg-clip-text bg-gradient-to-b from-white to-gray-400 relative z-10 pt-10">{metricData.value}</span>
            )}
            <span className="text-[10px] text-gray-500 font-bold tracking-widest mt-1 relative z-10">КМ/ГОД</span>
            
            {/* НОВИЙ БЛОК: Пройдена дистанція */}
            {!isWaitingData && (
              <div className="mt-2 flex flex-col items-center relative z-10 bg-[#050505]/50 px-4 py-1 rounded-full border border-gray-800/80 shadow-inner">
                <span className="text-[8px] text-gray-500 uppercase tracking-widest">Проїхано (Trip)</span>
                {/* toFixed(3) показуватиме точність до метрів (напр. 1.254 км) */}
                <span className="text-xs font-bold text-blue-400 tabular-nums">{tripDistance.toFixed(3)} км</span>
              </div>
            )}
          </div>
        ) : (
          <>
            {isWaitingData ? (
               <div className="h-8 flex items-center justify-center">
                 <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
               </div>
            ) : (
               <span className={`font-bold transition-all duration-300 tabular-nums ${item.size === 'col-span-1' ? 'text-2xl' : 'text-4xl'} ${metricData.value === '--' ? 'text-gray-600' : 'text-white'}`}>
                 {metricData.value}
                 <span className="text-[10px] text-gray-500 ml-1 font-medium">{metricData.unit}</span>
               </span>
            )}
            <span className="text-[10px] text-gray-500/80 font-bold mt-1 text-center leading-tight uppercase tracking-wider">{cmdInfo?.desc || item.id}</span>
          </>
        )}
      </div>
    );
  };

  if (telemetry.isLoading) return <div className="min-h-screen bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;

  const filteredPerfRecords = perfRecords.filter(r => {
      const runData = r.data[0]?.telemetry || [];
      return getMilestoneTime(runData, perfFilter) !== null;
  });

  let bestPerfRecord = null;
  if (filteredPerfRecords.length > 0) {
      bestPerfRecord = [...filteredPerfRecords].sort((a,b) => getMilestoneTime(a.data[0].telemetry, perfFilter) - getMilestoneTime(b.data[0].telemetry, perfFilter))[0];
  }
  const recentPerfRecords = filteredPerfRecords.slice(0, 3);

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

      {/* СИСТЕМА ПРОФІЛІВ (ВКЛАДКИ) */}
      <div className="flex gap-2 overflow-x-auto pb-1 mt-2 scrollbar-hide">
         {layouts.map(l => (
            <div key={l.id} className="relative flex items-center">
               <button
                 onClick={() => {
                    if (isEditMode) {
                       if (activeTabId === l.id) renameTab(l.id, l.name);
                       return;
                    }
                    switchTab(l.id);
                 }}
                 className={`flex items-center gap-1 px-4 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-all ${activeTabId === l.id ? 'bg-blue-600 text-white shadow-md' : 'bg-[#111318] border border-gray-800 text-gray-500 hover:text-white'} ${isEditMode && activeTabId !== l.id ? 'opacity-50 cursor-not-allowed' : ''}`}
               >
                  {l.name}
                  {isEditMode && activeTabId === l.id && <span className="ml-1 opacity-70">✏️</span>}
               </button>
               {/* Кнопка видалення кастомної вкладки під час режиму редагування */}
               {isEditMode && l.id !== 'default' && activeTabId === l.id && (
                  <button onClick={(e) => { e.stopPropagation(); deleteTab(l.id); }} className="absolute -top-1 -right-1 bg-red-600 text-white w-4 h-4 rounded-full text-[10px] flex items-center justify-center font-bold shadow-md hover:bg-red-500 z-20">
                     ×
                  </button>
               )}
            </div>
         ))}
         {layouts.length < 4 && !isEditMode && (
            <button
               onClick={addTab}
               className="px-3 py-1.5 rounded-full text-xs font-bold bg-[#111318] border border-dashed border-gray-700 text-gray-400 hover:text-white transition-colors flex-shrink-0"
            >
               + ДОДАТИ
            </button>
         )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        {layout.map((item, index) => renderMetricCard(item, index))}
      </div>

      <div className="bg-[#111318] rounded-2xl p-4 border border-gray-800/80 shadow-lg">
        <h3 className="text-xs font-bold tracking-wide text-gray-300 mb-4 flex justify-between items-center">
          <span>Історія телеметрії</span>
          <span className="text-[9px] bg-gray-800 px-2 py-1 rounded text-gray-500 uppercase tracking-widest">БД Графіки</span>
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <MiniGraph data={get24hData(telemetry.history.speed)} color="#60a5fa" label="ШВИДКІСТЬ" unit="км/год" onClick={() => setSelectedGraph({ id: 'SPEED', label: 'Швидкість', color: '#60a5fa', unit: 'км/год' })} />
          <MiniGraph data={get24hData(telemetry.history.fuel)} color="#f472b6" label="ВИТРАТА" unit="л/год" onClick={() => setSelectedGraph({ id: 'FUEL_RATE', label: 'Витрата палива', color: '#f472b6', unit: 'л/год' })} />
          <MiniGraph data={get24hData(telemetry.history.rpm)} color="#a78bfa" label="ОБЕРТИ" unit="rpm" onClick={() => setSelectedGraph({ id: 'RPM', label: 'Оберти', color: '#a78bfa', unit: 'rpm' })} />
          <MiniGraph data={get24hData(telemetry.history.temp)} color="#34d399" label="ТЕМПЕРАТУРА" unit="°C" onClick={() => setSelectedGraph({ id: 'COOLANT_TEMP', label: 'Температура', color: '#34d399', unit: '°C' })} />
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

      {/* Віджет Динаміки з фільтрами */}
      <div className="bg-[#111318] p-4 rounded-2xl border border-gray-800 shadow-lg">
        <div className="flex justify-between items-center mb-4">
           <div className="flex items-center gap-2">
               <h3 className="text-xs font-bold tracking-wide text-gray-300 uppercase">Динаміка</h3>
               <select 
                  className="bg-gray-900 border border-gray-700 text-[10px] text-white rounded px-2 py-1 outline-none focus:border-blue-500"
                  value={perfFilter}
                  onChange={(e) => setPerfFilter(Number(e.target.value))}
               >
                  <option value={50}>0-50</option>
                  <option value={100}>0-100</option>
                  <option value={150}>0-150</option>
                  <option value={200}>0-200</option>
               </select>
           </div>
           <span className="text-[9px] bg-red-900/30 text-red-400 px-2 py-1 rounded font-bold uppercase tracking-widest">PERFORMANCE</span>
        </div>
        
        <div className="flex flex-col items-center justify-center p-4 bg-gray-950/50 rounded-xl border border-gray-800/50 mb-4">
           <div className="flex items-baseline gap-2 mb-2">
             <span className="text-4xl font-black tabular-nums font-mono text-white">
               {formatPerfTime(perfTime)}
             </span>
             {/* НОВИЙ БЛОК: Вивід метрів під час або після заміру */}
             {(perfState === 'running' || perfState === 'finished') && (
               <span className="text-sm font-bold text-gray-400 tabular-nums">
                 ({Math.round(getMilestoneDistance(currentRunData.current, perfFilter))} м)
               </span>
             )}
           </div>
           
           {perfState === 'idle' && (
              <button onClick={togglePerfTimer} disabled={!telemetry.isConnected} className="bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white font-bold py-2 px-8 rounded-full text-xs transition-colors shadow-[0_0_10px_rgba(37,99,235,0.3)]">
                ПОЧАТИ ЗАМІР
              </button>
           )}
           {perfState === 'ready' && (
              <div className="flex flex-col items-center">
                 <button onClick={togglePerfTimer} className="bg-orange-600 text-white font-bold py-2 px-8 rounded-full text-xs animate-pulse mb-1">ОЧІКУВАННЯ СТАРТУ...</button>
                 <span className="text-[9px] text-gray-500">Натисніть на газ для початку (очікування &gt; 0)</span>
              </div>
           )}
           {perfState === 'running' && (
              <button onClick={togglePerfTimer} className="bg-red-600 hover:bg-red-500 text-white font-bold py-2 px-8 rounded-full text-xs shadow-[0_0_10px_rgba(220,38,38,0.5)]">
                ЗУПИНИТИ ЗАМІР ({Math.round(telemetry.speed || 0)} км/год)
              </button>
           )}
           {perfState === 'finished' && (
              <button onClick={togglePerfTimer} className="bg-gray-800 hover:bg-gray-700 text-white font-bold py-2 px-8 rounded-full text-xs">
                СКИНУТИ
              </button>
           )}
        </div>

        {filteredPerfRecords.length > 0 ? (
          <div>
            <div className="text-[10px] text-gray-500 font-bold mb-2 uppercase">Рекорди 0-{perfFilter} км/год:</div>
            <div className="flex gap-2 overflow-x-auto pb-2">
               {bestPerfRecord && (
                  <div onClick={() => setSelectedPerfRecord(bestPerfRecord)} className="flex-shrink-0 bg-green-900/20 border border-green-800/50 p-2 rounded-lg text-center w-24 cursor-pointer hover:bg-green-900/40 transition-colors">
                    <div className="text-[9px] text-green-400 mb-1">РЕКОРД</div>
                    <div className="font-mono font-bold text-sm text-green-300">{formatPerfTime(getMilestoneTime(bestPerfRecord.data[0].telemetry, perfFilter))}</div>
                  </div>
               )}
               
               {recentPerfRecords.map((r, i) => {
                  const runMeters = Math.round(getMilestoneDistance(r.data[0].telemetry, perfFilter));
                  return (
                   <div key={i} onClick={() => setSelectedPerfRecord(r)} className="flex-shrink-0 bg-gray-900/50 border border-gray-800 p-2 rounded-lg text-center w-24 cursor-pointer hover:bg-gray-800 transition-colors">
                     <div className="text-[9px] text-gray-500 mb-1">{new Date(r.timestamp).toLocaleTimeString('uk-UA', {hour:'2-digit', minute:'2-digit'})}</div>
                     <div className="font-mono font-bold text-sm text-gray-300">{formatPerfTime(getMilestoneTime(r.data[0].telemetry, perfFilter))}</div>
                     <div className="text-[9px] text-blue-400/80 font-bold mt-0.5">{runMeters} м</div>
                   </div>
                  )
                })}
            </div>
          </div>
        ) : (
          <div className="text-center text-xs text-gray-600 py-2">
             Немає замірів для швидкості {perfFilter} км/год
          </div>
        )}
      </div>

      {/* РОЗШИРЕНИЙ АНАЛІЗ ECU МОДАЛКА З ІСТОРІЄЮ */}
      {showAnalysisModal && (
        <div className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-end md:items-center justify-center animate-in fade-in duration-200">
          <div className="bg-[#0b0c10] w-full md:w-3/4 max-w-2xl rounded-t-3xl md:rounded-3xl border border-gray-800 shadow-2xl h-[85vh] md:h-[70vh] flex flex-col animate-in slide-in-from-bottom-10">
            <div className="p-5 border-b border-gray-800 flex flex-col gap-4 bg-[#111318] rounded-t-3xl">
              <div className="flex justify-between items-center">
                <h2 className="font-bold text-sm text-blue-400 uppercase tracking-wider flex items-center gap-2">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"></path></svg>
                  Звіт ЕБУ
                </h2>
                <button onClick={() => setShowAnalysisModal(false)} className="text-gray-500 hover:text-white p-1">✕</button>
              </div>
              
              {analysisResults.length === 0 && (
                <button onClick={runDetailedAnalysis} disabled={!telemetry.isConnected || isAnalyzing} className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-3 rounded-xl text-xs font-bold transition-colors shadow-[0_0_15px_rgba(37,99,235,0.3)]">
                  + СТВОРИТИ НОВИЙ ЗВІТ
                </button>
              )}
              {analysisResults.length > 0 && (
                 <button onClick={() => setAnalysisResults([])} className="text-xs text-blue-400 text-left underline mb-2">← Назад до списку</button>
              )}
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
              ) : analysisResults.length > 0 ? (
                <div className="space-y-3">
                  {analysisResults.map((res, i) => (
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
                  ))}
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="text-[10px] text-gray-500 font-bold uppercase mb-2">Історія перевірок:</div>
                  {diagnosticHistory.length === 0 ? (
                    <div className="text-center py-10 text-gray-600 text-xs">Немає збережених звітів</div>
                  ) : (
                    diagnosticHistory.map(r => (
                      <div key={r.id} onClick={() => setAnalysisResults(r.data)} className="bg-[#111318] border border-gray-800 p-4 rounded-xl flex justify-between items-center cursor-pointer hover:bg-gray-900 transition-colors">
                        <div>
                           <div className="text-sm font-bold text-gray-200">{new Date(r.timestamp).toLocaleDateString('uk-UA')}</div>
                           <div className="text-[10px] text-gray-500">{new Date(r.timestamp).toLocaleTimeString('uk-UA')}</div>
                        </div>
                        <div className="text-xs text-blue-400 bg-blue-900/20 px-3 py-1 rounded-full">{r.data.length} параметрів →</div>
                      </div>
                    ))
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

      {/* ДЕТАЛІ ЗАМІРУ 0-100 (МАРКЕРИ ШВИДКОСТІ В СПИСКУ) */}
      {selectedPerfRecord && (
        <div className="fixed inset-0 z-[130] bg-black/80 backdrop-blur-md flex items-end md:items-center justify-center animate-in fade-in p-4">
           <div className="bg-[#0b0c10] w-full max-w-2xl rounded-3xl border border-gray-800 shadow-2xl h-[75vh] flex flex-col animate-in zoom-in-95 overflow-hidden">
              <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
                 <div>
                    <h2 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                       <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                       Замір динаміки
                    </h2>
                    <div className="text-[10px] text-gray-500 mt-1">{new Date(selectedPerfRecord.timestamp).toLocaleString('uk-UA')}</div>
                 </div>
                 <div className="flex items-center gap-4">
                    {/* НОВИЙ БЛОК: Вивід часу ТА дистанції у модалці */}
                    <div className="flex items-baseline gap-2">
                      <span className="text-2xl font-black text-white">
                        {formatPerfTime(getMilestoneTime(selectedPerfRecord.data[0].telemetry, perfFilter) || selectedPerfRecord.data[0].timeMs)}
                      </span>
                      <span className="text-sm font-bold text-gray-400 tabular-nums">
                        ({Math.round(getMilestoneDistance(selectedPerfRecord.data[0].telemetry, perfFilter))} м)
                      </span>
                    </div>
                    <button onClick={() => setSelectedPerfRecord(null)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors flex-shrink-0">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                    </button>
                  </div>
              </div>
              <div className="flex-1 p-5 overflow-y-auto space-y-6">
                  {(() => {
                      const runData = selectedPerfRecord.data[0].telemetry || [];
                      if (runData.length === 0) return <div className="text-gray-500 text-sm">Немає збережених даних телеметрії.</div>;
                      
                      const maxRpm = Math.max(...runData.map(d => d.rpm));
                      const maxLoad = Math.max(...runData.map(d => d.load));
                      const maxThrottle = Math.max(...runData.map(d => d.throttle));
                      const startTemp = runData[0].coolant;

                      let m50 = false, m100 = false, m150 = false, m200 = false;

                      return (
                        <>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                             <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                                <div className="text-[9px] text-gray-500 uppercase">Макс Оберти</div>
                                <div className="text-lg font-bold text-purple-400">{maxRpm} rpm</div>
                             </div>
                             <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                                <div className="text-[9px] text-gray-500 uppercase">Пік Навантаження</div>
                                <div className="text-lg font-bold text-orange-400">{maxLoad}%</div>
                             </div>
                             <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                                <div className="text-[9px] text-gray-500 uppercase">Макс Дросель</div>
                                <div className="text-lg font-bold text-blue-400">{maxThrottle}%</div>
                             </div>
                             <div className="bg-[#111318] p-3 rounded-xl border border-gray-800">
                                <div className="text-[9px] text-gray-500 uppercase">Темп на старті</div>
                                <div className="text-lg font-bold text-green-400">{startTemp}°C</div>
                             </div>
                          </div>

                          <div>
                             <h3 className="text-[10px] text-gray-500 font-bold uppercase mb-3 border-b border-gray-800 pb-2">Покрокова телеметрія</h3>
                             <div className="space-y-1">
                                <div className="flex text-[9px] text-gray-600 font-bold px-2 uppercase">
                                   <div className="w-12">Час</div>
                                   <div className="w-16">Швидк.</div>
                                   <div className="w-16">Оберти</div>
                                   <div className="w-16">Навант.</div>
                                   <div className="flex-1">Дросель</div>
                                </div>
                                {runData.map((pt, i) => {
                                   const show50 = !m50 && pt.speed >= 50 && (m50 = true);
                                   const show100 = !m100 && pt.speed >= 100 && (m100 = true);
                                   const show150 = !m150 && pt.speed >= 150 && (m150 = true);
                                   const show200 = !m200 && pt.speed >= 200 && (m200 = true);

                                   return (
                                     <React.Fragment key={i}>
                                       {show50 && <div className="text-center text-[10px] text-green-400 font-bold bg-green-900/20 py-1 my-1 rounded border border-green-800/30">--- 50 км/год ({formatPerfTime(pt.t)}) ---</div>}
                                       {show100 && <div className="text-center text-[10px] text-blue-400 font-bold bg-blue-900/20 py-1 my-1 rounded border border-blue-800/30">--- 100 км/год ({formatPerfTime(pt.t)}) ---</div>}
                                       {show150 && <div className="text-center text-[10px] text-purple-400 font-bold bg-purple-900/20 py-1 my-1 rounded border border-purple-800/30">--- 150 км/год ({formatPerfTime(pt.t)}) ---</div>}
                                       {show200 && <div className="text-center text-[10px] text-red-400 font-bold bg-red-900/20 py-1 my-1 rounded border border-red-800/30">--- 200 км/год ({formatPerfTime(pt.t)}) ---</div>}
                                       
                                       <div className="flex text-xs font-mono px-2 py-1.5 bg-[#111318] rounded-lg border border-gray-800/50 hover:border-gray-700">
                                          <div className="w-12 text-gray-500">{(pt.t/1000).toFixed(1)}s</div>
                                          <div className="w-16 text-white font-bold">{pt.speed}</div>
                                          <div className="w-16 text-purple-400">{pt.rpm}</div>
                                          <div className="w-16 text-orange-400">{pt.load}%</div>
                                          <div className="flex-1 text-blue-400">{pt.throttle}%</div>
                                       </div>
                                     </React.Fragment>
                                   );
                                })}
                             </div>
                          </div>
                        </>
                      )
                  })()}
              </div>
           </div>
        </div>
      )}

    </div>
  );
}