/**
 * Finding car services must actually find them.
 *
 * Run: node src/services/__tests__/overpass.test.mjs   (from mobile_app/)
 *
 * The fixture is a REAL Overpass response for a 5km search around central Kyiv,
 * captured 2026-09-27 while diagnosing "it found my location but no services".
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildShopsQuery, mapOverpassElements, extractPhone, categoryOf,
  OVERPASS_ENDPOINTS, OVERPASS_WAVES, OVERPASS_TIMEOUT_MS, OVERPASS_TOTAL_BUDGET_MS,
  SERVICE_KINDS, MAX_RESULTS,
} from '../overpass.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'overpass_kyiv_2026-09-27.json'), 'utf-8'),
);

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ' — ' + detail : ''}`); }
};

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[1] The query asks for tags that exist\n');

const q = buildShopsQuery(50.4501, 30.5234, 5000);
check('does NOT ask for amenity=car_repair — not a real OSM tag, matched nothing',
  !q.includes('"amenity"="car_repair"'));
check('asks for shop=car_repair', q.includes('"shop"="car_repair"'));
check('asks for craft=car_repair too (workshops are tagged both ways)',
  q.includes('"craft"="car_repair"'));
check('covers tyres, parts, wash and dealers',
  ['"shop"="tyres"', '"shop"="car_parts"', '"amenity"="car_wash"', '"shop"="car"']
    .every(t => q.includes(t)));
check('uses nwr so a workshop mapped as a building (way) is found',
  q.includes('nwr[') && !/\bnode\[/.test(q));
check('carries the radius and the centre', q.includes('around:5000,50.4501,30.5234'));
check('asks for centre coordinates so ways have a position', q.includes('out center'));
check('raises the result cap above the old 40',
  q.includes(`out center ${MAX_RESULTS}`) && MAX_RESULTS >= 100);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] Mirrors — the actual cause of "nothing found"\n');

check('the fastest measured mirror (lz4) is tried first',
  OVERPASS_ENDPOINTS[0].includes('lz4.overpass-api.de'), OVERPASS_ENDPOINTS[0]);
check('more than one mirror is configured', OVERPASS_ENDPOINTS.length >= 3);
check('Switzerland-only overpass.osm.ch is never used (200 OK but zero results)',
  !OVERPASS_ENDPOINTS.some(e => e.includes('osm.ch')));
// The bug: an 8000ms abort against a mirror that answered in 8100ms.
check('timeout exceeds the slowest measured healthy response (8.1s)',
  OVERPASS_TIMEOUT_MS > 8100, `${OVERPASS_TIMEOUT_MS}ms`);
check('every endpoint is https and an /api/interpreter path',
  OVERPASS_ENDPOINTS.every(e => e.startsWith('https://') && e.endsWith('/api/interpreter')));

// A real outage run took 97 SECONDS before finally succeeding: waves x endpoints
// x timeout x retry, unbounded. Nobody watches a spinner that long.
check('the whole attempt is bounded, not waves x endpoints x retries',
  OVERPASS_TOTAL_BUDGET_MS > 0 && OVERPASS_TOTAL_BUDGET_MS <= 45000,
  `${OVERPASS_TOTAL_BUDGET_MS}ms`);
check('the budget still allows at least one full-length request to finish',
  OVERPASS_TOTAL_BUDGET_MS > OVERPASS_TIMEOUT_MS,
  `budget ${OVERPASS_TOTAL_BUDGET_MS} vs per-request ${OVERPASS_TIMEOUT_MS}`);
check('the budget is far below the 97s worst case that made this necessary',
  OVERPASS_TOTAL_BUDGET_MS < 97000);

// ─────────────────────────────────────────────────────────────────────────────
// Overpass allows only 4 concurrent slots per IP (its /api/status says so), and
// lz4/z/overpass-api.de are three frontends of ONE backend — firing all of them
// at once made the app rate-limit itself, measured as 429s from the very
// mirrors it was querying.
console.log('\n[2b] Mirrors are tried in small waves, not all at once\n');

const sameCluster = (u) => /overpass-api\.de/.test(u);

check('no wave fires more than two requests',
  OVERPASS_WAVES.every(w => w.length <= 2),
  OVERPASS_WAVES.map(w => w.length).join(','));
check('no wave asks the same backend cluster twice (that is what caused the 429s)',
  OVERPASS_WAVES.every(w => w.filter(sameCluster).length <= 1),
  JSON.stringify(OVERPASS_WAVES.map(w => w.filter(sameCluster).length)));
check('the first wave leads with the fastest measured mirror',
  OVERPASS_WAVES[0][0].includes('lz4'), OVERPASS_WAVES[0][0]);
check('the first two waves each pair the cluster with an independent operator',
  OVERPASS_WAVES[0].some(u => !sameCluster(u)) && OVERPASS_WAVES[1].some(u => !sameCluster(u)));
check('there is more than one wave, so one bad cluster is not fatal',
  OVERPASS_WAVES.length >= 2);
check('the flat endpoint list is exactly the waves, nothing lost or duplicated',
  OVERPASS_ENDPOINTS.length === OVERPASS_WAVES.flat().length
  && new Set(OVERPASS_ENDPOINTS).size === OVERPASS_ENDPOINTS.length);
check('peak concurrency stays under the 4-slot limit',
  Math.max(...OVERPASS_WAVES.map(w => w.length)) < 4);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] Real captured response maps to renderable shops\n');

const shops = mapOverpassElements(FIX);
check('finds services in the real response', shops.length > 0, `${shops.length}`);
check('every shop has usable coordinates',
  shops.every(s => typeof s.lat === 'number' && typeof s.lon === 'number'));
check('every shop has a name (falls back to a category label, never blank)',
  shops.every(s => typeof s.name === 'string' && s.name.trim().length > 0));
check('every shop has a stable id', shops.every(s => /^(node|way|relation)\/\d+$/.test(s.id)));
check('every shop is categorised', shops.every(s => s.category && s.categoryLabel));

const cats = [...new Set(shops.map(s => s.category))];
check('more than one kind of service comes back', cats.length > 1, cats.join(','));
check('repair shops are among the results', shops.some(s => s.category === 'repair'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] Phone numbers\n');

const withPhone = shops.filter(s => s.phone);
check('phone numbers are extracted from the real data',
  withPhone.length > 0, `${withPhone.length} of ${shops.length}`);
check('no extracted phone is empty or still a multi-number string',
  withPhone.every(s => s.phone.trim().length >= 5 && !s.phone.includes(';')),
  withPhone.filter(s => s.phone.includes(';')).map(s => s.phone).join(' | '));

check('reads plain phone=', extractPhone({ phone: '+380 44 111 2233' }) === '+380 44 111 2233');
check('reads contact:phone=', extractPhone({ 'contact:phone': '+380441112233' }) === '+380441112233');
check('reads contact:mobile=', extractPhone({ 'contact:mobile': '+380501112233' }) === '+380501112233');
check('reads mobile=', extractPhone({ mobile: '+380671112233' }) === '+380671112233');
check('takes only the FIRST number when OSM lists several (a tel: link needs one)',
  extractPhone({ phone: '+380441112233;+380441112234' }) === '+380441112233');
check('handles a comma-separated list too',
  extractPhone({ phone: '+380441112233, +380441112234' }) === '+380441112233');
check('prefers phone= over contact:mobile= when both exist',
  extractPhone({ phone: '+3801', 'contact:mobile': '+3802' }) === '+3801');
check('no phone tags yields null, not an empty string',
  extractPhone({ name: 'x' }) === null && extractPhone({}) === null);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] Categorisation and de-duplication\n');

check('shop=car_repair is labelled СТО', categoryOf({ shop: 'car_repair' }).label === 'СТО');
check('craft=car_repair is also СТО', categoryOf({ craft: 'car_repair' }).label === 'СТО');
check('amenity=car_wash is a car wash', categoryOf({ amenity: 'car_wash' }).category === 'wash');
check('an unknown tag still gets a generic label',
  categoryOf({ shop: 'bakery' }).category === 'other');

// The same place is often mapped twice — once as a node, once as the building.
const dup = {
  elements: [
    { type: 'node', id: 1, lat: 50.45, lon: 30.52, tags: { name: 'СТО Тест', shop: 'car_repair' } },
    { type: 'way', id: 2, center: { lat: 50.45, lon: 30.52 }, tags: { name: 'СТО Тест', shop: 'car_repair' } },
  ],
};
check('the same shop mapped as node + way appears once',
  mapOverpassElements(dup).length === 1);
check('a way with only a center still yields coordinates',
  mapOverpassElements({ elements: [dup.elements[1]] })[0].lat === 50.45);
check('elements without coordinates are dropped, not rendered at 0,0',
  mapOverpassElements({ elements: [{ type: 'way', id: 3, tags: { shop: 'car_repair' } }] }).length === 0);
check('an empty or malformed response yields an empty list, never a crash',
  mapOverpassElements({}).length === 0 && mapOverpassElements(null).length === 0
  && mapOverpassElements({ elements: null }).length === 0);
check('every configured kind has a label', SERVICE_KINDS.every(k => k.label && k.category));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
