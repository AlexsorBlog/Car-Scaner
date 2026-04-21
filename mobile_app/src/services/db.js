import { Capacitor } from '@capacitor/core';

const DB_NAME = 'OBD_Telemetry';
// Звичайна IndexedDB для веб-розробки (залишаємо як фолбек)
const initWebDB = () => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('raw_telemetry')) {
        const store = db.createObjectStore('raw_telemetry', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
  });
};

export const saveTelemetryData = async (dataPoint) => {
  const isNative = Capacitor.isNativePlatform();
  const timestamp = Date.now();
  
  if (isNative) {
    // ТУТ БУДЕ ЛОГІКА CAPACITOR SQLITE
    // Приклад: await sqlite.query(`INSERT INTO raw_telemetry (speed, rpm, timestamp) VALUES (?, ?, ?)`, [dataPoint.speed, dataPoint.rpm, timestamp]);
    console.log("[SQLite] Збережено:", dataPoint);
  } else {
    // Web Fallback
    const db = await initWebDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('raw_telemetry', 'readwrite');
      tx.objectStore('raw_telemetry').add({ ...dataPoint, timestamp });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
};

export const getRecentTelemetry = async (limit = 1000) => {
  const isNative = Capacitor.isNativePlatform();
  
  if (isNative) {
    // ТУТ БУДЕ ЛОГІКА CAPACITOR SQLITE
    // Приклад: const res = await sqlite.query(`SELECT * FROM raw_telemetry ORDER BY timestamp DESC LIMIT ?`, [limit]);
    // return res.values.reverse();
    return []; // Тимчасова заглушка
  } else {
    // Web Fallback
    const db = await initWebDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('raw_telemetry', 'readonly');
      const index = tx.objectStore('raw_telemetry').index('timestamp');
      const request = index.openCursor(null, 'prev');
      
      const results = [];
      request.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results.reverse());
        }
      };
      request.onerror = () => reject(request.error);
    });
  }
};

export const summarizeOldData = async () => {
  console.log("[DB] Агрегація старих даних...");
};