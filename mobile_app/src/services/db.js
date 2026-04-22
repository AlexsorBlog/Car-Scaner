/**
 * services/db.js — Local telemetry storage
 * Implements @capacitor-community/sqlite for native platforms (iOS/Android)
 * while preserving the IndexedDB fallback for local web development.
 * Додано версію 3 для таблиць user_profile та diagnostic_reports.
 */

import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = 'OBD_Telemetry';
const DB_VERSION = 3; 
const DETAIL_DAYS = 7;   
const MS_PER_DAY  = 86_400_000;

// ── SQLite Initialization (Native) ────────────────────────────────────────────

let _sqliteConnection = null;
let _sqliteDbPromise = null;

function getNativeDB() {
  if (_sqliteDbPromise) return _sqliteDbPromise;

  _sqliteDbPromise = (async () => {
    if (!_sqliteConnection) {
      _sqliteConnection = new SQLiteConnection(CapacitorSQLite);
    }
    
    try {
      const ret = await _sqliteConnection.checkConnectionsConsistency();
      const isConn = (await _sqliteConnection.isConnection(DB_NAME, false)).result;
      let db;
      
      if (ret.result && isConn) {
        db = await _sqliteConnection.retrieveConnection(DB_NAME, false);
      } else {
        db = await _sqliteConnection.createConnection(DB_NAME, false, "no-encryption", DB_VERSION, false);
      }
      
      await db.open();

      const schema = `
        CREATE TABLE IF NOT EXISTS raw_telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          speed REAL,
          rpm REAL,
          temp REAL,
          fuel REAL
        );
        CREATE INDEX IF NOT EXISTS idx_timestamp ON raw_telemetry(timestamp);

        CREATE TABLE IF NOT EXISTS daily_summary (
          date TEXT PRIMARY KEY,
          avgSpeed REAL, maxSpeed REAL,
          avgRpm REAL, maxRpm REAL,
          avgTemp REAL, maxTemp REAL,
          avgFuel REAL, minFuel REAL,
          samples INTEGER, drivingMinutes INTEGER
        );

        CREATE TABLE IF NOT EXISTS user_profile (
          id INTEGER PRIMARY KEY DEFAULT 1,
          name TEXT, email TEXT, vehicle TEXT, vin TEXT, odometer TEXT, make TEXT, model TEXT, updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS diagnostic_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          data TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_reports_type ON diagnostic_reports(type);
      `;
      await db.execute(schema);
      return db;
    } catch (err) {
      console.error('[DB] SQLite Init Error:', err);
      _sqliteDbPromise = null; 
      throw err;
    }
  })();

  return _sqliteDbPromise;
}

// ── IndexedDB Initialization (Web Fallback) ───────────────────────────────────

let _dbPromise = null;

function getDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };

    req.onsuccess = () => resolve(req.result);

    req.onupgradeneeded = (e) => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      if (oldVer < 1) {
        const store = db.createObjectStore('raw_telemetry', { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }

      if (oldVer < 2) {
        if (!db.objectStoreNames.contains('daily_summary')) {
          db.createObjectStore('daily_summary', { keyPath: 'date' });
        }
      }

      if (oldVer < 3) {
        if (!db.objectStoreNames.contains('user_profile')) {
          db.createObjectStore('user_profile', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('diagnostic_reports')) {
          const repStore = db.createObjectStore('diagnostic_reports', { keyPath: 'id', autoIncrement: true });
          repStore.createIndex('type', 'type', { unique: false });
          repStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      }
    };
  });

  return _dbPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toISODate(ts) {
  return new Date(ts).toISOString().slice(0, 10); 
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(new Error('Transaction aborted'));
  });
}

// ── Public API (Reports & Profile) ────────────────────────────────────────────

export async function saveDiagnosticReport(type, data) {
  const ts = Date.now();
  
  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      await db.run(
        `INSERT INTO diagnostic_reports (timestamp, type, data) VALUES (?, ?, ?)`,
        [ts, type, JSON.stringify(data)]
      );
    } catch (err) { console.error('[DB] SQLite saveDiagnosticReport failed:', err); }
    return;
  }

  try {
    const db = await getDB();
    const tx = db.transaction('diagnostic_reports', 'readwrite');
    tx.objectStore('diagnostic_reports').add({ timestamp: ts, type, data });
    await txPromise(tx);
  } catch (err) { console.error('[DB] saveDiagnosticReport failed:', err); }
}

