/**
 * services/overpass.js — finding car services near a point, via OpenStreetMap.
 *
 * Split out of ServicesPage so the query and the response mapping can be tested
 * against a real captured Overpass response (see __tests__/fixtures/).
 *
 * Two measured problems this fixes, both of which showed as "no services found"
 * on a phone with working GPS (2026-09-27, Kyiv):
 *
 *  1. The mirror list was mostly dead. Measured from a real network:
 *       lz4.overpass-api.de   200 in 2.7s
 *       z.overpass-api.de     200 in 3.2s
 *       overpass-api.de       200 in 8.1s  (and 504 intermittently)
 *       kumi.systems          no response in 25s
 *       private.coffee        no response in 25s
 *     Two of the three endpoints in use were the dead ones, and the abort
 *     timeout was 8000ms — shorter than the working endpoint's own 8.1s
 *     response, so it was being cancelled just as it was about to answer.
 *
 *  2. The query asked only for shop=car_repair plus amenity=car_repair, and
 *     amenity=car_repair is not a real OSM tag at all. Broadening to the tags
 *     people actually use took the same 5km Kyyiv search from 40 results
 *     (26 named, 7 with a phone) to 200 (139 named, 56 with a phone).
 */

/**
 * Tried in waves of at most two, NOT all at once.
 *
 * Overpass allows only 4 concurrent slots per IP (its /api/status reports
 * "Rate limit: 4"), and lz4/z/overpass-api.de are three frontends of the SAME
 * backend cluster. Racing all five therefore made the app rate-limit itself —
 * measured HTTP 429 from the very mirrors it was asking. Each wave pairs one
 * frontend of that cluster with an independent operator, so a wave costs the
 * cluster a single slot while still having a real alternative racing it.
 */
export const OVERPASS_WAVES = [
  ['https://lz4.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'],
  ['https://z.overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'],
  ['https://overpass-api.de/api/interpreter'],
];

/** Flat list, fastest-first — the order waves are drawn from. */
export const OVERPASS_ENDPOINTS = OVERPASS_WAVES.flat();

/**
 * NOTE for whoever touches the request code: overpass-api.de returns an instant
 * HTTP 406 from Apache when the request carries no User-Agent — measured, the
 * same query succeeds with one and fails without. A WebView always sends a real
 * browser UA and fetch() forbids setting that header anyway, so the app is fine;
 * command-line reproductions must pass one (curl -A ...) or they will look
 * broken for the wrong reason.
 */

// Must exceed the slowest healthy mirror's real response time (measured 8.1s),
// or we abort requests that were about to succeed.
export const OVERPASS_TIMEOUT_MS = 20000;

/**
 * Hard ceiling on the WHOLE attempt, across every wave and the retry.
 *
 * Without it the worst case is waves x endpoints x timeout x retries: a real
 * run during a mirror outage took 97 SECONDS before succeeding. It did return
 * data, but nobody watches a spinner that long — and the cache/prefetch exist
 * precisely so this path is rare. Past the budget we stop and report, rather
 * than holding the page hostage to an overloaded upstream.
 */
export const OVERPASS_TOTAL_BUDGET_MS = 35000;

export const MAX_RESULTS = 200;

/**
 * The OSM tags that actually carry car services, with the label shown in the UI.
 * `amenity=car_repair` is deliberately absent — it is not a real tag; it was in
 * the old query and matched nothing.
 */
export const SERVICE_KINDS = [
  { selector: '["shop"="car_repair"]',         category: 'repair',  label: 'СТО' },
  { selector: '["craft"="car_repair"]',        category: 'repair',  label: 'СТО' },
  { selector: '["shop"="tyres"]',              category: 'tyres',   label: 'Шиномонтаж' },
  { selector: '["shop"="car_parts"]',          category: 'parts',   label: 'Автозапчастини' },
  { selector: '["shop"="car"]',                category: 'dealer',  label: 'Автосалон' },
  { selector: '["amenity"="car_wash"]',        category: 'wash',    label: 'Автомийка' },
  { selector: '["shop"="motorcycle_repair"]',  category: 'moto',    label: 'Мотосервіс' },
];

/** Overpass QL for every service kind around a point. `nwr` covers nodes, ways
 *  and relations in one clause — a workshop mapped as a building is a way, and
 *  the old query only asked for ways on one of its three tag matches. */
