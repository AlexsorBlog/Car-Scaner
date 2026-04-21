import React, { useState, useRef, useEffect } from 'react';
import { obd } from '../obd/index.js';
import { mode1Commands, mode3, mode4 } from '../obd/commands.js';
import { obdScanner } from '../services/bleService.js';
import dtcDictionary from '../obd/codes.json'; // Імпортуємо ваш JSON-словник з помилками

export default function BluetoothTest() {
  const [useEmulator, setUseEmulator] = useState(true); // За замовчуванням Емулятор
  const [status, setStatus] = useState('Відключено');
  const [logs, setLogs] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [isScanning, setIsScanning] = useState(false);
  
  // Стан для помилок
  const [errorCodes, setErrorCodes] = useState(null); 
  const [isCheckingErrors, setIsCheckingErrors] = useState(false);

  const isPolling = useRef(false);
  const isPaused = useRef(false); // ПРАПОРЕЦЬ ПАУЗИ

  useEffect(() => {
    if (obdScanner) {
      obdScanner.onLog = (msg) => {
        setLogs(prev => [...prev.slice(-14), msg]);
      };
    }
    return () => {
      isPolling.current = false;
      obd?.disconnect?.();
    };
  }, []);

  const connectToOBD = async () => {
    setStatus('Підключення...');
    const success = await obd?.connect?.();
    if (!success) { setStatus('Помилка підключення'); return; }

    setStatus('Ініціалізація ELM327...');
    setIsScanning(true);
    await obd?.initEngine?.();
    
    startDataLoop();
  };

  // ФУНКЦІЯ СТИРАННЯ ПОМИЛОК (Mode 04)
  const clearErrors = async () => {
    if (!window.confirm("Ви впевнені, що хочете стерти помилки? Це вимкне Check Engine.")) return;

    setIsCheckingErrors(true);
    isPaused.current = true; // Ставимо живі дані на паузу
    setStatus('Стирання помилок (Mode 04)...');

    // Даємо час попередній команді завершитися
    await new Promise(r => setTimeout(r, 1000));

    try {
      // Відправляємо команду "04"
      await obd.query(mode4.CLEAR_DTC);
      
      // Якщо команда пройшла успішно, очищаємо наш інтерфейс
      setErrorCodes([]);
      setStatus('Помилки успішно стерто!');
    } catch (e) {
      console.error(e);
      setStatus('Не вдалося стерти помилки');
    }

    // Робимо паузу перед відновленням живих даних (ЕБП машини потрібен час на перезавантаження)
    setTimeout(() => {
      setIsCheckingErrors(false);
      isPaused.current = false;
      setStatus('Збір даних активний...');
    }, 2000);
  };

  const startDataLoop = async () => {
    isPolling.current = true;
    setStatus('Збір даних активний...');

    const commandList = mode1Commands; 
    const failCounts = {};

    while (isPolling.current) {
      // 1. ПЕРЕВІРКА ПАУЗИ
      if (isPaused.current) {
        await new Promise(r => setTimeout(r, 500)); // Чекаємо півсекунди і перевіряємо знову
        continue;
      }

      for (let cmd of commandList) {
        if (!isPolling.current || isPaused.current) break; // Виходимо з внутрішнього циклу, якщо пауза

        if (failCounts[cmd.name] >= 5) continue; 

        const result = await obd?.query?.(cmd);
        
        if (result) {
          failCounts[cmd.name] = 0;
          setMetrics(prev => ({ ...prev, [cmd.name]: `${result.value} ${result.unit}` }));
        } else {
          failCounts[cmd.name] = (failCounts[cmd.name] || 0) + 1;
          if (failCounts[cmd.name] === 5) {
            setMetrics(prev => ({ ...prev, [cmd.name]: 'Не підтримується' }));
          }
        }

        await new Promise(r => setTimeout(r, 100));
      }
    }
  };

  // ФУНКЦІЯ ЗЧИТУВАННЯ ПОМИЛОК
  const scanForErrors = async () => {
    setIsCheckingErrors(true);
    isPaused.current = true; // Ставимо живі дані на паузу
    setStatus('Зчитування помилок (DTC)...');

    // Чекаємо мить, щоб поточний запит Mode 01 встиг завершитися
    await new Promise(r => setTimeout(r, 1000));

    try {
      // Відправляємо команду Mode 03 (GET_DTC)
      const result = await obd.query(mode3.GET_DTC);
      
      if (result && Array.isArray(result.value) && result.value.length > 0) {
        // Формуємо масив об'єктів з розшифровкою
        const foundErrors = result.value.map(code => ({
          code: code,
          description: dtcDictionary[code] || "Невідомий код помилки (Специфічний для виробника)"
        }));
        setErrorCodes(foundErrors);
      } else {
        setErrorCodes([]); // Помилок немає!
      }
    } catch (e) {
      console.error(e);
      setErrorCodes([]);
    }

    // Знімаємо паузу
    setIsCheckingErrors(false);
    isPaused.current = false;
    setStatus('Збір даних активний...');
  };

  const stopConnection = () => {
    isPolling.current = false;
    setIsScanning(false);
    setStatus('Відключено користувачем');
    obd?.disconnect?.();
  };

  const toggleMode = () => {
    const newMode = !useEmulator;
    setUseEmulator(newMode);
    obdScanner.setMode(newMode); // Повідомляємо сервісу
  };

  return (
    
    <div className="p-5 font-sans min-h-screen bg-[#050505] text-white">
      {/* НОВИЙ БЛОК: Перемикач режимів */}
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
        
        {/* Анімований фон перемикача */}
        <div className={`absolute top-1 bottom-1 w-[calc(50%-4px)] bg-blue-600 rounded-lg transition-all duration-300 ${useEmulator ? 'left-1' : 'left-[calc(50%+2px)]'}`} />
      </div>

      {/* Попередження, якщо обрано Bluetooth на Laptop */}
      {!useEmulator && Capacitor.getPlatform() === 'web' && (
        <div className="text-[10px] text-orange-400 mb-4 px-2 italic">
          ⚠️ Увага: Web Bluetooth вимагає HTTPS або localhost у Chrome.
        </div>
      )}
      <h1 className="text-2xl font-bold mb-4">Жива Діагностика (OBD-II)</h1>
      
      <div className="bg-gray-900 p-4 rounded-xl mb-4 border border-gray-800 flex justify-between items-center">
        <div>
          <div className="text-sm text-gray-400 mb-1">Статус:</div>
          <div className={`text-sm font-bold ${isScanning ? 'text-green-400 animate-pulse' : 'text-blue-400'}`}>
            {status}
          </div>
        </div>
        {isScanning && (
          <button onClick={stopConnection} className="bg-red-900/50 text-red-500 px-4 py-2 rounded-lg text-xs font-bold border border-red-900/50">
            ЗУПИНИТИ
          </button>
        )}
      </div>

      {!isScanning ? (
        <button onClick={connectToOBD} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-xl mb-6 shadow-[0_0_15px_rgba(37,99,235,0.4)]">
          ПІДКЛЮЧИТИ СКАНЕР
        </button>
      ) : (
        <button 
          onClick={scanForErrors} 
          disabled={isCheckingErrors}
          className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-bold py-4 rounded-xl mb-6 shadow-[0_0_15px_rgba(234,88,12,0.4)]"
        >
          {isCheckingErrors ? "СКАНУЮ..." : "⚠️ ЗЧИТАТИ ПОМИЛКИ (CHECK ENGINE)"}
        </button>
      )}

      {/* Блок відображення помилок */}
      {/* Блок відображення помилок */}
      {errorCodes !== null && (
        <div className={`p-4 rounded-xl mb-6 border ${errorCodes.length > 0 ? 'bg-red-950/30 border-red-800' : 'bg-green-950/30 border-green-800'}`}>
          <h2 className="font-bold text-lg mb-2 flex items-center">
            {errorCodes.length > 0 ? "🔴 Знайдено помилки:" : "🟢 Помилок не знайдено (ECU чистий)"}
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
              
              {/* НОВА КНОПКА СТИРАННЯ */}
              <button 
                onClick={clearErrors} 
                disabled={isCheckingErrors}
                className="w-full mt-4 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold py-3 rounded-lg shadow-lg border border-red-500"
              >
                🧹 СТЕРТИ ПОМИЛКИ (Скинути Check Engine)
              </button>
            </>
          )}

          <button onClick={() => setErrorCodes(null)} className="mt-4 text-xs text-gray-400 underline block text-center w-full">Сховати панель</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 mb-6">
        {mode1Commands.map((item) => (
          <div key={item.name} className="bg-[#111318] p-3 rounded-xl border border-gray-800 flex flex-col">
            <span className="text-[10px] text-gray-500 font-bold uppercase">{item.desc}</span>
            <span className="text-xl font-bold text-white mt-1">
              {metrics[item.name] ? metrics[item.name] : <span className="text-gray-700">--</span>}
            </span>
          </div>
        ))}
      </div>

      <div className="bg-black p-4 rounded-xl border border-gray-800 h-48 overflow-y-auto font-mono text-[10px] flex flex-col-reverse">
        <div>
          {logs.map((log, index) => (
            <div key={index} className={`${log.includes('ERROR') ? 'text-red-500' : 'text-green-500'} opacity-80 mb-1`}> {log}</div>
          ))}
        </div>
      </div>
    </div>
  );
}