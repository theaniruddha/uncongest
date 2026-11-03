// One-off builder for the offline route fixture. Re-run only when changing the corridor:
//   node scripts/build-route-fixture.mjs
// Sources: OSRM public demo server (road geometry, © OpenStreetMap contributors) and
// Overpass API (motorway_junction nodes on Hwy 401 / A-20). The app never calls these at runtime.
import { writeFileSync } from "node:fs";

const ORIGIN = [-79.3832, 43.6532]; // Toronto (Nathan Phillips Sq.)
const DEST = [-73.5673, 45.5017]; // Montréal (centre-ville)
const UA = { "User-Agent": "uncongest-dev/0.1 (route fixture builder)" };

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371.0088;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${ORIGIN.join(",")};${DEST.join(",")}?overview=full&geometries=geojson`;
const osrm = await (await fetch(osrmUrl, { headers: UA })).json();
const route = osrm.routes[0];
const coords = route.geometry.coordinates.map(([lng, lat]) => [+lng.toFixed(5), +lat.toFixed(5)]);
const cumKm = [0];
for (let i = 1; i < coords.length; i++) cumKm.push(cumKm[i - 1] + haversineKm(coords[i - 1], coords[i]));

const query = `[out:json][timeout:60];(way["highway"="motorway"]["ref"~"^(401|20|A-20)$"](43.5,-79.6,45.6,-73.5););node(w)["highway"="motorway_junction"];out body;`;
const overpass = await (
  await fetch("https://overpass-api.de/api/interpreter", { method: "POST", headers: UA, body: new URLSearchParams({ data: query }) })
).json();

// Project each junction onto the route; keep only those on the travelled (eastbound) carriageway.
function project(p) {
  let best = { d: Infinity, km: 0 };
  const kx = Math.cos(toRad(p[1])) * 111.32;
  const ky = 110.57;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky, px = p[0] * kx, py = p[1] * ky;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
    const dx = ax + t * vx - px, dy = ay + t * vy - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best.d) best = { d, km: cumKm[i - 1] + t * (cumKm[i] - cumKm[i - 1]) };
  }
  return best;
}

const raw = overpass.elements
  .map((n) => ({ n, p: project([n.lon, n.lat]) }))
  .filter(({ p }) => p.d < 0.025) // within 25 m of the eastbound route line
  .sort((a, b) => a.p.km - b.p.km);

const exits = [];
for (const { n, p } of raw) {
  const ref = n.tags.ref ?? null;
  const prev = exits[exits.length - 1];
  // collapse A/B ramps of the same interchange (same ref, or unnamed within 1.5 km)
  if (prev && ((ref && prev.ref && ref.replace(/[A-Z]$/i, "") === prev.ref.replace(/[A-Z]$/i, "")) || p.km - prev.km < 1.5)) continue;
  exits.push({
    id: `osm-${n.id}`,
    ref,
    name: n.tags.name ?? null,
    exitTo: n.tags.exit_to ?? n.tags.destination ?? null,
    lat: n.lat,
    lng: n.lon,
    km: +p.km.toFixed(2)
  });
}

const out = {
  id: "toronto-montreal-401",
  source: "OSRM demo server (road geometry) + Overpass API motorway_junction nodes, fetched once and cached",
  attribution: "© OpenStreetMap contributors (ODbL)",
  fetchedAt: new Date().toISOString(),
  origin: "Toronto, ON",
  destination: "Montréal, QC",
  distanceKm: +cumKm[cumKm.length - 1].toFixed(2),
  osrmDurationMinutes: +(route.duration / 60).toFixed(1),
  coordinates: coords,
  exits
};
writeFileSync(new URL("../data/routes/toronto-montreal.json", import.meta.url), JSON.stringify(out));
console.log(`route ${out.distanceKm} km, ${coords.length} pts, ${exits.length} eastbound exits`);
