/**
 * Service search must be fast AND actually find things.
 *
 * Run: node src/services/__tests__/photon.test.mjs   (from mobile_app/)
 *
 * The fixture holds REAL Photon responses for all seven service kinds around
 * central Kyiv, captured 2026-09-27 while replacing Overpass for this screen.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildPhotonUrl, mapPhotonFeatures, dedupeShops, fetchPhotonShops,
  extractContact, fetchOsmTags, enrichFromOsm,
  PHOTON_SERVICE_TAGS, PHOTON_PRIMARY_TAGS, PHOTON_SECONDARY_TAGS,
  PHOTON_LIMIT, PHOTON_TIMEOUT_MS,
} from '../photon.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'photon_kyiv_2026-09-27.json'), 'utf-8'),
);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The request\n');

const url = buildPhotonUrl(50.4501, 30.5234, 15000, 'shop:car_repair');
check('hits Photon reverse search', url.startsWith('https://photon.komoot.io/reverse?'));
check('carries the position', url.includes('lat=50.4501') && url.includes('lon=30.5234'));
// A rural point returned 0 results with no radius, 28 with radius=50 — this
// parameter is exactly the "nothing found in 15km" complaint.
check('sends radius in KILOMETRES (15000m -> 15)', url.includes('radius=15'), url);
check('a 1km radius does not round down to zero',
  buildPhotonUrl(50, 30, 900, 'shop:car_repair').includes('radius=1'));
check('asks for one tag per request — several osm_tag values AND together',
  (url.match(/osm_tag=/g) || []).length === 1);
check('never asks for more than the server cap of 50',
  buildPhotonUrl(50, 30, 5000, 'shop:car_repair', 500).includes(`limit=${PHOTON_LIMIT}`));
check('the tag is url-encoded', url.includes('osm_tag=shop%3Acar_repair'));
check('all seven service kinds exist', PHOTON_SERVICE_TAGS.length === 7);
check('repair shops are covered under both shop= and craft=',
  PHOTON_SERVICE_TAGS.filter(t => t.category === 'repair').length === 2);
// Each request costs a free public service something, and firing all seven at
// once got this machine throttled during development.
check('the first paint costs at most 4 requests, not 7',
  PHOTON_PRIMARY_TAGS.length <= 4, String(PHOTON_PRIMARY_TAGS.length));
check('what a driver needs (garages, tyres, parts) is in the primary group',
  ['repair', 'tyres', 'parts'].every(c => PHOTON_PRIMARY_TAGS.some(t => t.category === c)));
check('the optional categories are deferred to the background pass',
  ['dealer', 'wash', 'moto'].every(c => PHOTON_SECONDARY_TAGS.some(t => t.category === c)));
check('primary and secondary together cover everything, with no overlap',
  PHOTON_PRIMARY_TAGS.length + PHOTON_SECONDARY_TAGS.length === PHOTON_SERVICE_TAGS.length
  && new Set(PHOTON_SERVICE_TAGS.map(t => t.tag)).size === 7);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Real responses map to renderable shops\n');

const carRepair = mapPhotonFeatures(FIX['shop:car_repair']);
check('finds repair shops in the real response', carRepair.length > 0, `${carRepair.length}`);
check('every shop has finite coordinates',
  carRepair.every(s => Number.isFinite(s.lat) && Number.isFinite(s.lon)));
check('coordinates are read lat-from-[1], lon-from-[0] (GeoJSON order)',
  carRepair.every(s => s.lat > 40 && s.lat < 60 && s.lon > 20 && s.lon < 40),
  JSON.stringify(carRepair[0] && [carRepair[0].lat, carRepair[0].lon]));
check('every shop has a name', carRepair.every(s => s.name && s.name.trim().length > 0));
check('ids are type/id so they match OSM', carRepair.every(s => /^(node|way|relation)\/\d+$/.test(s.id)));
check('osm type letters are expanded (N -> node, W -> way)',
  carRepair.every(s => ['node', 'way', 'relation'].includes(s.osmType)));
check('repair shops are categorised as СТО',
  carRepair.every(s => s.category === 'repair' && s.categoryLabel === 'СТО'));
check('phone starts empty — Photon carries no tags, it is enriched later',
  carRepair.every(s => s.phone === null));

const washes = mapPhotonFeatures(FIX['amenity:car_wash']);
check('car washes are categorised separately',
  washes.length > 0 && washes.every(s => s.category === 'wash'));
const tyres = mapPhotonFeatures(FIX['shop:tyres']);
check('tyre shops are categorised separately',
  tyres.length > 0 && tyres.every(s => s.categoryLabel === 'Шиномонтаж'));

check('street/district is captured for the sheet when present',
  mapPhotonFeatures(FIX['shop:car_parts']).some(s => s.address));

check('a malformed response yields nothing rather than throwing',
  mapPhotonFeatures(null).length === 0
  && mapPhotonFeatures({}).length === 0
  && mapPhotonFeatures({ features: [{}] }).length === 0
  && mapPhotonFeatures({ features: [{ geometry: { coordinates: ['x', 'y'] }, properties: {} }] }).length === 0);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Merging all seven searches\n');

const all = dedupeShops(Object.values(FIX).map(mapPhotonFeatures));
check('merging every kind finds far more than one kind alone',
  all.length > carRepair.length, `${all.length} vs ${carRepair.length}`);
check('no duplicate ids survive the merge',
  new Set(all.map(s => s.id)).size === all.length);
check('several categories are represented',
  new Set(all.map(s => s.category)).size >= 4,
  [...new Set(all.map(s => s.category))].join(','));

const twice = dedupeShops([carRepair, carRepair]);
check('the same list merged twice is de-duplicated', twice.length === carRepair.length);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] One failing kind must not lose the others\n');

{
  // Six kinds answer, one rejects.
  let calls = 0;
  const fetchJson = async (u) => {
    calls++;
    if (u.includes('shop%3Atyres')) throw new Error('HTTP 502');
    const tag = decodeURIComponent(u.split('osm_tag=')[1]);
    return FIX[tag] || { features: [] };
  };
  const shops = await fetchPhotonShops([50.4501, 30.5234], 15000, { fetchJson });
  check('the primary kinds are requested in parallel', calls === PHOTON_PRIMARY_TAGS.length,
    String(calls));
  check('results still come back when one kind fails', shops.length > 0, `${shops.length}`);
  check('the failed kind contributes nothing but breaks nothing',
    !shops.some(s => s.category === 'tyres'));
}

{
  const fetchJson = async () => { throw new Error('offline'); };
  let threw = false, detail = '';
  try { await fetchPhotonShops([50, 30], 5000, { fetchJson }); }
  catch (e) { threw = true; detail = e.detail || ''; }
  check('only a TOTAL failure rejects', threw);
  check('and it carries the reasons for the log', detail.includes('offline'), detail);
}

check('the timeout is generous versus the ~1.3s measured worst case',
  PHOTON_TIMEOUT_MS >= 5000 && PHOTON_TIMEOUT_MS <= 15000, `${PHOTON_TIMEOUT_MS}ms`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Phone numbers, fetched from OSM per element\n');

check('reads phone=', extractContact({ phone: '+380 44 111 2233' }).phone === '+380 44 111 2233');
check('reads contact:phone=', extractContact({ 'contact:phone': '+380441112233' }).phone === '+380441112233');
check('reads contact:mobile= and mobile=',
  extractContact({ 'contact:mobile': '+3801' }).phone === '+3801'
  && extractContact({ mobile: '+3802' }).phone === '+3802');
check('takes the first of several numbers',
  extractContact({ phone: '+3801;+3802' }).phone === '+3801');
check('picks up website and opening hours too',
  extractContact({ website: 'https://x.ua', opening_hours: 'Mo-Fr 09:00-18:00' }).website === 'https://x.ua');
check('no contact tags yields nulls, not empty strings',
  extractContact({}).phone === null && extractContact({}).website === null);

{
  const fetchJson = async (u) => {
    if (u.includes('/node/1.json')) return { elements: [{ tags: { phone: '+380441112233', name: 'СТО Один' } }] };
    if (u.includes('/way/2.json')) return { elements: [{ tags: { opening_hours: '24/7' } }] };
    throw new Error('HTTP 404');
  };
  check('tags come back for a node', (await fetchOsmTags('node', 1, { fetchJson })).phone === '+380441112233');
  check('a failed lookup returns null rather than throwing',
    (await fetchOsmTags('node', 999, { fetchJson })) === null);
  check('missing identifiers are handled', (await fetchOsmTags(null, null, { fetchJson })) === null);

  const base = [
    { id: 'node/1', osmType: 'node', osmId: 1, name: 'СТО без назви', phone: null, website: null, opening: null },
    { id: 'way/2', osmType: 'way', osmId: 2, name: 'Мийка', phone: null, website: null, opening: null },
    { id: 'node/999', osmType: 'node', osmId: 999, name: 'Третій', phone: null, website: null, opening: null },
  ];
  const out = await enrichFromOsm(base, { fetchJson });
  check('phones are filled in from OSM', out[0].phone === '+380441112233');
  check('a placeholder name is replaced by the real one when OSM has it',
    out[0].name === 'СТО Один', out[0].name);
  check('opening hours are filled in', out[1].opening === '24/7');
  check('a shop whose lookup fails is returned unchanged',
    out[2].phone === null && out[2].name === 'Третій');
  check('enrichment never drops shops', out.length === base.length);

  const many = Array.from({ length: 30 }, (_, i) => ({
    id: `node/${i}`, osmType: 'node', osmId: i, name: 'x', phone: null, website: null, opening: null,
  }));
  let lookups = 0;
  const counting = async () => { lookups++; return { elements: [{ tags: {} }] }; };
  const capped = await enrichFromOsm(many, { fetchJson: counting, max: 12 });
  check('only the visible head is enriched, so we do not hammer the OSM API',
    lookups === 12, String(lookups));
  check('the rest are still returned', capped.length === 30);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
