/**
 * services/serverSync.js
 *
 * Background sync between local IndexedDB state and the CarSense server.
 * Called from TelemetryContext at the right moments:
 *   - After a perf run finishes → syncPerfRecord()
 *   - Once per day on app open  → syncDailySummary()
 *   - On app open               → restoreFromServer()
 *
 * All functions are fire-and-forget safe (they catch and log errors).
 */

import { api } from './api.js';
import { getDiagnosticReports, getRecentTelemetry } from './db.js';

// ── Sync a single perf record to server ──────────────────────────────────────

export async function syncPerfRecord({ filter_key, time_ms, distance_m, telemetry }) {
  if (!localStorage.getItem('obd_token')) return;
  try {
    await api.savePerfRecord({ filter_key, time_ms, distance_m, telemetry });
    console.log('[Sync] perf record uploaded:', filter_key, time_ms + 'ms');
  } catch (err) {
    console.warn('[Sync] perf upload failed (will retry next session):', err.message);
  }
}

// ── Build and sync today's daily summary ──────────────────────────────────────

export async function syncDailySummary() {
  if (!localStorage.getItem('obd_token')) return;

  const today      = new Date().toISOString().slice(0, 10);
  const lastSynced = localStorage.getItem('summary_last_synced');
  if (lastSynced === today) return; // already synced today

  try {
    // Pull 24h of telemetry from local DB
    const since  = Date.now() - 24 * 60 * 60 * 1000;
    const rows   = await getRecentTelemetry(5000, since);

    if (rows.length === 0) return;

    const speeds = rows.map(r => r.speed).filter(v => v != null);
    const rpms   = rows.map(r => r.rpm).filter(v => v != null);
    const temps  = rows.map(r => r.temp).filter(v => v != null);
    const fuels  = rows.map(r => r.fuel).filter(v => v != null);

    const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
    const max = arr => arr.length ? Math.max(...arr) : null;

    // Calculate approximate distance (km) from speed history
    let distKm = 0;
    for (let i = 1; i < rows.length; i++) {
      const dt = (rows[i].timestamp - rows[i-1].timestamp) / 3600000; // hours
      const spd = (rows[i].speed || 0);
      distKm += spd * dt;
    }

    // Pull error scan history for today
    const errorReports = await getDiagnosticReports('scanned_errors', 10);
    const todayReports = errorReports.filter(r => {
      const d = new Date(r.timestamp).toISOString().slice(0,10);
      return d === today;
    });

    // Count error frequency across today's scans
    const errorCount = {};
    for (const report of todayReports) {
      for (const err of (report.data || [])) {
        if (!errorCount[err.code]) errorCount[err.code] = { code: err.code, title: err.title, count: 0 };
        errorCount[err.code].count++;
      }
    }
    const errorCodes = Object.values(errorCount);
    const topErrors  = [...errorCodes].sort((a,b) => b.count - a.count).slice(0, 3);

    await api.saveSummary({
      date:        today,
      avg_speed:   avg(speeds),
      max_speed:   max(speeds),
      avg_rpm:     avg(rpms),
      avg_temp:    avg(temps),
      avg_fuel:    avg(fuels),
      error_codes: errorCodes,
      top_errors:  topErrors,
      distance_km: Math.round(distKm * 10) / 10,
    });

    localStorage.setItem('summary_last_synced', today);
    console.log('[Sync] daily summary uploaded for', today);

  } catch (err) {
    console.warn('[Sync] daily summary failed:', err.message);
  }
}

// ── Restore data from server after app reinstall ──────────────────────────────

export async function restoreFromServer() {
  if (!localStorage.getItem('obd_token')) return null;
  try {
    const [profile, summaries, perfRecords] = await Promise.all([
      api.getProfile(),
      api.getSummaries(),
      api.getMyPerfRecords(),
    ]);
    console.log('[Sync] restored from server:', {
      summaries: summaries.length,
      perfRecords: perfRecords.length,
    });
    return { profile, summaries, perfRecords };
  } catch (err) {
    console.warn('[Sync] restore failed:', err.message);
    return null;
  }
}