export async function getDiagnosticReports(type, limit = 10) {
  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      const res = await db.query(
        `SELECT * FROM diagnostic_reports WHERE type = ? ORDER BY timestamp DESC LIMIT ?`,
        [type, limit]
      );
      return (res.values || []).map(row => ({
        ...row,
        data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data
      }));
    } catch (err) {
      console.error('[DB] SQLite getDiagnosticReports failed:', err);
      return [];
    }
  }

  try {
    const db = await getDB();
    const tx = db.transaction('diagnostic_reports', 'readonly');
    const idx = tx.objectStore('diagnostic_reports').index('type');
    const range = IDBKeyRange.only(type);
    
    return new Promise((resolve, reject) => {
      const results = [];
      const req = idx.openCursor(range, 'prev'); 
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('[DB] getDiagnosticReports failed:', err);
    return [];
  }
}

export async function saveUserProfile(profileData) {
  const ts = Date.now();
  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      await db.run(
        `INSERT OR REPLACE INTO user_profile (id, name, email, vehicle, vin, odometer, make, model, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [profileData.name, profileData.email, profileData.vehicle, profileData.vin, profileData.odometer, profileData.make, profileData.model, ts]
      );
    } catch (err) { console.error('[DB] SQLite saveUserProfile failed:', err); }
    return;
  }

  try {
    const db = await getDB();
    const tx = db.transaction('user_profile', 'readwrite');
    tx.objectStore('user_profile').put({ id: 1, ...profileData, updated_at: ts });
    await txPromise(tx);
  } catch (err) { console.error('[DB] saveUserProfile failed:', err); }
}


// ── Public API (Telemetry) ────────────────────────────────────────────────────

export async function saveTelemetryData(dataPoint) {
  const ts = Date.now();

  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      await db.run(
        `INSERT INTO raw_telemetry (timestamp, speed, rpm, temp, fuel) VALUES (?, ?, ?, ?, ?)`,
        [ ts, dataPoint.speed ?? null, dataPoint.rpm ?? null, dataPoint.temp ?? null, dataPoint.fuel ?? null ]
      );
    } catch (err) { console.error('[DB] SQLite saveTelemetryData failed:', err); }
    return;
  }

  try {
    const db = await getDB();
    const tx = db.transaction('raw_telemetry', 'readwrite');
    tx.objectStore('raw_telemetry').add({ ...dataPoint, timestamp: ts });
    await txPromise(tx);
  } catch (err) { console.error('[DB] saveTelemetryData failed:', err); }
}

export async function getRecentTelemetry(limit = 1000, sinceMs = 0) {
  const lower = sinceMs > 0 ? sinceMs : (Date.now() - DETAIL_DAYS * MS_PER_DAY);

  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      const res = await db.query(
        `SELECT * FROM raw_telemetry WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?`,
        [lower, limit]
      );
      return (res.values || []).reverse();
    } catch (err) {
      console.error('[DB] SQLite getRecentTelemetry failed:', err);
      return [];
    }
  }

  try {
    const db  = await getDB();
    const tx  = db.transaction('raw_telemetry', 'readonly');
    const idx = tx.objectStore('raw_telemetry').index('timestamp');

    const range = IDBKeyRange.lowerBound(lower);

    return new Promise((resolve, reject) => {
      const results = [];
      const req = idx.openCursor(range, 'prev'); 

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results.reverse()); 
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('[DB] getRecentTelemetry failed:', err);
    return [];
  }
}

export async function getDailySummaries() {
  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      const res = await db.query(`SELECT * FROM daily_summary ORDER BY date DESC`);
      return res.values || [];
    } catch (err) {
      console.error('[DB] SQLite getDailySummaries failed:', err);
      return [];
    }
  }

  try {
    const db   = await getDB();
    const tx   = db.transaction('daily_summary', 'readonly');
    const store= tx.objectStore('daily_summary');

    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve((req.result ?? []).sort((a, b) => b.date.localeCompare(a.date)));
      req.onerror   = () => reject(req.error);
    });
  } catch (err) {
    console.error('[DB] getDailySummaries failed:', err);
    return [];
  }
}

export async function summarizeOldData() {
  const cutoffTs = Date.now() - DETAIL_DAYS * MS_PER_DAY;

  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      const oldRowsRes = await db.query(`SELECT * FROM raw_telemetry WHERE timestamp <= ?`, [cutoffTs]);
      const oldRows = oldRowsRes.values || [];
      
      if (oldRows.length === 0) return;

      const byDate = {};
      for (const row of oldRows) {
        const date = toISODate(row.timestamp);
        if (!byDate[date]) byDate[date] = [];
        byDate[date].push(row);
      }

      const summariesToUpsert = _calculateSummaries(byDate);

      const statements = summariesToUpsert.map(summary => ({
        statement: `INSERT OR REPLACE INTO daily_summary (date, avgSpeed, maxSpeed, avgRpm, maxRpm, avgTemp, maxTemp, avgFuel, minFuel, samples, drivingMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        values: [
          summary.date, summary.avgSpeed, summary.maxSpeed, summary.avgRpm, summary.maxRpm, 
          summary.avgTemp, summary.maxTemp, summary.avgFuel, summary.minFuel, summary.samples, summary.drivingMinutes
        ]
      }));

      await db.executeSet(statements);
      await db.run(`DELETE FROM raw_telemetry WHERE timestamp <= ?`, [cutoffTs]);
      
      console.log(`[DB] SQLite Summarised ${oldRows.length} rows into ${summariesToUpsert.length} daily records`);
    } catch (err) {
      console.error('[DB] SQLite summarizeOldData failed:', err);
    }
    return;
  }

  try {
    const db = await getDB();
    const oldRows = await _getRowsBefore(db, cutoffTs);
    if (oldRows.length === 0) return;

    const byDate = {};
    for (const row of oldRows) {
      const date = toISODate(row.timestamp);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(row);
    }

    const summariesToUpsert = _calculateSummaries(byDate);

    {
      const tx = db.transaction('daily_summary', 'readwrite');
      const store = tx.objectStore('daily_summary');
      for (const summary of summariesToUpsert) {
        store.put(summary);
      }
      await txPromise(tx);
    }

    await _deleteRowsBefore(db, cutoffTs);
    console.log(`[DB] Summarised ${oldRows.length} rows into ${summariesToUpsert.length} daily records`);

  } catch (err) {
    console.error('[DB] summarizeOldData failed:', err);
  }
}

