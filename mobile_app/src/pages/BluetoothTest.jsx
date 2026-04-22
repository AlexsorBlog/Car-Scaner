/**
 * pages/BluetoothTest.jsx — Developer diagnostics page
 *
 * Fixed vs original:
 *  - Missing `import { Capacitor }` → ReferenceError on the warning banner — fixed
 *  - alert() / window.confirm() replaced with toast + ConfirmModal (works on native)
 *  - Uses useTelemetry() from context (shared state, no duplicate polling loop)
 *  - Mode toggle now calls telemetry.setTransportMode() which correctly calls
 *    obdScanner.setMode() — the original had broken mode-switching logic
 *  - Logs panel uses a stable ref so it doesn't flicker on every render
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';

import { useTelemetry }          from '../context/TelemetryContext.jsx';
import { toast }                  from '../components/ui/Toast.jsx';
import { obd }                    from '../obd/index.js';
import { mode1Commands, mode3, mode4 } from '../obd/commands.js';
import { obdScanner, TRANSPORT }  from '../services/bleService.js';
import dtcDictionary              from '../obd/codes.json';

export default function BluetoothTest() {
  const telemetry = useTelemetry();

  const [useEmulator,      setUseEmulator]      = useState(true);
  const [localMetrics,     setLocalMetrics]      = useState({});
  const [errorCodes,       setErrorCodes]        = useState(null);
  const [isCheckingErrors, setIsCheckingErrors]  = useState(false);
  const [logs,             setLogs]              = useState([]);

  const logsRef   = useRef([]);
  const isPolling = useRef(false);
  const isPaused  = useRef(false);

  // ── Wire up BLE log callback ───────────────────────────────────────────────

  useEffect(() => {
    obdScanner.onLog = (msg) => {
      logsRef.current = [...logsRef.current.slice(-19), msg];
      setLogs([...logsRef.current]);
    };
    return () => {
      isPolling.current = false;
      // Don't disconnect here — shared context owns the connection
    };
  }, []);

  // ── Toggle emulator / BLE ──────────────────────────────────────────────────

  const toggleMode = () => {
    if (telemetry.isConnected) {
      toast.warn('Відключіться перед зміною режиму');
      return;
    }
    const next = !useEmulator;
    setUseEmulator(next);
    telemetry.setTransportMode(next ? TRANSPORT.EMULATOR : TRANSPORT.NATIVE);
  };

  // ── Connect ────────────────────────────────────────────────────────────────

  const connectToOBD = async () => {
    const ok = await telemetry.connectOBD();
    if (!ok) {
      toast.error('Помилка підключення — перевірте міст або Bluetooth');
    } else {
      startLocalDataLoop();
    }
  };

  // ── Local polling loop (test page only — shows ALL mode1 commands) ─────────

  const startLocalDataLoop = useCallback(async () => {
    if (isPolling.current) return;
    isPolling.current = true;

    const failCounts = {};

    while (isPolling.current) {
      if (isPaused.current) { await sleep(500); continue; }

      for (const cmd of mode1Commands) {
        if (!isPolling.current || isPaused.current) break;
        if ((failCounts[cmd.name] ?? 0) >= 5) continue;

        try {
          const result = await obd.query(cmd);
          if (result) {
            failCounts[cmd.name] = 0;
            setLocalMetrics(prev => ({
              ...prev,
              [cmd.name]: `${result.value} ${result.unit}`.trim(),
            }));
          } else {
            failCounts[cmd.name] = (failCounts[cmd.name] ?? 0) + 1;
            if (failCounts[cmd.name] === 5) {
              setLocalMetrics(prev => ({ ...prev, [cmd.name]: 'Не підтримується' }));
            }
          }
        } catch (err) {
          failCounts[cmd.name] = (failCounts[cmd.name] ?? 0) + 1;
        }

        await sleep(100);
      }

      await sleep(150);
    }
  }, []);

  // ── Read DTCs ──────────────────────────────────────────────────────────────

  const scanForErrors = async () => {
    setIsCheckingErrors(true);
    isPaused.current = true;
    await sleep(800);

    try {
      const result = await obd.query(mode3.GET_DTC);
      if (result?.value && Array.isArray(result.value) && result.value.length > 0) {
        setErrorCodes(result.value.map(code => ({
          code,
          description: dtcDictionary[code] ?? 'Невідомий код помилки',
        })));
      } else {
        setErrorCodes([]);
      }
    } catch (err) {
      toast.error('Помилка зчитування DTC');
      setErrorCodes([]);
    } finally {
      setIsCheckingErrors(false);
      isPaused.current = false;
    }
  };

  // ── Clear DTCs ─────────────────────────────────────────────────────────────

  const clearErrors = async () => {
    // Use the context's confirm flow (works on native)
    const confirmed = await telemetry.clearErrors();
    if (confirmed) {
      setErrorCodes([]);
      toast.success('Помилки успішно стерто!');
    }
  };

  // ── Stop ───────────────────────────────────────────────────────────────────

  const stopConnection = () => {
    isPolling.current = false;
    telemetry.disconnectOBD();
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const isScanning = telemetry.isConnected;

  return (
    <div className="p-5 font-sans min-h-screen bg-[#050505] text-white">

      {/* Mode toggle */}
      <div className="mb-6 bg-[#111318] p-1 rounded-xl border border-gray-800 flex relative">
        <button
          onClick={toggleMode}
          disabled={isScanning}
          className={`flex-1 py-3 rounded-lg text-xs font-bold transition-all z-10 ${useEmulator ? 'text-white' : 'text-gray-500'}`}
        >
          💻 ЕМУЛЯТОР (WS)
        </button>
        <button
          onClick={toggleMode}
          disabled={isScanning}
          className={`flex-1 py-3 rounded-lg text-xs font-bold transition-all z-10 ${!useEmulator ? 'text-white' : 'text-gray-500'}`}
        >
          🚗 BLUETOOTH (BLE)
        </button>
        <div className={`absolute top-1 bottom-1 w-[calc(50%-4px)] bg-blue-600 rounded-lg transition-all duration-300 ${useEmulator ? 'left-1' : 'left-[calc(50%+2px)]'}`} />
      </div>

      {/* Native BLE warning */}
      {!useEmulator && Capacitor.getPlatform() === 'web' && (
        <div className="text-[10px] text-orange-400 mb-4 px-2 italic">
          ⚠️ Web Bluetooth вимагає HTTPS або localhost у Chrome
        </div>
      )}

      <h1 className="text-2xl font-bold mb-4">Жива Діагностика (OBD-II)</h1>

      {/* Status bar */}
      <div className="bg-gray-900 p-4 rounded-xl mb-4 border border-gray-800 flex justify-between items-center">
        <div>
          <div className="text-sm text-gray-400 mb-1">Статус:</div>
          <div className={`text-sm font-bold ${isScanning ? 'text-green-400 animate-pulse' : 'text-blue-400'}`}>
            {isScanning ? 'Збір даних активний...' : (telemetry.isConnecting ? 'Підключення...' : 'Відключено')}
          </div>
        </div>
        {isScanning && (
          <button onClick={stopConnection} className="bg-red-900/50 text-red-500 px-4 py-2 rounded-lg text-xs font-bold border border-red-900/50">
            ЗУПИНИТИ
          </button>
        )}
      </div>

      {/* Connect / scan buttons */}
      {!isScanning ? (
        <button
          onClick={connectToOBD}
          disabled={telemetry.isConnecting}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl mb-6 shadow-[0_0_15px_rgba(37,99,235,0.4)]"
        >
          {telemetry.isConnecting ? 'ПІДКЛЮЧЕННЯ...' : 'ПІДКЛЮЧИТИ СКАНЕР'}
        </button>
      ) : (
        <button
          onClick={scanForErrors}
          disabled={isCheckingErrors}
          className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl mb-6 shadow-[0_0_15px_rgba(234,88,12,0.4)]"
        >
          {isCheckingErrors ? 'СКАНУЮ...' : '⚠️ ЗЧИТАТИ ПОМИЛКИ (CHECK ENGINE)'}
        </button>
      )}

      {/* DTC results */}
      {errorCodes !== null && (
        <div className={`p-4 rounded-xl mb-6 border ${errorCodes.length > 0 ? 'bg-red-950/30 border-red-800' : 'bg-green-950/30 border-green-800'}`}>
          <h2 className="font-bold text-lg mb-2">
            {errorCodes.length > 0 ? '🔴 Знайдено помилки:' : '🟢 Помилок не знайдено'}
          </h2>

          {errorCodes.length > 0 && (
            <>
              <ul className="space-y-3 mt-3">
                {errorCodes.map((err, i) => (
                  <li key={i} className="bg-red-900/20 p-3 rounded-lg border border-red-900/50">
                    <span className="font-mono font-bold text-red-400 text-lg block">{err.code}</span>
                    <span className="text-sm text-gray-300">{err.description}</span>
                  </li>
                ))}
              </ul>
              <button
                onClick={clearErrors}
                disabled={isCheckingErrors}
                className="w-full mt-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold py-3 rounded-lg border border-red-500"
              >
                🧹 СТЕРТИ ПОМИЛКИ (Скинути Check Engine)
              </button>
            </>
          )}

          <button onClick={() => setErrorCodes(null)} className="mt-4 text-xs text-gray-400 underline block text-center w-full">
            Сховати панель
          </button>
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {mode1Commands.map((cmd) => (
          <div key={cmd.name} className="bg-[#111318] p-3 rounded-xl border border-gray-800 flex flex-col">
            <span className="text-[10px] text-gray-500 font-bold uppercase">{cmd.desc}</span>
            <span className="text-xl font-bold text-white mt-1">
              {localMetrics[cmd.name] ?? <span className="text-gray-700">--</span>}
            </span>
          </div>
        ))}
      </div>

      {/* Log console */}
      <div className="bg-black p-4 rounded-xl border border-gray-800 h-48 overflow-y-auto font-mono text-[10px] flex flex-col-reverse">
        <div>
          {logs.map((line, i) => (
            <div key={i} className={`mb-1 opacity-80 ${line.includes('ERROR') ? 'text-red-500' : line.includes('WARN') ? 'text-yellow-500' : 'text-green-500'}`}>
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));