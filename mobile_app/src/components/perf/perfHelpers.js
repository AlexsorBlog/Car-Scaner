/**
 * components/perf/perfHelpers.js — pure helpers shared between DashboardPage's
 * own perf-run detail modal and PublicProfilePage's leaderboard-entry detail,
 * so both render "exactly the same" info from the same math.
 */

export const formatPerfTime = (ms) => ms == null ? '--' : (ms / 1000).toFixed(2) + 's';

export const getMilestoneTime = (telemetryArray, filterKey) => {
  if (!telemetryArray || telemetryArray.length === 0) return null;
  const keyStr = String(filterKey);

  if (keyStr.includes('-')) {
    const parts = keyStr.split('-');
    const startSpeed = Number(parts[0]);
    const targetSpeed = Number(parts[1]);

    let startPt = telemetryArray[0];
    if (startSpeed > 0) {
      startPt = telemetryArray.find(d => d.speed >= startSpeed);
    }
    const endPt = telemetryArray.find(d => d.speed >= targetSpeed);

    if (!startPt || !endPt || startPt.t >= endPt.t) return null;
    return endPt.t - startPt.t;
  }

  if (keyStr === '1/4mi' || keyStr === '1/2mi') {
    const targetDistMeters = keyStr === '1/4mi' ? 402.336 : 804.672;
    let dist = 0;
    for (let i = 1; i < telemetryArray.length; i++) {
      const prev = telemetryArray[i - 1];
      const curr = telemetryArray[i];
      const dtHours = (curr.t - prev.t) / 3600000;
      const avgSpeed = (curr.speed + prev.speed) / 2;
      dist += (avgSpeed * dtHours) * 1000;
      if (dist >= targetDistMeters) {
        return curr.t - telemetryArray[0].t;
      }
    }
    return null;
  }

  return null;
};

export const getMilestoneDistance = (telemetryArray, filterKey) => {
  if (!telemetryArray || telemetryArray.length < 2) return 0;
  const keyStr = String(filterKey);

  if (keyStr === '1/4mi') return 402.336;
  if (keyStr === '1/2mi') return 804.672;

  if (keyStr.includes('-')) {
    const parts = keyStr.split('-');
    const startSpeed = Number(parts[0]);
    const targetSpeed = Number(parts[1]);
    let distMeters = 0;

    let tracking = startSpeed === 0;
    for (let i = 1; i < telemetryArray.length; i++) {
      const prev = telemetryArray[i - 1];
      const curr = telemetryArray[i];

      if (!tracking && curr.speed >= startSpeed) {
        tracking = true;
      }

      if (tracking) {
        const dtHours = (curr.t - prev.t) / 3600000;
        const avgSpeed = (curr.speed + prev.speed) / 2;
        distMeters += (avgSpeed * dtHours) * 1000;
      }

      if (curr.speed >= targetSpeed) break;
    }
    return distMeters;
  }

  return 0;
};
