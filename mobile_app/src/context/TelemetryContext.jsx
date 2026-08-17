/**
 * context/TelemetryContext.jsx — Single global OBD-II telemetry state
 *
 * Changes in this version:
 *  - scanErrors: variant names now match 'Mode UDS 09' etc from index.js fix
 *  - scanErrors: stricter statusCategory logic per protocol
 *  - scanErrors: dedup reduce uses correct priority map matching new names
 *  - _dtcStatusCategory: added bit 3 (confirmedDTC) → active
 *  - Server-ready: SERVER_CONFIG imported, fetchUserProfile has server path
 *  - showArchiveErrors state exposed (toggled by UI archive dropdown)
 */

import {
  createContext, useCallback, useContext,
  useEffect, useMemo, useRef, useState,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { obd }                              from '../obd/index.js';
import { commands, mode3, mode4 }          from '../obd/commands.js';
import { obdScanner, TRANSPORT }           from '../services/bleService.js';
import {
  saveTelemetryData,
  getRecentTelemetry,
  summarizeOldData,
  saveDiagnosticReport,
} from '../services/db.js';
import { api } from '../services/api.js';
import { toast } from '../components/ui/Toast.jsx';
import dtcDictionary from '../obd/codes.json';

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/; // standard VIN: 17 chars, no I/O/Q

// ── Polling tiers ─────────────────────────────────────────────────────────────

const FAST_PIDS   = new Set(['SPEED', 'RPM', 'COOLANT_TEMP', 'THROTTLE_POS']);
const MEDIUM_PIDS = new Set(['ENGINE_LOAD', 'INTAKE_TEMP', 'FUEL_RATE', 'MAF',
                              'FUEL_TYPE', 'BAROMETRIC_PRESSURE', 'CONTROL_MODULE_VOLTAGE']);
const HISTORY_LIMIT     = 1500;
const DB_SAVE_INTERVAL_MS = 5000;

// ── Context ───────────────────────────────────────────────────────────────────

const TelemetryContext = createContext(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function TelemetryProvider({ children }) {
  const navigate = useNavigate();

  const [isLoading,    setIsLoading]    = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [data, setData] = useState({
    isConnected:       false,
    speed:             0,
    rpm:               0,
    temp:              0,
    fuel:              0,
    metrics:           {},
    errors:            [],
    hasScannedErrors:  false,
    isCheckingErrors:  false,
    lastScanTime:      null,
    showArchiveErrors: false,   // ← new: controls archive dropdown in UI
    history:           { speed: [], rpm: [], temp: [], fuel: [] },
    user:              { name: '', email: '', vehicle: '', vin: '', odometer: '', make: '', model: '', avatarBase64: null, avatarMime: null },
    profileError:      null,
  });

  const [confirmState, setConfirmState] = useState(null);

  const pollingAbort  = useRef(null);
  const isPaused      = useRef(false);
  const activeSensors = useRef([]);
  const lastDbSave    = useRef(0);
  const tickCount     = useRef(0);

  // ── Auth guard ──────────────────────────────────────────────────────────────

  const requireAuth = useCallback(() => {
    const token = localStorage.getItem('obd_token');
    if (!token) { navigate('/login', { replace: true }); return null; }
    return token;
  }, [navigate]);

  // ── Profile / init ──────────────────────────────────────────────────────────

  const fetchUserProfile = useCallback(async () => {
    const token = requireAuth();
    if (!token) { setIsLoading(false); return; }

    let user;
    let profileError = null;

    try {
      const profile = await api.getProfile();
      user = {
        id:            profile.id,
        name:          profile.name  || '',
        email:         profile.email || '',
        vehicle:       [profile.car_brand, profile.car_model].filter(Boolean).join(' '),
        vin:           profile.vin   || '',
        make:          profile.car_brand || '',
        model:         profile.car_model || '',
        avatarBase64:  profile.avatar_base64 || null,
        avatarMime:    profile.avatar_mime   || null,
      };
    } catch (err) {
      // Backend not reachable yet (or request failed) — degrade gracefully
      // instead of blocking the whole app; surface it via profileError.
      console.warn('[Telemetry] fetchUserProfile: could not reach server —', err.message);
      profileError = err.message;
      user = { name: 'Гість (офлайн)', email: '', vehicle: '', vin: '', make: '', model: '', avatarBase64: null, avatarMime: null };
    }

    try {
      const recentRows = await getRecentTelemetry(1500);
      const histSpeed = [], histRpm = [], histTemp = [], histFuel = [];
      let initialMetrics = {};
      let latestSpeed = 0, latestRpm = 0, latestTemp = 0, latestFuel = 0;

      for (const row of recentRows) {
        const t = row.timestamp;
        if (row.speed != null) { histSpeed.push({ t, v: row.speed }); latestSpeed = row.speed; initialMetrics.SPEED        = { value: row.speed, unit: 'км/год' }; }
        if (row.rpm   != null) { histRpm  .push({ t, v: row.rpm   }); latestRpm   = row.rpm;   initialMetrics.RPM          = { value: row.rpm,   unit: 'об/хв' }; }
        if (row.temp  != null) { histTemp .push({ t, v: row.temp  }); latestTemp  = row.temp;  initialMetrics.COOLANT_TEMP = { value: row.temp,  unit: '°C'    }; }
        if (row.fuel  != null) { histFuel .push({ t, v: row.fuel  }); latestFuel  = row.fuel;  initialMetrics.FUEL_RATE    = { value: row.fuel,  unit: 'л/год' }; }
      }

      setData(prev => ({
        ...prev,
        speed: latestSpeed, rpm: latestRpm, temp: latestTemp, fuel: latestFuel,
        metrics: initialMetrics,
        user,
        history: { speed: histSpeed, rpm: histRpm, temp: histTemp, fuel: histFuel },
        profileError,
      }));

      summarizeOldData().catch(console.error);

    } catch (err) {
      console.error('[Telemetry] fetchUserProfile (local history load):', err);
      setData(prev => ({ ...prev, profileError: err.message }));
    } finally {
      setIsLoading(false);
    }
  }, [navigate, requireAuth]);

  // ── Polling loop ──────────────────────────────────────────────────────────

  const _startPolling = useCallback(async (signal) => {
    tickCount.current = 0;

    while (!signal.aborted) {
      if (isPaused.current) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      const tick    = tickCount.current++;
      const sensors = activeSensors.current;
      if (sensors.length === 0) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      const cycleMetrics  = {};
      const cycleTopLevel = {};

      for (const cmdId of sensors) {
        if (signal.aborted || isPaused.current) break;

        const cmdObj = commands[cmdId];
        if (!cmdObj) continue;

        const isMedium = MEDIUM_PIDS.has(cmdId);
        const isFast   = FAST_PIDS.has(cmdId);
        if (!isFast && !isMedium && tick % 150 !== 0) continue;
        if (!isFast &&  isMedium && tick % 10  !== 0) continue;

        try {
          let res;
          if (cmdId === 'FUEL_RATE') {
            res = await obd.getSmartFuelRate();
          } else {
            res = await obd.query(cmdObj);
          }

          if (res?.value != null && res.value !== '--') {
            cycleMetrics[cmdId] = res;
            if (cmdId === 'SPEED')        cycleTopLevel.speed = res.value;
            if (cmdId === 'RPM')          cycleTopLevel.rpm   = res.value;
            if (cmdId === 'COOLANT_TEMP') cycleTopLevel.temp  = res.value;
            if (cmdId === 'FUEL_RATE')    cycleTopLevel.fuel  = res.value;
          }
        } catch (err) {
          console.warn(`[Telemetry] query error ${cmdId}:`, err.message);
        }

        await new Promise(r => setTimeout(r, 40));
      }

      const now = Date.now();
      if (now - lastDbSave.current > DB_SAVE_INTERVAL_MS && Object.keys(cycleTopLevel).length > 0) {
        saveTelemetryData(cycleTopLevel).catch(console.error);
        lastDbSave.current = now;
      }

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

      await new Promise(r => setTimeout(r, 40));
    }
  }, []);

  // ── Auto-grab VIN on first successful connect (only if not already set —
  // never overwrites a VIN the user typed in themselves) ──────────────────

  const _tryAutoGrabVin = useCallback(async (currentUser) => {
    if (currentUser?.vin) return false; // user already has one on file — don't touch it
    if (!currentUser?.name) return false; // server requires name on every profile update
    try {
      const res = await obd.query(commands['VIN']);
      const vin = (res?.value || '').toUpperCase();
      if (!VIN_RE.test(vin)) return false; // garbage/partial read — don't save junk

      await api.updateProfile({ name: currentUser.name, vin });
      return true;
    } catch (err) {
      console.warn('[Telemetry] VIN auto-grab failed:', err.message);
      return false;
    }
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────

  const connectOBD = useCallback(async () => {
    if (data.isConnected || isConnecting) return false;
    setIsConnecting(true);
    try {
      const ok = await obd.connect();
      if (!ok) return false;
      await obd.initEngine();
      setData(prev => ({ ...prev, isConnected: true }));

      obdScanner.onDisconnected = () => {
        setData(prev => ({ ...prev, isConnected: false }));
        pollingAbort.current?.abort();
        pollingAbort.current = null;
      };

      // MUST run to completion before polling starts — the BLE transport has
      // only a single in-flight command slot (bleService.js's _setupPending
      // silently discards whatever was still pending when a new command is
      // sent, without ever resolving/rejecting it). Firing this concurrently
      // with the polling loop's first tick corrupts the response stream for
      // both, which previously caused the whole app to hang waiting on data
      // that would never arrive correctly.
      try {
        const didSave = await _tryAutoGrabVin(data.user);
        if (didSave) {
          fetchUserProfile();
          toast.success('VIN автомобіля визначено автоматично');
        }
      } catch (err) {
        console.warn('[Telemetry] VIN auto-grab step failed, continuing:', err.message);
      }

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
  }, [data.isConnected, isConnecting, _startPolling, data.user, _tryAutoGrabVin, fetchUserProfile]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnectOBD = useCallback(() => {
    pollingAbort.current?.abort();
    pollingAbort.current = null;
    obd.disconnect();
    setData(prev => ({ ...prev, isConnected: false }));
  }, []);

  // ── Scan DTCs ─────────────────────────────────────────────────────────────

  const scanErrors = useCallback(async () => {
    setData(prev => ({ ...prev, isCheckingErrors: true }));
    isPaused.current = true;
    await new Promise(r => setTimeout(r, 800));

    try {
      const now = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

      const result = await obd.smartReadDTC(dtcDictionary);
      console.log(`[OBD] Сканування завершено. ${result.variant}`);
      console.log(`[OBD] Сирі коди до фільтрації:`, result.codes.map(c => c.base || c));

      const finalErrors = result.codes
        // ── 1. Only codes in our dictionary ────────────────────────────────
        .filter(codeItem => {
          const known = !!dtcDictionary[codeItem.base];
          if (!known) console.log(`[DTC] Dropping unknown: ${codeItem.base}`);
          return known;
        })
        // ── 2. Deduplicate — keep highest-priority source per base code ────
        .reduce((acc, codeItem) => {
          const existing = acc.find(e => e.base === codeItem.base);
          if (!existing) {
            acc.push(codeItem);
          } else {
            // Priority: lower number = higher priority
            // Names must match what index.js sets in method.name
            const PRIORITY = {
              'Mode 03':    0,
              'Mode UDS 09': 1,
              'Mode UDS 08': 1,
              'Mode UDS 01': 1,
              'Mode UDS 04': 1,
              'Mode 07':    2,
              'Mode 0A':    3,
              'KWP 00':     4,
              'KWP FF':     4,
            };
            const newP  = PRIORITY[codeItem.variant] ?? 99;
            const exstP = PRIORITY[existing.variant]  ?? 99;
            if (newP < exstP) {
              const idx = acc.indexOf(existing);
              acc[idx]  = codeItem;
            }
          }
          return acc;
        }, [])
        // ── 3. Map to final shape ─────────────────────────────────────────
        .map(codeItem => {
          const baseCode = codeItem.base;
          const v        = codeItem.variant ?? '';

          /**
           * Protocol-level status takes precedence over UDS status byte:
           *   Mode 03  → confirmed active in ECU memory       → 'active'
           *   Mode UDS → use status byte bitmask (ISO 14229-1)
           *   Mode 07  → pending (failed this drive cycle)    → 'pending'
           *   Mode 0A  → permanent (survives Mode 04 clear)   → 'historic'
           *   KWP      → treat same as Mode 03                → 'active'
           */
          let statusCategory;
          if (v.includes('Mode 07')) {
            statusCategory = 'pending';
          } else if (v.includes('Mode 0A')) {
            statusCategory = 'historic';
          } else if (v.includes('Mode 03') || v.includes('KWP')) {
            statusCategory = 'active';
          } else {
            // UDS — use statusByte bitmask
            statusCategory = _dtcStatusCategory(codeItem.statusByte ?? null);
          }

          return {
            code:           codeItem.code,
            title:          codeItem.title,
            desc:           `Протокол: ${codeItem.variant || result.variant}`,
            severity:       _classifyDtcSeverity(baseCode),
            cost:           _estimateDtcCost(baseCode),
            statusCategory,
            statusByte:     codeItem.statusByte ?? null,
          };
        });

      // Debug
      const counts = finalErrors.reduce((acc, e) => {
        acc[e.statusCategory] = (acc[e.statusCategory] || 0) + 1;
        return acc;
      }, {});
      console.log('[Telemetry] DTC categories after filter:', counts);
      console.log('[Telemetry] Final errors:', finalErrors.map(e => `${e.code} (${e.statusCategory})`));

      setData(prev => ({
        ...prev,
        errors:           finalErrors,
        hasScannedErrors: true,
        lastScanTime:     now,
      }));

      saveDiagnosticReport('scanned_errors', finalErrors).catch(console.error);

    } catch (err) {
      console.error('[Telemetry] scanErrors:', err);
      setData(prev => ({ ...prev, errors: [], hasScannedErrors: true }));
    } finally {
      setData(prev => ({ ...prev, isCheckingErrors: false }));
      isPaused.current = false;
    }
  }, []);

  // ── Clear DTCs ────────────────────────────────────────────────────────────

  const clearErrors = useCallback(() => {
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
            saveDiagnosticReport('scanned_errors', []).catch(console.error);
            resolve(true);
          } catch (err) {
            console.error('[Telemetry] clearErrors:', err);
            resolve(false);
          } finally {
            setData(prev => ({ ...prev, isCheckingErrors: false }));
            await new Promise(r => setTimeout(r, 2000));
            isPaused.current = false;
          }
        },
        onCancel: () => { setConfirmState(null); resolve(false); },
      });
    });
  }, []);

  // ── Generic confirm dialog (for any page — window.confirm is a no-op in Capacitor) ──

  const confirmDialog = useCallback((message) => {
    return new Promise((resolve) => {
      setConfirmState({
        message,
        onConfirm: () => { setConfirmState(null); resolve(true); },
        onCancel:  () => { setConfirmState(null); resolve(false); },
      });
    });
  }, []);

  // ── Misc setters ──────────────────────────────────────────────────────────

  const updateActiveSensors = useCallback((sensors) => {
    activeSensors.current = sensors;
  }, []);

  const setPaused = useCallback((paused) => {
    isPaused.current = paused;
  }, []);

  const setTransportMode = useCallback((mode) => {
    obdScanner.setMode(mode);
  }, []);

  // Toggle archive error dropdown visibility (persisted in data state
  // so it resets on re-scan — intentional)
  const toggleArchiveErrors = useCallback(() => {
    setData(prev => ({ ...prev, showArchiveErrors: !prev.showArchiveErrors }));
  }, []);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchUserProfile();
    return () => {
      // Only abort polling on unmount — do NOT call obd.disconnect() here.
      // TelemetryProvider lives inside BrowserRouter and stays mounted for
      // the entire app lifetime, so this cleanup only fires on full app
      // unmount. However on some Capacitor/React Router versions a hot
      // reload or strict-mode double-mount fires this, killing BLE.
      // Explicit disconnects go through disconnectOBD() only.
      pollingAbort.current?.abort();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Context value ─────────────────────────────────────────────────────────

  const value = useMemo(() => ({
    ...data,
    isLoading,
    isConnecting,
    confirmState,
    // Actions
    connectOBD,
    disconnectOBD,
    scanErrors,
    clearErrors,
    confirmDialog,
    toggleArchiveErrors,
    refreshProfile:     fetchUserProfile,
    updateActiveSensors,
    setPaused,
    setTransportMode,
  }), [
    data, isLoading, isConnecting, confirmState,
    connectOBD, disconnectOBD, scanErrors, clearErrors, confirmDialog,
    toggleArchiveErrors, fetchUserProfile, updateActiveSensors,
    setPaused, setTransportMode,
  ]);

  return (
    <TelemetryContext.Provider value={value}>
      {children}
    </TelemetryContext.Provider>
  );
}

// ── Consumer hook ─────────────────────────────────────────────────────────────

export function useTelemetry() {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used inside <TelemetryProvider>');
  return ctx;
}

// ── DTC helpers ───────────────────────────────────────────────────────────────

function _classifyDtcSeverity(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  if (prefix === 'P03') return 'Високий';
  if (prefix === 'P01' || prefix === 'P02') return 'Середній';
  return 'Низький';
}

/**
 * ISO 14229-1 §D.3 DTC Status Byte bitmask:
 *  Bit 0 (0x01) testFailed           — currently failing  → active
 *  Bit 3 (0x08) confirmedDTC         — confirmed in memory → active
 *  Bit 2 (0x04) pendingDTC           — failed this cycle  → pending
 *  All others without 0/3/2          → historic
 */
function _dtcStatusCategory(statusByte) {
  if (statusByte === null || statusByte === undefined) return 'active';
  if (statusByte & 0x01) return 'active';   // bit 0: test currently failing
  if (statusByte & 0x08) return 'active';   // bit 3: confirmed DTC
  if (statusByte & 0x04) return 'pending';  // bit 2: pending DTC
  return 'historic';
}

function _estimateDtcCost(code) {
  if (!code) return 'Невідомо';
  const prefix = code.substring(0, 3);
  if (prefix === 'P03') return '₴1500 – ₴5000';
  if (prefix === 'P02') return '₴500 – ₴3000';
  if (prefix === 'P01') return '₴300 – ₴2000';
  return '₴200 – ₴1500';
}
