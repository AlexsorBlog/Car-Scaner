import React, { useState, useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core';
import { useTelemetry } from '../context/TelemetryContext.jsx';
import { obdScanner, TRANSPORT } from '../services/bleService.js'; 
import { obd } from '../obd/index.js';
import { commands } from '../obd/commands.js';
import { getRecentTelemetry, saveDiagnosticReport, getDiagnosticReports } from '../services/db.js';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api.js';
import { DragyStyleChart } from '../components/perf/DragyStyleChart.jsx';
import PerfRunDetailModal from '../components/perf/PerfRunDetailModal.jsx';
import { formatPerfTime, getMilestoneTime, getMilestoneDistance } from '../components/perf/perfHelpers.js';
import { lphToL100km } from '../obd/fuelRate.js';
import HideIcon from '../assets/hide.svg';
import ShowIcon from '../assets/show.svg';
import SpeedIcon from '../assets/speedometer.svg';
import RpmIcon from '../assets/tachometer.svg';
import CoolantIcon from '../assets/thermometer.svg';
import FuelIcon from '../assets/fuel.svg';
import EngineIcon from '../assets/engine.svg';
import IntakeIcon from '../assets/thermometer-sun.svg';
import ThrottleIcon from '../assets/bar-chart.svg';
import '../App.css';

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

// Add near the top of DashboardPage, after WIDGET_ICONS:
const GRAPH_KEY_MAP = {
  SPEED:        'speed',
  RPM:          'rpm',
  COOLANT_TEMP: 'temp',
  FUEL_RATE:    'fuel',
};

const get24hData = (dataArray) => {
  if (!dataArray || dataArray.length === 0) return [];
  const cutoff = Date.now() - (24 * 60 * 60 * 1000);
  return dataArray.filter(d => d.t >= cutoff);
};

const MiniGraph = ({ data, color, label, unit, onClick }) => {
  const gradId = `mg-${label.replace(/\s/g,'')}`

  if (!data || data.length === 0) return (
    <div className="flex flex-col w-full bg-[#0d0f14] p-3 rounded-2xl border border-gray-800/60">
      <span className="text-[9px] text-gray-600 font-bold uppercase tracking-wider mb-2">{label}</span>
      <div className="h-8 w-full rounded-lg flex items-center justify-center">
        <span className="text-[8px] text-gray-700">—</span>
      </div>
    </div>
  )

  const values  = data.map(d => d.v)
  const rawMax  = Math.max(...values)
  const rawMin  = Math.min(...values)
  const vr      = rawMax - rawMin === 0 ? 10 : rawMax - rawMin
  const max     = rawMax + vr * 0.12
  const min     = rawMin - vr * 0.12
  const range   = max - min
  const last    = values[values.length - 1]
  const prev    = values[values.length - 2] ?? last
  const trend   = last > prev ? '↑' : last < prev ? '↓' : '→'
  const trendCl = last > prev ? 'text-green-400' : last < prev ? 'text-red-400' : 'text-gray-500'

  const pts = data.map((d, i) =>
    `${(i/(data.length-1))*100},${100-((d.v-min)/range)*100}`
  ).join(' ')

  // Last point coords for the dot
  const lastX = 100
  const lastY = 100 - ((last - min) / range) * 100

  return (
    <div onClick={onClick}
      className="flex flex-col w-full p-3 rounded-2xl border border-gray-800/60 cursor-pointer transition-all active:scale-[0.98]"
      style={{ background: 'linear-gradient(180deg,#0d0f14 0%,#090b0f 100%)' }}>

      {/* Header */}
      <div className="flex justify-between items-start mb-1.5">
        <span className="text-[9px] text-gray-500 font-bold uppercase tracking-wider">{label}</span>
        <div className="flex items-baseline gap-0.5">
          <span className="text-sm font-black font-mono" style={{ color }}>{last}</span>
          <span className="text-[8px] text-gray-600 ml-0.5">{unit}</span>
          <span className={`text-[9px] font-bold ml-1 ${trendCl}`}>{trend}</span>
        </div>
      </div>

      {/* Chart */}
      <div className="relative w-full shrink-0" style={{ height: 36 }}>
        <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor={color} stopOpacity="0.3"/>
              <stop offset="100%" stopColor={color} stopOpacity="0.02"/>
            </linearGradient>
          </defs>
          {/* Fill */}
          <polygon fill={`url(#${gradId})`} points={`0,100 ${pts} 100,100`}/>
          {/* Line */}
          <polyline fill="none" stroke={color} strokeWidth="1.8"
            strokeLinecap="round" strokeLinejoin="round" points={pts}/>
          {/* Last value dot */}
          <circle cx={lastX} cy={lastY} r="2.5" fill={color}/>
          <circle cx={lastX} cy={lastY} r="1.2" fill="#090b0f"/>
        </svg>
      </div>

      {/* Min / max hint */}
      <div className="flex justify-between mt-1">
        <span className="text-[7px] text-gray-700 font-mono">{Math.round(rawMin)}</span>
        <span className="text-[7px] text-gray-700 font-mono">{Math.round(rawMax)}</span>
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const telemetry = useTelemetry();
  
  const isNative = Capacitor.getPlatform() !== 'web';
  const [useEmulator, setUseEmulator] = useState(!isNative);
  
  const [layouts, setLayouts] = useState(() => {
    const saved = localStorage.getItem('dashboardLayoutProfiles');
    if (saved) return JSON.parse(saved);
    const oldSaved = localStorage.getItem('dashboardLayout');
    const baseLayout = oldSaved ? JSON.parse(oldSaved) : INITIAL_LAYOUT;
    return [{ id: 'default', name: 'Основний', items: baseLayout }];
  });
  const [activeTabId, setActiveTabId] = useState(() => localStorage.getItem('dashboardActiveTabId') || 'default');
  
  const [layout, setLayout] = useState(() => {
    return layouts.find(l => l.id === (localStorage.getItem('dashboardActiveTabId') || 'default'))?.items || INITIAL_LAYOUT;
  });

  const [originalLayout, setOriginalLayout] = useState(layout);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedGraph, setSelectedGraph] = useState(null);
  
  const [dbGraphData, setDbGraphData] = useState([]);
  const [isGraphLoading, setIsGraphLoading] = useState(false);
  const [panOffsetMs, setPanOffsetMs] = useState(0); 
  const [graphZoomMs, setGraphZoomMs] = useState(10 * 60 * 1000); 
  const touchStartX = useRef(null);
  const hasAutoJumped = useRef(false);
  const [showMainGraph, setShowMainGraph] = useState(true);

  const [graphZoomActive, setGraphZoomActive] = useState(false);
  const pinchStartDist  = useRef(null);
  const pinchStartZoom  = useRef(null);
  const pinchStartPan   = useRef(null);
  const pinchCenterPct  = useRef(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisResults, setAnalysisResults] = useState([]);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  
  const [diagnosticHistory, setDiagnosticHistory] = useState([]);
  const [errorHistory, setErrorHistory] = useState([]);
  const [showErrorHistoryModal, setShowErrorHistoryModal] = useState(false);

  const [showArchive, setShowArchive] = useState(false);

  const [perfState, setPerfState] = useState('idle'); 
  const [perfTime, setPerfTime] = useState(0);
  const [perfRecords, setPerfRecords] = useState([]);
  const [perfFilter, setPerfFilter] = useState('0-100'); 
  const [selectedPerfRecord, setSelectedPerfRecord] = useState(null); 

  const [tripDistance, setTripDistance] = useState(() => Number(localStorage.getItem('obd_trip_distance')) || 0);
  const lastSpeedTime = useRef(Date.now());
  const currentSpeedRef = useRef(0);
  // Last л/100км reading that was actually computable (i.e. while moving) —
  // held so the fuel tile doesn't blank out every time the car stops.
  const lastFuelL100 = useRef(null);
  
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
    currentSpeedRef.current = telemetry.speed || 0;
  }, [telemetry.speed]);

  useEffect(() => {
    lastSpeedTime.current = Date.now();
    const interval = setInterval(() => {
      const now = Date.now();
      const timeDiffMs = now - lastSpeedTime.current;
      lastSpeedTime.current = now;

      if (telemetry.isConnected && currentSpeedRef.current > 0) {
        const hoursPassed = timeDiffMs / 3600000;
        const distanceDelta = currentSpeedRef.current * hoursPassed;

        setTripDistance(prev => {
          const newTotal = prev + distanceDelta;
          localStorage.setItem('obd_trip_distance', newTotal.toString());
          return newTotal;
        });
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [telemetry.isConnected]);

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

      const distanceM = getMilestoneDistance(currentRunData.current, perfFilter);
      api.savePerfRecord({
        filter_key: perfFilter,
        time_ms: getMilestoneTime(currentRunData.current, perfFilter) || finalTime,
        distance_m: distanceM,
        telemetry: currentRunData.current,
      }).catch((err) => {
        console.warn('Failed to sync perf record to server', err);
      });
    }
  };


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
      
      const dbField = GRAPH_KEY_MAP[selectedGraph.id] || selectedGraph.id.toLowerCase();

      const formatted = history
          .filter(d => d[dbField] !== undefined && d[dbField] !== null)
          .map(d => ({ t: d.timestamp, v: d[dbField] }));
      
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
    
    const historyKey = GRAPH_KEY_MAP[selectedGraph.id] || selectedGraph.id.toLowerCase();
    const liveData   = telemetry.history[historyKey] || [];
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
    if (!window.confirm("Аналіз може зайняти до 1–2 хвилин залежно від авто. Не вимикайте запалювання. Продовжити?")) return;
    
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
        cmd.name.includes('PIDS_') ||
        cmd.name.includes('MIDS_') ||
        cmd.name.startsWith('MONITOR_') ||
        cmd.name === 'GET_DTC' ||            // returns raw codes, not a metric
        cmd.name === 'GET_CURRENT_DTC' ||   // same
        cmd.name === 'CLEAR_DTC'            // destructive — never run in analysis
      ) {
        continue;
      }
      try {
        const res = await obd.query(cmd);
        if (res && res.value !== null && res.value !== 'NO DATA' && res.value !== 'ERROR') {
          const val = String(res.value).trim();
          // Skip raw hex strings that weren't decoded (e.g. "0027C000", "FEEE")
          // Keep if it contains non-hex characters or is short (number/percentage/temp)
          const isRawHex = /^[0-9A-Fa-f]{4,}$/.test(val) && val.length >= 6;
          if (!isRawHex && val !== '' && val !== 'Н/Д') {
            results.push({ name: cmd.name, desc: cmd.desc, value: val, unit: res.unit || '' });
          }
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

  const handleZoomChange = (newZoomMs) => {
      if (panOffsetMs > 0) {
          const currentCenterOffset = panOffsetMs + (graphZoomMs / 2);
          setPanOffsetMs(Math.max(0, currentCenterOffset - (newZoomMs / 2)));
      }
      setGraphZoomMs(newZoomMs);
  };

  const renderDetailedGraph = () => {
    if (!selectedGraph) return null;
    
    const liveData = telemetry.history[GRAPH_KEY_MAP[selectedGraph.id] || selectedGraph.id.toLowerCase()] || [];
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

    // ── Y-axis: smart "nice" tick calculation ────────────────────────────────
    let max = 100, min = 0, MathRange = 100;
    let yTicks = [0, 25, 50, 75, 100]; // defaults

    if (visibleData.length > 0) {
      const values   = visibleData.map(d => d.v);
      const rawMax   = Math.max(...values);
      const rawMin   = Math.min(...values);
      const rawRange = rawMax - rawMin === 0 ? 10 : rawMax - rawMin;

      // Round to a "nice" step so axis labels are clean numbers
      const roughStep = rawRange / 4;
      const mag   = Math.pow(10, Math.floor(Math.log10(roughStep)));
      const step  = Math.ceil(roughStep / mag) * mag;

      min       = Math.floor(rawMin / step) * step;
      max       = min + step * 5;
      MathRange = max - min;
      yTicks    = [0, 1, 2, 3, 4, 5].map(i => min + i * step);
    }

    // ── Data decimation: cap visible points to ~300 so zoomed-out view
    //    doesn't render thousands of overlapping polyline segments ─────────────
    const MAX_RENDER_PTS = 300;
    let renderData = visibleData;
    if (visibleData.length > MAX_RENDER_PTS) {
      const step = Math.ceil(visibleData.length / MAX_RENDER_PTS);
      renderData = visibleData.filter((_, i) => i % step === 0 || i === visibleData.length - 1);
    }

    const GAP_THRESHOLD = 15 * 60 * 1000;
    const segments = [];

    if (renderData.length > 0) {
      let currentSegment = [renderData[0]];
      for (let i = 1; i < renderData.length; i++) {
        if (renderData[i].t - renderData[i-1].t > GAP_THRESHOLD) {
          segments.push(currentSegment);
          currentSegment = [renderData[i]];
        } else {
          currentSegment.push(renderData[i]);
        }
      }
      segments.push(currentSegment);
    }
    
    const handleTouchStart = (e) => {
      if (e.touches.length === 2) {
        // Pinch start
        const t1 = e.touches[0], t2 = e.touches[1];
        pinchStartDist.current  = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        pinchStartZoom.current  = graphZoomMs;
        pinchStartPan.current   = panOffsetMs;
        const rect = e.currentTarget.getBoundingClientRect();
        pinchCenterPct.current  = ((t1.clientX + t2.clientX) / 2 - rect.left) / rect.width;
        touchStartX.current     = null; // disable pan while pinching
      } else if (e.touches.length === 1) {
        touchStartX.current = e.touches[0].clientX;
      }
    };

    const handleTouchMove = (e) => {
      if (e.touches.length === 2 && pinchStartDist.current) {
        // Pinch zoom
        const t1 = e.touches[0], t2 = e.touches[1];
        const currentDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const scale = pinchStartDist.current / currentDist; // inverse: pinch in = zoom in (smaller window)

        const MIN_ZOOM = 30 * 1000;          // 30 seconds minimum
        const MAX_ZOOM = 7 * 24 * 3600 * 1000; // 7 days maximum
        const newZoom  = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pinchStartZoom.current * scale));

        // Keep the pinch center point fixed while zooming
        const viewEndBefore  = Date.now() - pinchStartPan.current;
        const viewStartBefore = viewEndBefore - pinchStartZoom.current;
        const anchorTime     = viewStartBefore + pinchCenterPct.current * pinchStartZoom.current;
        const newPanOffset   = Math.max(0, Date.now() - anchorTime - newZoom * (1 - pinchCenterPct.current));

        setGraphZoomMs(newZoom);
        setPanOffsetMs(newPanOffset);

      } else if (e.touches.length === 1 && touchStartX.current !== null) {
        // Pan
        const currentX  = e.touches[0].clientX;
        const diffPixels = currentX - touchStartX.current;
        const msPerPixel = graphZoomMs / window.innerWidth;
        setPanOffsetMs(prev => Math.max(0, prev - diffPixels * msPerPixel));
        touchStartX.current = currentX;
      }
    };

    const handleTouchEnd = (e) => {
      if (e.touches.length < 2) pinchStartDist.current = null;
      if (e.touches.length === 0) touchStartX.current = null;
    };

    return (
      <div className="flex flex-col relative w-full h-full min-h-[350px]">
        <div className="flex gap-2 mb-2 justify-center flex-wrap items-center">
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
            <div className="flex items-center gap-1 border-l border-gray-800 pl-2">
              <button onClick={() => handleZoomChange(Math.max(30 * 1000, graphZoomMs / 2))}
                className="px-2 py-1 rounded bg-[#111318] border border-gray-800 text-gray-400 hover:text-white text-xs font-bold">+</button>
              <button onClick={() => handleZoomChange(Math.min(7 * 24 * 3600 * 1000, graphZoomMs * 2))}
                className="px-2 py-1 rounded bg-[#111318] border border-gray-800 text-gray-400 hover:text-white text-xs font-bold">−</button>
            </div>
        </div>
        
        <div className="flex justify-between items-end mb-4">
          <div>
            <div className="text-xl font-bold" style={{ color: selectedGraph.color }}>
              {visibleData.length > 0 ? visibleData[visibleData.length-1]?.v : '--'}
              <span className="text-sm font-normal text-gray-400 ml-1">{selectedGraph.unit}</span>
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

        {/* Chart area with Y-axis unit label */}
        <div className="flex gap-1 flex-1 relative mt-2">
          {/* Y-axis unit rotated label */}
          <div className="flex flex-col items-center justify-center flex-shrink-0" style={{ width: 18 }}>
            <span
              className="text-[9px] font-bold whitespace-nowrap"
              style={{ color: selectedGraph.color, transform: 'rotate(-90deg)', transformOrigin: 'center', display: 'block', letterSpacing: '0.05em' }}
            >
              {selectedGraph.unit || selectedGraph.label}
            </span>
          </div>

          {/* Chart */}
          <div className="flex-1 relative border-b border-l border-gray-800/80 cursor-ew-resize overflow-hidden" style={{ touchAction: 'none' }} onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
          {/* Y-axis labels — one per smart tick */}
          {yTicks.map((val, i) => {
            const pct = MathRange > 0 ? (val - min) / MathRange : 0;
            if (pct < 0 || pct > 1) return null;
            return (
              <div key={i} className="absolute left-[-38px] text-[9px] text-gray-500 font-mono"
                style={{ bottom: `${pct * 100}%`, transform: 'translateY(50%)' }}>
                {val % 1 === 0 ? val : val.toFixed(1)}
              </div>
            );
          })}

          <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full overflow-visible" preserveAspectRatio="none">
            <defs>
              <linearGradient id="graph-fill-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={selectedGraph.color} stopOpacity="0.2"/>
                <stop offset="100%" stopColor={selectedGraph.color} stopOpacity="0.01"/>
              </linearGradient>
            </defs>

            {/* Grid lines at smart tick positions */}
            {yTicks.map((val, i) => {
              const pct = MathRange > 0 ? (val - min) / MathRange : 0;
              if (pct < 0 || pct > 1) return null;
              const y = 100 - pct * 100;
              return (
                <line key={`grid-${i}`} x1="0" y1={y} x2="100" y2={y}
                  stroke={val === 0 ? '#374151' : '#1f2937'}
                  strokeWidth={val === 0 ? '0.7' : '0.4'}
                  strokeDasharray={val === 0 ? '' : '2,3'}/>
              );
            })}

            {/* Gradient fill under the first segment */}
            {segments[0] && segments[0].length > 1 && (() => {
              const fillPts = segments[0].map(d => {
                const x = ((d.t - viewStartTime) / WINDOW_MS) * 100;
                const y = 100 - (((d.v - min) / MathRange) * 100);
                return `${x},${y}`;
              }).join(' ');
              const firstX = ((segments[0][0].t - viewStartTime) / WINDOW_MS) * 100;
              const lastX  = ((segments[0][segments[0].length-1].t - viewStartTime) / WINDOW_MS) * 100;
              return <polygon fill="url(#graph-fill-grad)" points={`${firstX},100 ${fillPts} ${lastX},100`}/>;
            })()}

            {/* Data lines */}
            {segments.map((seg, idx) => {
              if (seg.length <= 1) return null;
              const pts = seg.map(d => {
                const x = ((d.t - viewStartTime) / WINDOW_MS) * 100;
                const y = 100 - (((d.v - min) / MathRange) * 100);
                return `${x},${y}`;
              }).join(' ');
              return (
                <polyline key={`line-${idx}`} fill="none" stroke={selectedGraph.color}
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" points={pts}/>
              );
            })}

            {/* Live dot — last visible point */}
            {renderData.length > 0 && (() => {
              const last = renderData[renderData.length - 1];
              const x = ((last.t - viewStartTime) / WINDOW_MS) * 100;
              const y = 100 - (((last.v - min) / MathRange) * 100);
              if (x < 0 || x > 100) return null;
              return (
                <>
                  <circle cx={x} cy={y} r="2.5" fill={selectedGraph.color} opacity="0.3"/>
                  <circle cx={x} cy={y} r="1.5" fill={selectedGraph.color}/>
                </>
              );
            })()}
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
          </div>{/* end chart */}
        </div>{/* end flex row: unit label + chart */}
        
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

    // The fuel tile always reports л/100км — that's the number drivers read.
    //
    // Prefer the rolling-window figure from TelemetryContext: it integrates
    // fuel and distance over the last 2 minutes, so it stays populated and
    // steady at a red light instead of going infinite (л/100км is undefined the
    // instant speed hits 0). It's driven by whatever л/год getSmartFuelRate()
    // produced, including its calculated fallbacks, so it works on cars whose
    // fuel PIDs answer "NO DATA".
    //
    // Falls back to an instantaneous conversion if the window hasn't filled
    // yet, then to the last value we held. Only a car that has genuinely never
    // moved shows "--" — with no distance at all there is no per-distance
    // figure to report.
    let displayValue = metricData.value;
    let displayUnit  = metricData.unit;
    if (item.id === 'FUEL_RATE') {
      const rolling = telemetry.fuelL100 != null ? telemetry.fuelL100.toFixed(1) : null;
      const instant = metricData.value !== '--'
        ? lphToL100km(metricData.value, telemetry.speed)
        : null;
      const l100 = rolling ?? instant;
      if (l100 != null) lastFuelL100.current = l100;
      displayValue = l100 ?? lastFuelL100.current ?? '--';
      displayUnit  = 'л/100км';
    }

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
          <div className="flex flex-col items-center w-full">
            <div className="relative w-64 h-64 rounded-full border-[8px] border-gray-900 flex flex-col justify-center items-center bg-gradient-to-b from-[#0b0c10] to-[#111318] transition-shadow duration-300" style={{ boxShadow: dynamicGlow }}>
              
              {/* Unified Scale & Progress Arc */}
              <svg className="absolute inset-0 w-full h-full overflow-visible" viewBox="0 0 200 200">
                <defs>
                  <linearGradient id="speed-gradient" x1="0%" y1="100%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#0ea5e9" />
                    <stop offset="100%" stopColor="#ef4444" />
                  </linearGradient>
                  <filter id="arc-glow">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                </defs>

                {/* Track Background (Фонова доріжка) */}
                <circle 
                  cx="100" cy="100" r="88" fill="none" stroke="#1f2937" strokeWidth="4" 
                  strokeLinecap="round" strokeDasharray="553" strokeDashoffset="138" transform="rotate(135 100 100)" 
                />

                {/* Animated Speed Arc (Активна лінія швидкості) */}
                <circle 
                  cx="100" cy="100" r="88" fill="none" stroke="url(#speed-gradient)" strokeWidth="6" 
                  strokeLinecap="round" strokeDasharray="553" 
                  strokeDashoffset={553 - ((normalizedSpeed) / 220 * 414.75)} 
                  className="transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)]" 
                  transform="rotate(135 100 100)" style={{ filter: 'url(#arc-glow)' }}
                />

                {/* Ticks & Numbers (Мітки та цифри) */}
                {[0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220].map((tick, i) => {
                  const angle = -135 + ((tick / 220) * 270);
                  const rad = (angle - 90) * (Math.PI / 180);
                  const innerRad = 80;
                  const outerRad = 88;
                  
                  const x1 = 100 + innerRad * Math.cos(rad);
                  const y1 = 100 + innerRad * Math.sin(rad);
                  const x2 = 100 + outerRad * Math.cos(rad);
                  const y2 = 100 + outerRad * Math.sin(rad);
                  
                  const tx = 100 + 64 * Math.cos(rad);
                  const ty = 100 + 64 * Math.sin(rad);

                  return (
                    <g key={i}>
                      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#4b5563" strokeWidth="2" strokeLinecap="round" />
                      <text x={tx} y={ty} fill="#9ca3af" fontSize="10" textAnchor="middle" dominantBaseline="middle" className="font-bold">
                        {tick}
                      </text>
                    </g>
                  );
                })}
              </svg>

              {/* Needle (Стрілка, налаштована під новий радіус) */}
              <div className="absolute inset-0 flex justify-center items-center pointer-events-none" style={{ transform: `rotate(${needleAngle}deg)`, transition: 'transform 0.7s cubic-bezier(0.34, 1.56, 0.64, 1)' }}>
                 <div className="w-1.5 h-[80px] bg-red-500 rounded-full absolute bottom-1/2 shadow-[0_0_15px_rgba(239,68,68,0.8)] origin-bottom mb-2"></div>
                 <div className="w-6 h-6 bg-[#0b0c10] border-[4px] border-red-500 rounded-full absolute"></div>
              </div>
              
              {/* Values */}
              <div className="flex flex-col items-center mt-6 z-10">
                {isWaitingData ? (
                  <div className="text-gray-600 animate-pulse text-2xl font-bold">--</div>
                ) : (
                  <span className="text-7xl font-black tracking-tighter tabular-nums text-white drop-shadow-md">{metricData.value}</span>
                )}
                <span className="text-sm text-gray-500 font-bold tracking-widest uppercase">КМ/ГОД</span>
              </div>
            </div>

            {/* Toggle Graph Button */}
            {!isWaitingData && (
              <div className="w-full mt-6 mb-2 flex justify-between items-center border-b border-gray-800 pb-2 px-2">
                <span className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Графік швидкості</span>
                <button 
                  onClick={(e) => { e.stopPropagation(); setShowMainGraph(!showMainGraph); }}
                  className="bg-gray-900 border border-gray-700 px-3 py-1 text-[10px] rounded-full text-blue-400 font-bold"
                >
                  {showMainGraph ? 'СХОВАТИ' : 'ПОКАЗАТИ'}
                </button>
              </div>
            )}

            {/* Main Graph (Dynamic) */}
            {showMainGraph && !isWaitingData && (
              <div className="w-full px-2" onClick={(e) => e.stopPropagation()}>
                <MiniGraph 
                  data={get24hData(telemetry.history.speed)} 
                  color="#60a5fa" 
                  label="Швидкість" 
                  unit="км/год" 
                  onClick={() => setSelectedGraph({ id: 'SPEED', label: 'Швидкість', color: '#60a5fa', unit: 'км/год' })} 
                />
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
               <span className={`font-bold transition-all duration-300 tabular-nums ${item.size === 'col-span-1' ? 'text-2xl' : 'text-4xl'} ${displayValue === '--' ? 'text-gray-600' : 'text-white'}`}>
                 {displayValue}
                 <span className="text-[10px] text-gray-500 ml-1 font-medium">{displayUnit}</span>
               </span>
            )}
            <span className="text-[10px] text-gray-500/80 font-bold mt-1 text-center leading-tight uppercase tracking-wider">{cmdInfo?.desc || item.id}</span>
          </>
        )}
      </div>
    );
  };

  if (telemetry.isLoading) return <div className="bg-[#050505] flex justify-center items-center"><div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div></div>;

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
    <div className="p-5 flex flex-col gap-5 animate-in fade-in duration-500 bg-[#050505] text-white overflow-x-hidden pb-28">
      
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
          <MiniGraph data={get24hData(telemetry.history.fuel)} color="#f472b6" label="ВИТРАТА, Л/ГОД" unit="л/год" onClick={() => setSelectedGraph({ id: 'FUEL_RATE', label: 'Витрата палива (л/год)', color: '#f472b6', unit: 'л/год' })} />
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
          (() => {
            const activeErrors  = telemetry.errors.filter(e => (e.statusCategory || 'active') === 'active');
            const pendingErrors = telemetry.errors.filter(e => e.statusCategory === 'pending');
            const archiveErrors = telemetry.errors.filter(e => e.statusCategory === 'historic');

            const STATUS_STYLE = {
              active:  { bg: 'bg-red-950/20',   border: 'border-red-900/30',   dot: 'bg-red-500',   label: 'АКТИВНА',      labelCls: 'text-red-400 bg-red-500/10'   },
              pending: { bg: 'bg-amber-950/20', border: 'border-amber-900/30', dot: 'bg-amber-400', label: 'В ОЧІКУВАННІ', labelCls: 'text-amber-400 bg-amber-500/10' },
              historic:{ bg: 'bg-gray-900/30',  border: 'border-gray-800',     dot: 'bg-gray-500',  label: 'АРХІВНА',      labelCls: 'text-gray-500 bg-gray-800'     },
            };

            const countLabel = [
              activeErrors.length  > 0 && `${activeErrors.length} активних`,
              pendingErrors.length > 0 && `${pendingErrors.length} в очікуванні`,
              archiveErrors.length > 0 && `${archiveErrors.length} архівних`,
            ].filter(Boolean).join(' · ');

            return (
              <div className="space-y-2 relative z-10">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-[10px] text-red-400 font-bold uppercase tracking-widest">{countLabel}</span>
                  <span className="text-[9px] text-gray-500">{telemetry.lastScanTime}</span>
                </div>

                {/* Active + pending — always visible */}
                {[...activeErrors, ...pendingErrors].map((err, i) => {
                  const st = STATUS_STYLE[err.statusCategory || 'active'];
                  return (
                    <div key={i} onClick={() => navigate('/diagnostics', { state: { selectedError: err } })}
                      className={`flex items-center justify-between ${st.bg} p-3 rounded-xl border ${st.border} cursor-pointer hover:brightness-125 transition-all shadow-sm`}>
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${st.dot}`} />
                        <div>
                          <div className="text-xs font-bold text-gray-200">{err.code}</div>
                          <div className="text-[10px] text-gray-500 truncate w-36">{err.title}</div>
                          <div className="text-[9px] text-gray-600 mt-0.5">{err.desc}</div>
                        </div>
                      </div>
                      <span className={`text-[8px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${st.labelCls}`}>{st.label}</span>
                    </div>
                  );
                })}

                {/* Archive dropdown — collapsed by default */}
                {archiveErrors.length > 0 && (
                  <div className="mt-1">
                    <button
                      onClick={() => setShowArchive(p => !p)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-gray-900/50 border border-gray-800 text-[10px] text-gray-400 hover:text-gray-300 hover:bg-gray-900 transition-all font-bold"
                    >
                      <span className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                        АРХІВНІ КОДИ ({archiveErrors.length})
                      </span>
                      <span className={`transition-transform duration-200 ${showArchive ? 'rotate-180' : ''}`}>▾</span>
                    </button>
                    {showArchive && (
                      <div className="mt-1 space-y-1 animate-in slide-in-from-top-2 duration-200">
                        {archiveErrors.map((err, i) => (
                          <div key={i} onClick={() => navigate('/diagnostics', { state: { selectedError: err } })}
                            className="flex items-center justify-between bg-gray-900/30 p-3 rounded-xl border border-gray-800 cursor-pointer hover:brightness-125 transition-all shadow-sm">
                            <div className="flex items-center gap-3">
                              <div className="w-2 h-2 rounded-full flex-shrink-0 bg-gray-500" />
                              <div>
                                <div className="text-xs font-bold text-gray-400">{err.code}</div>
                                <div className="text-[10px] text-gray-600 truncate w-36">{err.title}</div>
                                <div className="text-[9px] text-gray-700 mt-0.5">{err.desc}</div>
                              </div>
                            </div>
                            <span className="text-[8px] font-bold px-2 py-0.5 rounded-full flex-shrink-0 text-gray-500 bg-gray-800">АРХІВ</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.scanErrors} className="flex-1 bg-gray-800/50 border border-gray-700 py-2.5 rounded-xl text-[10px] text-gray-400 hover:text-white disabled:opacity-30 transition-colors font-bold shadow-sm">ОНОВИТИ</button>
                  <button disabled={!telemetry.isConnected || telemetry.isCheckingErrors} onClick={telemetry.clearErrors} className="flex-1 bg-red-950/50 border border-red-900/50 text-red-400 py-2.5 rounded-xl text-[10px] hover:bg-red-900 disabled:opacity-30 transition-colors font-bold shadow-sm">СТЕРТИ (04)</button>
                </div>
              </div>
            );
          })()
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

      <div className="bg-[#111318] p-4 rounded-2xl border border-gray-800 shadow-lg">
        <div className="flex justify-between items-center mb-4">
           <div className="flex items-center gap-2">
               <h3 className="text-xs font-bold tracking-wide text-gray-300 uppercase">Динаміка</h3>
              <select 
                  className="bg-gray-900 border border-gray-700 text-[10px] text-white rounded px-2 py-1 outline-none focus:border-blue-500"
                  value={perfFilter}
                  onChange={(e) => setPerfFilter(e.target.value)}
                >
                  <option value="0-50">0-50 км/год</option>
                  <option value="50-100">50-100 км/год</option>
                  <option value="0-100">0-100 км/год</option>
                  <option value="100-200">100-200 км/год</option>
                  <option value="0-200">0-200 км/год</option>
                  <option value="60-130">60-130 км/год</option>
                  <option value="1/4mi">1/4 милі (402 м)</option>
                  <option value="1/2mi">1/2 милі (804 м)</option>
                </select>
           </div>
           <span className="text-[9px] bg-red-900/30 text-red-400 px-2 py-1 rounded font-bold uppercase tracking-widest">PERFORMANCE</span>
        </div>
        
        <div className="flex flex-col items-center justify-center p-4 bg-gray-950/50 rounded-xl border border-gray-800/50 mb-4">
           <div className="flex items-baseline gap-2 mb-2">
             <span className="text-4xl font-black tabular-nums font-mono text-white">
               {formatPerfTime(perfTime)}
             </span>
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
            <div className="text-[10px] text-gray-500 font-bold mb-2 uppercase">Рекорди ({perfFilter}):</div>
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
             Немає замірів для швидкості {perfFilter}
          </div>
        )}
      </div>

      {showAnalysisModal && (
        <div className="fixed inset-0 z-[110] bg-black/80 backdrop-blur-sm flex items-end md:items-center justify-center animate-in fade-in duration-200 pt-safe">
          <div className="bg-[#0b0c10] w-full md:w-3/4 max-w-2xl rounded-t-3xl md:rounded-3xl border border-gray-800 shadow-2xl h-[85dvh] md:h-[70dvh] flex flex-col animate-in slide-in-from-bottom-10">
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
            
            <div className="p-5 flex-1 overflow-y-auto overscroll-contain">
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
                        {/* desc first — human-readable Ukrainian description */}
                        <div className="text-xs font-bold text-gray-200 leading-tight">{res.desc || res.name}</div>
                        {/* name second — OBD code, smaller, for reference/googling */}
                        <div className="text-[9px] text-gray-600 font-mono mt-0.5">{res.name}</div>
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

      {showErrorHistoryModal && (
         <div className="fixed inset-0 z-[115] bg-black/80 backdrop-blur-md flex items-end md:items-center justify-center animate-in fade-in p-4 pt-safe">
           <div className="bg-[#0b0c10] w-full max-w-2xl rounded-3xl border border-gray-800 shadow-2xl h-[70dvh] flex flex-col animate-in zoom-in-95 overflow-hidden">
             <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
               <h2 className="text-sm font-bold text-white uppercase tracking-widest">Історія помилок (БД)</h2>
               <button onClick={() => setShowErrorHistoryModal(false)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors">
                 <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
               </button>
             </div>
             <div className="flex-1 p-5 overflow-y-auto overscroll-contain space-y-4">
               {errorHistory.length === 0 ? (
                 <div className="text-center py-10 text-gray-500 text-xs">Історія пуста.</div>
               ) : (
                 errorHistory.map((report) => (
                   <div key={report.id} className="bg-[#111318] p-4 rounded-xl border border-gray-800">
                     <div className="text-[10px] text-gray-500 font-bold mb-3 border-b border-gray-800 pb-2">
                       {new Date(report.timestamp).toLocaleString('uk-UA')}
                     </div>
                     <div className="space-y-2">
                       {report.data.length === 0 ? (
                         <div className="flex items-center gap-3 bg-green-950/10 p-3 rounded-xl border border-green-900/20">
                           <div className="w-6 h-6 rounded-full bg-green-500/10 flex items-center justify-center text-green-500 font-bold text-[10px]">✓</div>
                           <div className="text-xs font-bold text-green-400">Помилок не виявлено (Система в нормі)</div>
                         </div>
                       ) : (
                         report.data.map((err, i) => (
                           <div key={i} onClick={() => navigate('/diagnostics', { state: { selectedError: err } })}
                              className={`flex items-center gap-3 p-2 rounded-lg border cursor-pointer transition-colors
                                ${{ active: 'bg-red-950/10 border-red-900/20 hover:bg-red-900/30',
                                    pending: 'bg-amber-950/10 border-amber-900/20 hover:bg-amber-900/30',
                                    historic: 'bg-gray-900/20 border-gray-800 hover:bg-gray-800/50'
                                  }[err.statusCategory || 'active']}`}>
                              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0
                                ${{ active: 'bg-red-500', pending: 'bg-amber-400', historic: 'bg-gray-500' }[err.statusCategory || 'active']}`} />
                              <div className="text-xs font-bold text-gray-300">{err.code}</div>
                              <div className="text-[10px] text-gray-500 truncate flex-1">{err.title}</div>
                              <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0
                                ${{ active: 'text-red-400 bg-red-500/10',
                                    pending: 'text-amber-400 bg-amber-500/10',
                                    historic: 'text-gray-500 bg-gray-800'
                                  }[err.statusCategory || 'active']}`}>
                                {{ active: 'АКТИВНА', pending: 'ОЧІК.', historic: 'АРХІВ' }[err.statusCategory || 'active']}
                              </span>
                            </div>
                         ))
                       )}
                     </div>
                   </div>
                 ))
               )}
             </div>
           </div>
         </div>
      )}

      {selectedGraph && (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center animate-in fade-in duration-200 p-4 pt-safe">
          <div className="bg-[#0b0c10] w-full max-w-3xl rounded-3xl border border-gray-800 shadow-2xl h-[75dvh] flex flex-col animate-in zoom-in-95 overflow-hidden">
            <div className="p-5 border-b border-gray-800 flex justify-between items-center bg-[#111318]">
              <h2 className="text-xl font-black text-white flex items-center gap-3">
                <div className="w-3 h-3 rounded-full shadow-lg" style={{ backgroundColor: selectedGraph.color, boxShadow: `0 0 10px ${selectedGraph.color}` }}></div>
                {selectedGraph.label}
              </h2>
              <button onClick={() => setSelectedGraph(null)} className="text-gray-400 bg-gray-900 p-2 rounded-full hover:bg-gray-800 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
              </button>
            </div>
            <div className="flex-1 p-5 bg-[#0b0c10] flex flex-col overflow-y-auto overscroll-contain">
              {renderDetailedGraph()}
            </div>
          </div>
        </div>
      )}

      {selectedPerfRecord && (
        <PerfRunDetailModal
          timestamp={selectedPerfRecord.timestamp}
          timeMs={selectedPerfRecord.data[0].timeMs}
          telemetry={selectedPerfRecord.data[0].telemetry}
          filterKey={perfFilter}
          onClose={() => setSelectedPerfRecord(null)}
        />
      )}

    </div>
  );
}
