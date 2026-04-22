/**
 * services/db.js — Local telemetry storage
 *
 * Schema (IndexedDB, DB version 2):
 *
 *   raw_telemetry   — one row per polling cycle (kept for last 7 days)
 *     { id, timestamp, speed, rpm, temp, fuel, [any other metric keys] }
 *
 *   daily_summary   — one row per calendar day (kept indefinitely)
 *     { date (PK, "YYYY-MM-DD"), avgSpeed, maxSpeed, avgRpm, maxRpm,
 *       avgTemp, maxTemp, avgFuel, minFuel, samples, drivingMinutes }
 *
 * Fixed vs original:
 *  - summarizeOldData was a no-op stub → now fully implemented
 *  - No DB version / migration handling → added with onupgradeneeded versioning
 *  - getRecentTelemetry was O(n) cursor scan → now uses IDBKeyRange for efficiency
 *  - Data older than 7 days was never deleted → pruneOldData() now handles it
 *
 * Note: On native Capacitor, replace initWebDB() with @capacitor-community/sqlite.
 * The public API (saveTelemetryData, getRecentTelemetry, getDailySummaries,
 * summarizeOldData) stays identical so the swap is transparent to callers.
 */

import { Capacitor } from '@capacitor/core';

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME    = 'OBD_Telemetry';
const DB_VERSION = 2;
const DETAIL_DAYS = 7;   // keep raw rows for this many days
const MS_PER_DAY  = 86_400_000;

// ── DB initialisation ─────────────────────────────────────────────────────────

let _dbPromise = null;

