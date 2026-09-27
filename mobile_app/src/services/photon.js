/**
 * services/photon.js — fast nearby-service search via Photon (Komoot).
 *
 * Overpass was the wrong tool for this screen. It is an arbitrary-query engine
 * with a shared job queue, and its latency is queue time, not query cost —
 * measured on the same mirror, back to back:
 *
 *     Overpass 5km / 7 tags / 200 results   2.8s   (and 504s, 429s, 97s worst case)
 *     Overpass 2km / 2 tags / 40 results   13.1s   (a SMALLER query, 4x slower)
 *     Photon   15km / 1 tag / 50 results    0.2-1.3s
 *
 * Photon is a search index (Elasticsearch over OSM), so it answers in the time a
 * search engine takes. It is free, needs no API key, and is run by Komoot as a
 * public service. What it does NOT return is arbitrary OSM tags — so phone
 * numbers come from a separate, cheap per-element lookup (see enrichFromOsm).
 *
 * Measured quirks that shape this code:
 *   - `limit` is capped at 50 per request by the server.
 *   - Several `osm_tag` parameters in one request AND together, not OR: asking
 *     for five kinds at once returned 2 results instead of hundreds. So each
 *     kind is its own request, fired in parallel.
 *   - `radius` (km) genuinely works, and matters: a rural point returned 0
 *     results with no radius, 28 with radius=50, 50 with radius=100. The old
 *     "nothing found in 15km" complaint is exactly this.
 */

export const PHOTON_ENDPOINT = 'https://photon.komoot.io/reverse';

/** Generous: measured worst case is ~1.3s, so this only catches a hang. */
export const PHOTON_TIMEOUT_MS = 8000;

/** Server-side cap. Asking for more is silently truncated to this. */
export const PHOTON_LIMIT = 50;

/**
 * One entry per request, because multiple osm_tag values AND together.
 * Labels match what the UI shows for the category.
 *
 * Split into two groups on purpose. Every request costs the free public instance
 * something, and firing all seven at once got this machine throttled during
 * development (every request then failing at the connection level for minutes).
 * The primary group is what someone looking for a garage actually needs and is
 * fetched up front; the rest arrive in a background pass and merge in.
 */
export const PHOTON_PRIMARY_TAGS = [
  { tag: 'shop:car_repair',        category: 'repair', label: 'СТО' },
  { tag: 'craft:car_repair',       category: 'repair', label: 'СТО' },
  { tag: 'shop:tyres',             category: 'tyres',  label: 'Шиномонтаж' },
  { tag: 'shop:car_parts',         category: 'parts',  label: 'Автозапчастини' },
];

export const PHOTON_SECONDARY_TAGS = [
  { tag: 'shop:car',               category: 'dealer', label: 'Автосалон' },
  { tag: 'amenity:car_wash',       category: 'wash',   label: 'Автомийка' },
  { tag: 'shop:motorcycle_repair', category: 'moto',   label: 'Мотосервіс' },
];

/** Everything, for category lookup and for the background pass. */
export const PHOTON_SERVICE_TAGS = [...PHOTON_PRIMARY_TAGS, ...PHOTON_SECONDARY_TAGS];

const OSM_TYPE = { N: 'node', W: 'way', R: 'relation' };

export function buildPhotonUrl(lat, lon, radiusM, tag, limit = PHOTON_LIMIT) {
  const radiusKm = Math.max(1, Math.round(radiusM / 1000));
  const p = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    radius: String(radiusKm),
    limit: String(Math.min(limit, PHOTON_LIMIT)),
    osm_tag: tag,
  });
  return `${PHOTON_ENDPOINT}?${p.toString()}`;
}

function labelFor(key, value) {
  const found = PHOTON_SERVICE_TAGS.find(t => t.tag === `${key}:${value}`);
  return found || { category: 'other', label: 'Автосервіс' };
}

/**
 * Photon GeoJSON → the shape the page renders.
 * Photon has no phone/opening_hours, so those start null and are filled in
 * later by enrichFromOsm().
 */
