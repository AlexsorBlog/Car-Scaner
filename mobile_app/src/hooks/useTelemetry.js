import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { obd } from '../obd/index.js';
import { commands, mode3, mode4 } from '../obd/commands.js';
import { saveTelemetryData, getRecentTelemetry, summarizeOldData } from '../services/db.js';
import dtcDictionary from '../obd/codes.json';

export function useTelemetry() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  
  const [data, setData] = useState({
    isConnected: false,
    speed: 0, rpm: 0, temp: 0, fuel: 0, 
    metrics: {}, // Сюди пишуться ВСІ дані для віджетів
    errors: [], hasScannedErrors: false, isCheckingErrors: false, lastScanTime: null,
    history: { speed: [], rpm: [], temp: [], fuel: [] },
    user: { name: '', email: '', vehicle: '', vin: '', odometer: '', make: '', model: '' }
  });

  const isPolling = useRef(false);
  const isPaused = useRef(false);
  const activeSensorsRef = useRef([]);
  const lastDbSaveTime = useRef(0);

  const fetchUserProfile = useCallback(async () => {
    const token = localStorage.getItem('obd_token');
    if (!token) { navigate('/login'); return; }
    
    try {
      const response = await fetch('http://localhost:3000/api/user/profile', { headers: { 'Authorization': `Bearer ${token}` } });
      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('obd_token'); navigate('/login'); return;
      }
      const result = await response.json();
      
      // БЕРЕМО ДАНІ З БД
      const recentData = await getRecentTelemetry(1500); 
      const histSpeed = [], histRpm = [], histTemp = [], histFuel = [];
      let initialMetrics = {};
      let latestSpeed = 0, latestRpm = 0, latestTemp = 0, latestFuel = 0;

      recentData.forEach(d => {
        if(d.speed !== undefined) { histSpeed.push({ t: d.timestamp, v: d.speed }); latestSpeed = d.speed; initialMetrics['SPEED'] = { value: d.speed, unit: 'км/год' }; }
        if(d.rpm !== undefined) { histRpm.push({ t: d.timestamp, v: d.rpm }); latestRpm = d.rpm; initialMetrics['RPM'] = { value: d.rpm, unit: 'об/хв' }; }
        if(d.temp !== undefined) { histTemp.push({ t: d.timestamp, v: d.temp }); latestTemp = d.temp; initialMetrics['COOLANT_TEMP'] = { value: d.temp, unit: '°C' }; }
        if(d.fuel !== undefined) { histFuel.push({ t: d.timestamp, v: d.fuel }); latestFuel = d.fuel; initialMetrics['FUEL_LEVEL'] = { value: d.fuel, unit: '%' }; }
      });

      setData(prev => ({
        ...prev,
        speed: latestSpeed, rpm: latestRpm, temp: latestTemp, fuel: latestFuel,
        metrics: initialMetrics, // ВІДЖЕТИ БІЛЬШЕ НЕ ПОРОЖНІ!
        user: { ...result.user, make: result.user.vehicle?.split(' ')[0] || '', model: result.user.vehicle?.split(' ').slice(1).join(' ') || '' },
        history: { speed: histSpeed, rpm: histRpm, temp: histTemp, fuel: histFuel }
      }));
      summarizeOldData();
    } catch (error) { console.error(error); } finally { setIsLoading(false); }
  }, [navigate]);

  useEffect(() => {
    fetchUserProfile();
    return () => { isPolling.current = false; obd.disconnect(); };
  }, [fetchUserProfile]);

  const startLivePolling = async () => {
    if (isPolling.current) return; 
    isPolling.current = true;
    const failCounts = {};

    while (isPolling.current) {
      if (isPaused.current) { await new Promise(r => setTimeout(r, 500)); continue; }

      const currentSensors = activeSensorsRef.current;
      let cycleMetrics = {};
      let cycleTopLevel = {};

      for (let cmdId of currentSensors) {
        if (!isPolling.current || isPaused.current) break;
        if (failCounts[cmdId] >= 3) continue; 
        
        const cmdObj = commands[cmdId];
        if (!cmdObj) continue;

        const res = await obd.query(cmdObj);
        if (res && res.value !== null) {
          failCounts[cmdId] = 0;
          cycleMetrics[cmdId] = res;
          
          if (cmdId === 'SPEED') cycleTopLevel.speed = res.value;
          if (cmdId === 'RPM') cycleTopLevel.rpm = res.value;
          if (cmdId === 'COOLANT_TEMP') cycleTopLevel.temp = res.value;
          if (cmdId === 'FUEL_LEVEL') cycleTopLevel.fuel = res.value;
        } else { failCounts[cmdId] = (failCounts[cmdId] || 0) + 1; }
        await new Promise(r => setTimeout(r, 40));
      }

      const now = Date.now();
      if (now - lastDbSaveTime.current > 5000 && Object.keys(cycleTopLevel).length > 0) {
        saveTelemetryData(cycleTopLevel);
        lastDbSaveTime.current = now;
      }

      if (Object.keys(cycleMetrics).length > 0 && isPolling.current && !isPaused.current) {
        setData(prev => {
          const h = { ...prev.history };
          if (cycleTopLevel.speed !== undefined) h.speed = [...h.speed, { t: now, v: cycleTopLevel.speed }].slice(-1500);
          if (cycleTopLevel.rpm !== undefined) h.rpm = [...h.rpm, { t: now, v: cycleTopLevel.rpm }].slice(-1500);
          if (cycleTopLevel.temp !== undefined) h.temp = [...h.temp, { t: now, v: cycleTopLevel.temp }].slice(-1500);
          if (cycleTopLevel.fuel !== undefined) h.fuel = [...h.fuel, { t: now, v: cycleTopLevel.fuel }].slice(-1500);
          
          return { ...prev, ...cycleTopLevel, metrics: { ...prev.metrics, ...cycleMetrics }, history: h };
        });
      }
      await new Promise(r => setTimeout(r, 150));
    }
  };

  const connectOBD = async () => {
    setIsConnecting(true);
    const success = await obd.connect();
    if (success) {
      await obd.initEngine();
      setData(prev => ({ ...prev, isConnected: true }));
      startLivePolling();
    }
    setIsConnecting(false);
    return success;
  };

  const disconnectOBD = () => {
    isPolling.current = false;
    obd.disconnect();
    setData(prev => ({ ...prev, isConnected: false }));
  };

  const scanErrors = async () => {
    setData(prev => ({ ...prev, isCheckingErrors: true }));
    isPaused.current = true;
    await new Promise(r => setTimeout(r, 1000)); 

    try {
      const result = await obd.query(mode3.GET_DTC);
      const now = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute:'2-digit' });
      
      if (result && Array.isArray(result.value) && result.value.length > 0) {
        const foundErrors = result.value.map(code => ({
          code: code,
          title: dtcDictionary[code] || "Специфічна помилка виробника",
          desc: "Потрібна додаткова діагностика системи."
        }));
        setData(prev => ({ ...prev, errors: foundErrors, hasScannedErrors: true, lastScanTime: now }));
      } else {
        setData(prev => ({ ...prev, errors: [], hasScannedErrors: true, lastScanTime: now }));
      }
    } catch (e) {
      console.error(e);
      setData(prev => ({ ...prev, errors: [], hasScannedErrors: true }));
    }
    setData(prev => ({ ...prev, isCheckingErrors: false }));
    isPaused.current = false;
  };

  const clearErrors = async () => {
    if (!window.confirm("Ви впевнені, що хочете стерти помилки? Це вимкне Check Engine.")) return;
    setData(prev => ({ ...prev, isCheckingErrors: true }));
    isPaused.current = true;
    await new Promise(r => setTimeout(r, 1000));

    try {
      await obd.query(mode4.CLEAR_DTC);
      setData(prev => ({ ...prev, errors: [] }));
      alert("Помилки успішно стерто!");
    } catch (e) { console.error(e); alert("Не вдалося стерти помилки"); }

    setTimeout(() => {
      setData(prev => ({ ...prev, isCheckingErrors: false }));
      isPaused.current = false;
    }, 2000);
  };

  return { 
    ...data, isLoading, isConnecting, refreshProfile: fetchUserProfile, 
    connectOBD, disconnectOBD, setPaused: (s) => isPaused.current = s, 
    updateActiveSensors: (s) => activeSensorsRef.current = s, scanErrors, clearErrors 
  };
}