function getDB() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onerror = () => {
      _dbPromise = null; // allow retry
      reject(req.error);
    };

    req.onsuccess = () => resolve(req.result);

    req.onupgradeneeded = (e) => {
      const db      = e.target.result;
      const oldVer  = e.oldVersion;

      // ── v1 → raw_telemetry ─────────────────────────────────────────────
      if (oldVer < 1) {
        const store = db.createObjectStore('raw_telemetry', {
          keyPath:       'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }

      // ── v2 → daily_summary ─────────────────────────────────────────────
      if (oldVer < 2) {
        if (!db.objectStoreNames.contains('daily_summary')) {
          db.createObjectStore('daily_summary', { keyPath: 'date' });
        }
      }
    };
  });

  return _dbPromise;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toISODate(ts) {
  return new Date(ts).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(new Error('Transaction aborted'));
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Persist one telemetry snapshot.
 * @param {{ speed?, rpm?, temp?, fuel?, [key]: number }} dataPoint
 */
export async function saveTelemetryData(dataPoint) {
  if (Capacitor.isNativePlatform()) {
    // TODO: replace with @capacitor-community/sqlite
    console.debug('[DB] saveTelemetryData (native stub):', dataPoint);
    return;
  }

  try {
    const db = await getDB();
    const tx = db.transaction('raw_telemetry', 'readwrite');
    tx.objectStore('raw_telemetry').add({ ...dataPoint, timestamp: Date.now() });
    await txPromise(tx);
  } catch (err) {
    console.error('[DB] saveTelemetryData failed:', err);
  }
}

/**
 * Return the most recent `limit` raw telemetry rows, oldest-first.
 * Optionally constrain to rows newer than `sinceMs`.
 * @param {number} limit
 * @param {number} [sinceMs=0]
 * @returns {Promise<Array>}
 */
export async function getRecentTelemetry(limit = 1000, sinceMs = 0) {
  if (Capacitor.isNativePlatform()) {
    return []; // TODO: SQLite
  }

  try {
    const db  = await getDB();
    const tx  = db.transaction('raw_telemetry', 'readonly');
    const idx = tx.objectStore('raw_telemetry').index('timestamp');

    // Use a key range for efficiency — only scan rows we actually need
    const lower = sinceMs > 0 ? sinceMs : (Date.now() - DETAIL_DAYS * MS_PER_DAY);
    const range = IDBKeyRange.lowerBound(lower);

    return new Promise((resolve, reject) => {
      const results = [];
      const req = idx.openCursor(range, 'prev'); // newest first

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results.reverse()); // return oldest-first
        }
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.error('[DB] getRecentTelemetry failed:', err);
    return [];
  }
}

/**
 * Return all daily summary records, newest-first.
 * @returns {Promise<Array>}
 */
export async function getDailySummaries() {
  if (Capacitor.isNativePlatform()) {
    return []; // TODO: SQLite
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

/**
 * Summarise raw telemetry rows that are older than DETAIL_DAYS into daily_summary,
 * then delete those raw rows to keep storage bounded.
 *
 * Call this once on app startup (already done in useTelemetry).
 */
export async function summarizeOldData() {
  if (Capacitor.isNativePlatform()) {
    return; // TODO: SQLite
  }

  try {
    const db        = await getDB();
    const cutoffTs  = Date.now() - DETAIL_DAYS * MS_PER_DAY;

    // ── 1. Read all rows older than the cutoff ────────────────────────────
    const oldRows = await _getRowsBefore(db, cutoffTs);
    if (oldRows.length === 0) return;

    // ── 2. Group by calendar date ─────────────────────────────────────────
    const byDate = {};
    for (const row of oldRows) {
      const date = toISODate(row.timestamp);
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(row);
    }

    // ── 3. Compute summary stats for each date ────────────────────────────
    const summariesToUpsert = [];

    for (const [date, rows] of Object.entries(byDate)) {
      const speeds = rows.map(r => r.speed).filter(v => v != null && !isNaN(v));
      const rpms   = rows.map(r => r.rpm  ).filter(v => v != null && !isNaN(v));
      const temps  = rows.map(r => r.temp ).filter(v => v != null && !isNaN(v));
      const fuels  = rows.map(r => r.fuel ).filter(v => v != null && !isNaN(v));

      const avg = (arr) => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
      const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : null;
      const min = (arr) => arr.length ? Math.round(Math.min(...arr)) : null;

      // Estimate driving minutes: count samples where speed > 5 km/h
      // Assuming ~1 sample per 5 seconds on average
      const movingSamples = speeds.filter(s => s > 5).length;
      const drivingMinutes = Math.round((movingSamples * 5) / 60);

      summariesToUpsert.push({
        date,
        avgSpeed:       avg(speeds),
        maxSpeed:       max(speeds),
        avgRpm:         avg(rpms),
        maxRpm:         max(rpms),
        avgTemp:        avg(temps),
        maxTemp:        max(temps),
        avgFuel:        avg(fuels),
        minFuel:        min(fuels),
        samples:        rows.length,
        drivingMinutes,
      });
    }

    // ── 4. Write summaries (upsert) ───────────────────────────────────────
    {
      const tx = db.transaction('daily_summary', 'readwrite');
      const store = tx.objectStore('daily_summary');
      for (const summary of summariesToUpsert) {
        store.put(summary);
      }
      await txPromise(tx);
    }

    // ── 5. Delete the raw rows we just summarised ─────────────────────────
    await _deleteRowsBefore(db, cutoffTs);

    console.log(`[DB] Summarised ${oldRows.length} rows into ${summariesToUpsert.length} daily records`);

  } catch (err) {
    console.error('[DB] summarizeOldData failed:', err);
  }
}

/**
 * Delete ALL telemetry data (raw + summaries). Used for testing / account reset.
 */
export async function clearAllData() {
  if (Capacitor.isNativePlatform()) return;
  try {
    const db = await getDB();
    const tx = db.transaction(['raw_telemetry', 'daily_summary'], 'readwrite');
    tx.objectStore('raw_telemetry').clear();
    tx.objectStore('daily_summary').clear();
    await txPromise(tx);
    console.log('[DB] All telemetry data cleared');
  } catch (err) {
    console.error('[DB] clearAllData failed:', err);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _getRowsBefore(db, beforeTs) {
  const tx    = db.transaction('raw_telemetry', 'readonly');
  const idx   = tx.objectStore('raw_telemetry').index('timestamp');
  const range = IDBKeyRange.upperBound(beforeTs, true); // exclusive upper bound

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