export function mapPhotonFeatures(json) {
  const out = [];
  for (const f of json?.features || []) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!isFinite(lat) || !isFinite(lon)) continue;

    const p = f.properties || {};
    const { category, label } = labelFor(p.osm_key, p.osm_value);
    const osmType = OSM_TYPE[p.osm_type] || 'node';

    out.push({
      id: `${osmType}/${p.osm_id}`,
      osmType,
      osmId: p.osm_id,
      name: p.name || label + ' без назви',
      lat,
      lon,
      category,
      categoryLabel: label,
      // Street/city are free here and make the sheet more useful.
      address: [p.street, p.housenumber].filter(Boolean).join(' ') || p.district || p.city || null,
      phone: null,
      website: null,
      opening: null,
      isPartner: false,
    });
  }
  return out;
}

/** Same place can appear under two tags; keep one. */
export function dedupeShops(lists) {
  const seen = new Set();
  const out = [];
  for (const shop of lists.flat()) {
    if (seen.has(shop.id)) continue;
    seen.add(shop.id);
    out.push(shop);
  }
  return out;
}

async function getJson(url, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search every service kind in parallel and merge.
 *
 * Uses allSettled rather than all: one kind failing (or that kind simply not
 * existing nearby) must not throw away the others. Only a total failure rejects.
 *
 * @returns {Promise<Array>} shops, de-duplicated, no distances yet
 */
export async function fetchPhotonShops([lat, lon], radiusM = 5000, opts = {}) {
  const { timeoutMs = PHOTON_TIMEOUT_MS, tags = PHOTON_PRIMARY_TAGS, fetchJson = getJson } = opts;

  const results = await Promise.allSettled(
    tags.map(t => fetchJson(buildPhotonUrl(lat, lon, radiusM, t.tag), timeoutMs)),
  );

  const ok = results.filter(r => r.status === 'fulfilled');
  if (ok.length === 0) {
    const why = results.map(r => r.reason?.message || 'failed').join(' | ');
    const err = new Error('Пошук сервісів недоступний. Спробуйте ще раз.');
    err.detail = why;
    throw err;
  }

  return dedupeShops(ok.map(r => mapPhotonFeatures(r.value)));
}

// ── Phone numbers ───────────────────────────────────────────────────────────
// Photon does not carry arbitrary tags, so phones come from the OSM API, which
// answers a single element in ~0.3s (versus ~4.3s for the equivalent Overpass
// by-id query). Done lazily: the list appears immediately and numbers fill in.

export const OSM_API = 'https://api.openstreetmap.org/api/0.6';

export function extractContact(tags = {}) {
  const phoneRaw = tags.phone || tags['contact:phone'] || tags['contact:mobile']
    || tags.mobile || tags['phone:mobile'] || null;
  const phone = phoneRaw ? String(phoneRaw).split(/[;,]/)[0].trim() || null : null;
  return {
    phone,
    website: tags.website || tags['contact:website'] || null,
    opening: tags.opening_hours || null,
  };
}

/** Tags for one OSM element, or null if it cannot be fetched. */
export async function fetchOsmTags(osmType, osmId, opts = {}) {
  const { timeoutMs = 6000, fetchJson = getJson } = opts;
  // `!osmId` would also reject a legitimate id of 0; test for absence instead.
  if (!osmType || osmId == null) return null;
  try {
    const json = await fetchJson(`${OSM_API}/${osmType}/${osmId}.json`, timeoutMs);
    return json?.elements?.[0]?.tags || {};
  } catch {
    return null;   // enrichment is best-effort; never break the list over it
  }
}

/**
 * Fill in phone/website/opening for the first `max` shops, in parallel.
 * Returns a NEW array; shops that could not be enriched are returned unchanged.
 */
export async function enrichFromOsm(shops, opts = {}) {
  const { max = 12, ...rest } = opts;
  const head = shops.slice(0, max);
  const tail = shops.slice(max);

  const enriched = await Promise.all(head.map(async (shop) => {
    if (shop.phone || shop.enrichTried) return shop;
    const tags = await fetchOsmTags(shop.osmType, shop.osmId, rest);
    if (!tags) return { ...shop, enrichTried: true };
    const contact = extractContact(tags);
    return {
      ...shop,
      // Marks this shop as already looked up, so reopening a cached area does
      // not re-query the OSM API for numbers we know are simply absent.
      enrichTried: true,
      phone: contact.phone ?? shop.phone,
      website: contact.website ?? shop.website,
      opening: contact.opening ?? shop.opening,
      name: shop.name.endsWith('без назви') && tags.name ? tags.name : shop.name,
    };
  }));

  return [...enriched, ...tail];
}