export async function clearAllData() {
  if (Capacitor.isNativePlatform()) {
    try {
      const db = await getNativeDB();
      await db.execute(`DELETE FROM raw_telemetry; DELETE FROM daily_summary; DELETE FROM diagnostic_reports;`);
      console.log('[DB] All SQLite telemetry data cleared');
    } catch (err) {
      console.error('[DB] SQLite clearAllData failed:', err);
    }
    return;
  }
  
  try {
    const db = await getDB();
    const tx = db.transaction(['raw_telemetry', 'daily_summary', 'diagnostic_reports'], 'readwrite');
    tx.objectStore('raw_telemetry').clear();
    tx.objectStore('daily_summary').clear();
    tx.objectStore('diagnostic_reports').clear();
    await txPromise(tx);
    console.log('[DB] All telemetry data cleared');
  } catch (err) {
    console.error('[DB] clearAllData failed:', err);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _calculateSummaries(byDate) {
  const summaries = [];
  for (const [date, rows] of Object.entries(byDate)) {
    const speeds = rows.map(r => r.speed).filter(v => v != null && !isNaN(v));
    const rpms   = rows.map(r => r.rpm  ).filter(v => v != null && !isNaN(v));
    const temps  = rows.map(r => r.temp ).filter(v => v != null && !isNaN(v));
    const fuels  = rows.map(r => r.fuel ).filter(v => v != null && !isNaN(v));

    const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : null;
    const min = (arr) => arr.length ? Math.round(Math.min(...arr)) : null;

    const movingSamples = speeds.filter(s => s > 5).length;
    const drivingMinutes = Math.round((movingSamples * 5) / 60);

    summaries.push({
      date,
      avgSpeed: avg(speeds), maxSpeed: max(speeds),
      avgRpm: avg(rpms), maxRpm: max(rpms),
      avgTemp: avg(temps), maxTemp: max(temps),
      avgFuel: avg(fuels), minFuel: min(fuels),
      samples: rows.length, drivingMinutes,
    });
  }
  return summaries;
}

async function _getRowsBefore(db, beforeTs) {
  const tx    = db.transaction('raw_telemetry', 'readonly');
  const idx   = tx.objectStore('raw_telemetry').index('timestamp');
  const range = IDBKeyRange.upperBound(beforeTs, true); 

  return new Promise((resolve, reject) => {
    const results = [];
    const req = idx.openCursor(range);
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}

async function _deleteRowsBefore(db, beforeTs) {
  const rows  = await _getRowsBefore(db, beforeTs);
  if (rows.length === 0) return;

  const tx    = db.transaction('raw_telemetry', 'readwrite');
  const store = tx.objectStore('raw_telemetry');
  for (const row of rows) store.delete(row.id);
  await txPromise(tx);
}