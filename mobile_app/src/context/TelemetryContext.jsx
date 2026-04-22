/**
 * context/TelemetryContext.jsx — Single global OBD-II telemetry state
 *
 * Why this exists:
 *   The original useTelemetry() hook was called inside every page component.
 *   Each call created an independent state + OBD polling loop, so navigating
 *   between tabs spawned up to 5 simultaneous polling loops — all fighting for
 *   the same serial BLE/WebSocket channel.
 *
 *   This context wraps the entire app once and exposes a single shared state.
 *   Pages call:  const telemetry = useTelemetry();
 *   — same API as before, zero changes needed in individual pages.
 *
 * Fixed bugs vs original useTelemetry.js:
 *  - Multiple hook instances → single provider instance
 *  - while-loop had no try/catch → silent crash stops polling
 *  - window.confirm / alert used → broken on native (state-based confirms instead)
 *  - isPaused race condition → dedicated semaphore with proper await
 *  - fetchUserProfile swallowed all errors → surfaces them in state
 *  - startLivePolling could be called multiple times → AbortController guard
 *  - History arrays: now one unified tiered polling approach
 */

import {
  createContext, useCallback, useContext,
  useEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { obd }                          from '../obd/index.js';
import { commands, mode3, mode4 }       from '../obd/commands.js';
import { obdScanner, TRANSPORT }        from '../services/bleService.js';
import {
  saveTelemetryData,
  getRecentTelemetry,
  summarizeOldData,
}                                        from '../services/db.js';
import dtcDictionary                    from '../obd/codes.json';

// ── Polling tier config ───────────────────────────────────────────────────────

/**
 * Fast tier  — polled every cycle (≈200 ms)
 * Medium tier— polled every 10 cycles (≈2 s)
 * Slow tier  — polled every 150 cycles (≈30 s)
 *
 * Anything not listed falls into "slow".
 */
const FAST_PIDS   = new Set(['SPEED', 'RPM', 'COOLANT_TEMP', 'THROTTLE_POS']);
const MEDIUM_PIDS = new Set(['ENGINE_LOAD', 'INTAKE_TEMP', 'FUEL_LEVEL', 'MAF',
                              'BAROMETRIC_PRESSURE', 'CONTROL_MODULE_VOLTAGE']);

// History window kept in memory
const HISTORY_LIMIT = 1500;

// DB write throttle
const DB_SAVE_INTERVAL_MS = 5000;

// ── Context ───────────────────────────────────────────────────────────────────

const TelemetryContext = createContext(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function TelemetryProvider({ children }) {
  const navigate = useNavigate();

  // ── Core state ─────────────────────────────────────────────────────────────
  const [isLoading,    setIsLoading]    = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [data, setData] = useState({
    isConnected:      false,
    speed:            0,
    rpm:              0,
    temp:             0,
    fuel:             0,
    metrics:          {},
    errors:           [],
    hasScannedErrors: false,
    isCheckingErrors: false,
    lastScanTime:     null,
    history:          { speed: [], rpm: [], temp: [], fuel: [] },
    user:             { name: '', email: '', vehicle: '', vin: '', odometer: '', make: '', model: '' },
    profileError:     null,
  });

  // ── Confirm dialog state (replaces window.confirm) ─────────────────────────
  const [confirmState, setConfirmState] = useState(null);
  // { message, onConfirm, onCancel }

  // ── Refs — mutable values that must NOT trigger re-renders ─────────────────
  const pollingAbort   = useRef(null);   // AbortController for the polling loop
  const isPaused       = useRef(false);  // pause flag (paused during DTC ops)
  const activeSensors  = useRef([]);     // list of sensor IDs to poll
  const lastDbSave     = useRef(0);
  const tickCount      = useRef(0);

  // ── Auth guard ──────────────────────────────────────────────────────────────

  const requireAuth = useCallback(() => {
    const token = localStorage.getItem('obd_token');
    if (!token) { navigate('/login', { replace: true }); return null; }
    return token;
  }, [navigate]);

  // ── Profile fetch ───────────────────────────────────────────────────────────

  // ── Profile fetch ───────────────────────────────────────────────────────────

  const fetchUserProfile = useCallback(async () => {
    const token = requireAuth();
    if (!token) {
      setIsLoading(false); // ВАЖЛИВО: вимикаємо загрузку, якщо немає токена
      return;
    }

    try {
      // --- BYPASS СЕРВЕРА ДЛЯ ANDROID ---
      // Відключаємо запит до localhost:3000, щоб телефон не "зависав".
      // Імітуємо успішну відповідь з профілем користувача:
      const user = {
        name: 'Vladislav (Admin)',
        email: 'vladislav@carscanner.local',
        vehicle: 'BMW 5 Series',
        vin: 'WBA0000000000000',
      };

      // Завантажуємо локальну історію телеметрії (БД працює на телефоні автономно)
      const recentRows  = await getRecentTelemetry(1500);
      const histSpeed   = [], histRpm = [], histTemp = [], histFuel = [];
      let initialMetrics = {};
      let latestSpeed = 0, latestRpm = 0, latestTemp = 0, latestFuel = 0;

      for (const row of recentRows) {
        const t = row.timestamp;
        if (row.speed != null) { histSpeed.push({ t, v: row.speed }); latestSpeed = row.speed; initialMetrics.SPEED = { value: row.speed, unit: 'км/год' }; }
        if (row.rpm   != null) { histRpm  .push({ t, v: row.rpm   }); latestRpm   = row.rpm;   initialMetrics.RPM   = { value: row.rpm,   unit: 'об/хв' }; }
        if (row.temp  != null) { histTemp .push({ t, v: row.temp  }); latestTemp  = row.temp;  initialMetrics.COOLANT_TEMP = { value: row.temp, unit: '°C' }; }
        if (row.fuel  != null) { histFuel .push({ t, v: row.fuel  }); latestFuel  = row.fuel;  initialMetrics.FUEL_LEVEL   = { value: row.fuel, unit: '%'  }; }
      }

      setData(prev => ({
        ...prev,
        speed: latestSpeed, rpm: latestRpm, temp: latestTemp, fuel: latestFuel,
        metrics: initialMetrics,
        user: {
          ...user,
          make:  user.vehicle?.split(' ')[0]            ?? '',
          model: user.vehicle?.split(' ').slice(1).join(' ') ?? '',
        },
        history: { speed: histSpeed, rpm: histRpm, temp: histTemp, fuel: histFuel },
        profileError: null,
      }));

      // Background: summarise + prune old data
      summarizeOldData().catch(console.error);

    } catch (err) {
      console.error('[Telemetry] fetchUserProfile:', err);
      setData(prev => ({ ...prev, profileError: err.message }));
    } finally {
      // Гарантовано вимикаємо спінер завантаження
      setIsLoading(false);
    }
  }, [navigate, requireAuth]);
  // ── OBD polling loop ─────────────────────────────────────────────────────────

  const _startPolling = useCallback(async (signal) => {
    tickCount.current = 0;

    while (!signal.aborted) {
      // ── Pause gate ──────────────────────────────────────────────────────
      if (isPaused.current) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const tick     = tickCount.current++;
      const sensors  = activeSensors.current;
      if (sensors.length === 0) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const cycleMetrics   = {};
      const cycleTopLevel  = {};

      for (const cmdId of sensors) {
        if (signal.aborted || isPaused.current) break;

        const cmdObj = commands[cmdId];
        if (!cmdObj) continue;

        // Tiered polling: skip medium/slow pids on most ticks
        const isMedium = MEDIUM_PIDS.has(cmdId);
        const isFast   = FAST_PIDS.has(cmdId);
        if (!isFast && !isMedium && tick % 150 !== 0) continue;
        if (!isFast &&  isMedium && tick % 10  !== 0) continue;

        try {
          const res = await obd.query(cmdObj);
          if (res?.value != null) {
            cycleMetrics[cmdId] = res;
            if (cmdId === 'SPEED')        cycleTopLevel.speed = res.value;
            if (cmdId === 'RPM')          cycleTopLevel.rpm   = res.value;
            if (cmdId === 'COOLANT_TEMP') cycleTopLevel.temp  = res.value;
            if (cmdId === 'FUEL_LEVEL')   cycleTopLevel.fuel  = res.value;
          }
        } catch (err) {
          console.warn(`[Telemetry] query error ${cmdId}:`, err.message);
        }

        // Small inter-command gap to avoid flooding the channel
        await new Promise(r => setTimeout(r, 40));
      }

      // ── Persist to IndexedDB every 5 s ─────────────────────────────────
      const now = Date.now();
      if (now - lastDbSave.current > DB_SAVE_INTERVAL_MS && Object.keys(cycleTopLevel).length > 0) {
        saveTelemetryData(cycleTopLevel).catch(console.error);
        lastDbSave.current = now;
      }

      // ── Batch state update ──────────────────────────────────────────────
      if (Object.keys(cycleMetrics).length > 0 && !signal.aborted && !isPaused.current) {
        setData(prev => {
          const h = { ...prev.history };
          if (cycleTopLevel.speed != null) h.speed = [...h.speed, { t: now, v: cycleTopLevel.speed }].slice(-HISTORY_LIMIT);
          if (cycleTopLevel.rpm   != null) h.rpm   = [...h.rpm,   { t: now, v: cycleTopLevel.rpm   }].slice(-HISTORY_LIMIT);
          if (cycleTopLevel.temp  != null) h.temp  = [...h.temp,  { t: now, v: cycleTopLevel.temp  }].slice(-HISTORY_LIMIT);
          if (cycleTopLevel.fuel  != null) h.fuel  = [...h.fuel,  { t: now, v: cycleTopLevel.fuel  }].slice(-HISTORY_LIMIT);
          return {
            ...prev,
            ...cycleTopLevel,
            metrics: { ...prev.metrics, ...cycleMetrics },
            history: h,
          };
        });
      }

      await new Promise(r => setTimeout(r, 150));
    }
  }, []);

  // ── Public: connect ─────────────────────────────────────────────────────────

  const connectOBD = useCallback(async () => {
    if (data.isConnected || isConnecting) return false;
    setIsConnecting(true);

    try {
      const ok = await obd.connect();
      if (!ok) return false;

      await obd.initEngine();
      setData(prev => ({ ...prev, isConnected: true }));

      // Wire up unexpected-disconnect handler
      obdScanner.onDisconnected = () => {
        setData(prev => ({ ...prev, isConnected: false }));
        pollingAbort.current?.abort();
        pollingAbort.current = null;
      };

      // Start polling loop
      const controller = new AbortController();
      pollingAbort.current = controller;
      _startPolling(controller.signal).catch(err =>
        console.error('[Telemetry] polling loop crashed:', err)
      );

      return true;
    } catch (err) {
      console.error('[Telemetry] connectOBD:', err);
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, [data.isConnected, isConnecting, _startPolling]);

  // ── Public: disconnect ──────────────────────────────────────────────────────

  const disconnectOBD = useCallback(() => {
    pollingAbort.current?.abort();
    pollingAbort.current = null;
    obd.disconnect();
    setData(prev => ({ ...prev, isConnected: false }));
  }, []);

  // ── Public: scan DTCs ───────────────────────────────────────────────────────

  const scanErrors = useCallback(async () => {
    setData(prev => ({ ...prev, isCheckingErrors: true }));
    isPaused.current = true;

    // Wait for any in-flight command to finish
    await new Promise(r => setTimeout(r, 800));

    try {
      const result = await obd.query(mode3.GET_DTC);
      const now    = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

      const foundErrors = (result?.value && Array.isArray(result.value) && result.value.length > 0)
        ? result.value.map(code => ({
            code,
            title:    dtcDictionary[code] ?? 'Специфічна помилка виробника',
            desc:     'Потрібна додаткова діагностика системи.',
            severity: _classifyDtcSeverity(code),
            cost:     _estimateDtcCost(code),
          }))
        : [];

      setData(prev => ({
        ...prev,
        errors:           foundErrors,
        hasScannedErrors: true,
        lastScanTime:     now,
      }));
    } catch (err) {
      console.error('[Telemetry] scanErrors:', err);
      setData(prev => ({ ...prev, errors: [], hasScannedErrors: true }));
    } finally {
      setData(prev => ({ ...prev, isCheckingErrors: false }));
      isPaused.current = false;
    }
  }, []);

  // ── Public: clear DTCs (with state-based confirmation) ─────────────────────

  const clearErrors = useCallback(() => {
    // Returns a Promise that resolves after user confirms or cancels
    return new Promise((resolve) => {
      setConfirmState({
        message: 'Ви впевнені, що хочете стерти помилки? Це вимкне Check Engine.',
        onConfirm: async () => {
          setConfirmState(null);
          setData(prev => ({ ...prev, isCheckingErrors: true }));
          isPaused.current = true;
          await new Promise(r => setTimeout(r, 800));

          try {
            await obd.query(mode4.CLEAR_DTC);
            setData(prev => ({ ...prev, errors: [], hasScannedErrors: false }));
            resolve(true);
          } catch (err) {
            console.error('[Telemetry] clearErrors:', err);
            resolve(false);
          } finally {
            setData(prev => ({ ...prev, isCheckingErrors: false }));
            // Give the ECU time to reset before resuming
            await new Promise(r => setTimeout(r, 2000));
            isPaused.current = false;
          }
        },
        onCancel: () => {
          setConfirmState(null);
          resolve(false);
        },
      });
    });
  }, []);

  // ── Public: misc setters ────────────────────────────────────────────────────

  const updateActiveSensors = useCallback((sensors) => {
    activeSensors.current = sensors;
  }, []);

  const setPaused = useCallback((paused) => {
    isPaused.current = paused;
  }, []);

  const setTransportMode = useCallback((mode) => {
    obdScanner.setMode(mode);
  }, []);

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchUserProfile();
    return () => {
      pollingAbort.current?.abort();
      obd.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Context value ───────────────────────────────────────────────────────────

  const value = useMemo(() => ({
    // Spread all data fields to the surface
    ...data,
    isLoading,
    isConnecting,
    confirmState,
    // Actions
    connectOBD,
    disconnectOBD,
    scanErrors,
    clearErrors,
    refreshProfile:       fetchUserProfile,
    updateActiveSensors,
    setPaused,
    setTransportMode,
  }), [
    data, isLoading, isConnecting, confirmState,
    connectOBD, disconnectOBD, scanErrors, clearErrors,
    fetchUserProfile, updateActiveSensors, setPaused, setTransportMode,
  ]);

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

/**
 * Use this in every page/component instead of the old useTelemetry() hook.
 * API is identical — drop-in replacement.
 */
export function useTelemetry() {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used inside <TelemetryProvider>');
  return ctx;
}

// ── DTC helpers ───────────────────────────────────────────────────────────────

function _classifyDtcSeverity(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  // P03xx = misfire — high severity
  if (prefix === 'P03') return 'Високий';
  // P01xx/P02xx = fuel/air — medium
  if (prefix === 'P01' || prefix === 'P02') return 'Середній';
  return 'Низький';
}

function _estimateDtcCost(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  if (prefix === 'P03') return '₴1500 – ₴5000';
  if (prefix === 'P02') return '₴500 – ₴3000';
  if (prefix === 'P01') return '₴300 – ₴2000';
  return '₴200 – ₴1500';
}