export function buildShopsQuery(lat, lon, radiusM = 5000, limit = MAX_RESULTS) {
  const clauses = SERVICE_KINDS
    .map(k => `  nwr${k.selector}(around:${radiusM},${lat},${lon});`)
    .join('\n');
  return `[out:json][timeout:25];\n(\n${clauses}\n);\nout center ${limit};`;
}

/** First usable phone number from the tags people actually use. OSM allows
 *  several numbers in one value separated by ';' — a tel: link needs just one. */
export function extractPhone(tags = {}) {
  const raw = tags.phone || tags['contact:phone'] || tags['contact:mobile']
    || tags.mobile || tags['phone:mobile'] || null;
  if (!raw) return null;
  const first = String(raw).split(/[;,]/)[0].trim();
  return first || null;
}

export function categoryOf(tags = {}) {
  for (const k of SERVICE_KINDS) {
    const m = k.selector.match(/\["([^"]+)"="([^"]+)"\]/);
    if (m && tags[m[1]] === m[2]) return { category: k.category, label: k.label };
  }
  return { category: 'other', label: 'Автосервіс' };
}

/**
 * Overpass JSON → the shape the page renders. Drops anything without usable
 * coordinates, and de-duplicates the same place mapped as both a node and a way.
 */
export function mapOverpassElements(json) {
  const seen = new Set();
  const out = [];

  for (const el of json?.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const tags = el.tags || {};
    const { category, label } = categoryOf(tags);
    const name = tags.name || tags['name:uk'] || tags.operator || label + ' без назви';

    // Same shop tagged twice (node + building way) lands on ~the same spot.
    const key = `${name}@${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: `${el.type}/${el.id}`,
      name,
      lat,
      lon,
      category,
      categoryLabel: label,
      phone: extractPhone(tags),
      website: tags.website || tags['contact:website'] || null,
      opening: tags.opening_hours || null,
      isPartner: false,
    });
  }
  return out;
}

// ── The request itself ──────────────────────────────────────────────────────
export async function fetchNearbyShops(
  [lat, lon], radiusM = 5000, attempt = 1, deadline = Date.now() + OVERPASS_TOTAL_BUDGET_MS,
) {
  const query = buildShopsQuery(lat, lon, radiusM);
  const failures = [];
  const timeLeft = () => deadline - Date.now();

  // Race all mirrors at once instead of trying them one after another. Trying
  // them in sequence meant a worst case of endpoints × timeout (~36s+), which
  // reads as "infinite loading" to the user when the primary is hung. Racing
  // makes the wait equal to the FASTEST healthy mirror — normally well under a
  // second — and caps the failure case at a single timeout.
  const attemptOne = async (endpoint) => {
    // fetch() has no built-in timeout and will otherwise wait indefinitely.
    const abort = new AbortController();
    // Never wait past the overall budget, even if this mirror is allowed longer.
    const budget = Math.max(1000, Math.min(OVERPASS_TIMEOUT_MS, timeLeft()));
    const timer = setTimeout(() => abort.abort(), budget);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        // Without this, fetch() defaults the body to text/plain, and Overpass's
        // server rejects that outright with 406 Not Acceptable — confirmed by
        // reproducing the exact request outside the app; it fails identically
        // regardless of radius since the request never reaches the query engine.
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: abort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return mapOverpassElements(await res.json());
    } catch (err) {
      const reason = err.name === 'AbortError' ? `timeout >${OVERPASS_TIMEOUT_MS / 1000}s` : err.message;
      console.warn(`[Services] ${endpoint} failed: ${reason}`);
      failures.push(`${new URL(endpoint).hostname}: ${reason}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    // Waves of at most two rather than all mirrors at once: Overpass allows 4
    // concurrent slots per IP and three of these URLs share one backend, so
    // racing everything made the app rate-limit itself (measured 429s).
    // Promise.any within a wave resolves on the first SUCCESS.
    let lastErr;
    for (const wave of OVERPASS_WAVES) {
      if (timeLeft() <= 1000) break;   // out of budget — do not start another wave
      try {
        return await Promise.any(wave.map(attemptOne));
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('no Overpass endpoints configured');
  } catch {
    // Every mirror failed. One short retry covers a transient overload spike,
    // then give up rather than leaving the user on a spinner.
    if (attempt < 2 && timeLeft() > 5000) {
      await new Promise(r => setTimeout(r, 1200));
      return fetchNearbyShops([lat, lon], radiusM, attempt + 1, deadline);
    }
    const err = new Error('Сервіс карт недоступний. Спробуйте ще раз за хвилину.');
    err.detail = failures.join(' | ');
    throw err;
  }
}
