import routeFixture from "@/data/routes/toronto-montreal.json";
import { createRouteModel, cumulativeKm, haversineKm, projectOnto, type RouteExit, type RouteModel } from "@/lib/route/model";
import { tripRouteSchema, type PlaceRef, type TripRoute } from "@/lib/trip/types";
import { getBudget } from "./budget";
import { overpassQuery, type OverpassElement } from "./overpass";

/**
 * Real route resolution for the configurable trip simulator. Server-only.
 * Order: offline fixture (Toronto → Montréal) → 24 h memory cache → OSRM demo server.
 * Exits come from OSM motorway_junction nodes (Overpass, corridor bboxes) with an OSRM
 * off-ramp maneuver fallback. Geometry is never fabricated: no route → RouteUnavailableError.
 */
const OSRM_BASE = process.env.OSRM_URL || "https://router.project-osrm.org";
const UA = "uncongest-sim/0.2 (road-trip simulator)";
const TTL_MS = 24 * 60 * 60 * 1000;
const OSRM_TIMEOUT_MS = 20000;
const MAX_POINTS = 4000;
const SIMPLIFY_TOLERANCE_KM = 0.03;
const EXIT_MAX_OFFSET_KM = 0.03;
const MAX_CORRIDOR_BOXES = 6;
const CORRIDOR_PAD_KM = 1;
const FIXTURE_RADIUS_KM = 3;
const FIXTURE_ORIGIN: [number, number] = [-79.3832, 43.6532];
const FIXTURE_DEST: [number, number] = [-73.5673, 45.5017];
const DEFAULT_TZ = "America/Toronto";
const OSM_ATTRIBUTION = "© OpenStreetMap contributors (ODbL)";

/** No drivable route exists between the endpoints (or the router said so). Maps to HTTP 404. */
export class RouteUnavailableError extends Error {}
/** Router could not be reached / budget refused. Maps to HTTP 503. */
export class RoutingServiceUnavailableError extends Error {}

type LngLat = [number, number];
type FetchImpl = typeof fetch;

// ---------- geometry ----------

const toRad = (d: number) => (d * Math.PI) / 180;

/** Perpendicular distance (km) from p to segment a–b, local equirectangular projection. */
function segDistKm(p: LngLat, a: LngLat, b: LngLat): number {
  const kx = Math.cos(toRad(p[1])) * 111.32;
  const ky = 110.57;
  const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky, px = p[0] * kx, py = p[1] * ky;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
  const dx = ax + t * vx - px, dy = ay + t * vy - py;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Iterative Douglas–Peucker. Always keeps the first and last point. */
export function douglasPeucker(coords: LngLat[], toleranceKm: number): LngLat[] {
  const n = coords.length;
  if (n <= 2) return coords.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDistKm(coords[i], coords[s], coords[e]);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx !== -1 && maxD > toleranceKm) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return coords.filter((_, i) => keep[i] === 1);
}

/** Simplify to ≤ maxPoints (tolerance grows if needed), rounded to 5 decimals, endpoints kept. */
export function simplifyRoute(coords: LngLat[], toleranceKm = SIMPLIFY_TOLERANCE_KM, maxPoints = MAX_POINTS): LngLat[] {
  const rounded: LngLat[] = [];
  for (const [lng, lat] of coords) {
    const p: LngLat = [+lng.toFixed(5), +lat.toFixed(5)];
    const prev = rounded[rounded.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) rounded.push(p);
  }
  if (rounded.length < 2) return rounded;
  let tol = toleranceKm;
  let out = douglasPeucker(rounded, tol);
  while (out.length > maxPoints) {
    tol *= 1.5;
    out = douglasPeucker(rounded, tol);
  }
  return out;
}

// ---------- exits ----------

interface RawExit {
  id: string;
  ref: string | null;
  name: string | null;
  exitTo: string | null;
  lat: number;
  lng: number;
  km: number;
}

/** Collapse A/B ramps of the same interchange (same base ref, or anything within 1.5 km). */
export function dedupeExits(raw: RawExit[]): RouteExit[] {
  const sorted = [...raw].sort((a, b) => a.km - b.km);
  const base = (r: string) => r.trim().replace(/[A-Z]$/i, "").trim();
  const out: RouteExit[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev && ((e.ref && prev.ref && base(e.ref) === base(prev.ref)) || e.km - prev.km < 1.5)) continue;
    out.push({ ...e, km: +e.km.toFixed(2) });
  }
  return out;
}

/** Split the polyline into ≤ maxBoxes chunks and return padded bboxes (s, w, n, e). */
export function corridorBoxes(coords: LngLat[], maxBoxes = MAX_CORRIDOR_BOXES, padKm = CORRIDOR_PAD_KM): Array<[number, number, number, number]> {
  const boxes: Array<[number, number, number, number]> = [];
  const chunk = Math.ceil(coords.length / maxBoxes);
  for (let i = 0; i < coords.length - 1; i += chunk) {
    const part = coords.slice(i, Math.min(i + chunk + 1, coords.length));
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (const [lng, lat] of part) {
      s = Math.min(s, lat);
      n = Math.max(n, lat);
      w = Math.min(w, lng);
      e = Math.max(e, lng);
    }
    const padLat = padKm / 110.57;
    const padLng = padKm / (111.32 * Math.cos(toRad((s + n) / 2)));
    boxes.push([+(s - padLat).toFixed(4), +(w - padLng).toFixed(4), +(n + padLat).toFixed(4), +(e + padLng).toFixed(4)]);
  }
  return boxes;
}

/**
 * Exits are projected against the FULL (unsimplified) geometry so the 30 m cutoff is exact even on
 * sharp curves; km is then rescaled onto the simplified line (targetTotalKm / fullTotalKm).
 */
function kmScaler(cum: number[], targetTotalKm?: number): (km: number) => number {
  const full = cum[cum.length - 1];
  const f = targetTotalKm !== undefined && full > 0 ? targetTotalKm / full : 1;
  return (km) => km * f;
}

export function exitsFromJunctions(coords: LngLat[], elements: OverpassElement[], targetTotalKm?: number): RouteExit[] {
  const cum = cumulativeKm(coords);
  const scale = kmScaler(cum, targetTotalKm);
  const raw: RawExit[] = [];
  for (const el of elements) {
    if (el.type !== "node" || el.lat === undefined || el.lon === undefined) continue;
    const p = projectOnto(coords, cum, el.lat, el.lon);
    if (p.offRouteKm > EXIT_MAX_OFFSET_KM) continue;
    const tags = el.tags ?? {};
    raw.push({
      id: `osm-${el.id}`,
      ref: tags.ref ?? null,
      name: tags.name ?? null,
      exitTo: tags.exit_to ?? tags.destination ?? null,
      lat: el.lat,
      lng: el.lon,
      km: scale(p.km)
    });
  }
  return dedupeExits(raw);
}

interface OsrmStep {
  name?: string;
  ref?: string;
  exits?: string;
  destinations?: string;
  maneuver?: { type?: string; modifier?: string; location?: [number, number] };
}
interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { type: string; coordinates: LngLat[] };
  legs?: Array<{ steps?: OsrmStep[] }>;
}

export function exitsFromOsrmSteps(coords: LngLat[], route: OsrmRoute, targetTotalKm?: number): RouteExit[] {
  const cum = cumulativeKm(coords);
  const scale = kmScaler(cum, targetTotalKm);
  const raw: RawExit[] = [];
  let i = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      i++;
      const type = step.maneuver?.type;
      const loc = step.maneuver?.location;
      if (!loc) continue;
      const isExit = type === "off ramp" || (type === "fork" && Boolean(step.exits));
      if (!isExit) continue;
      const p = projectOnto(coords, cum, loc[1], loc[0]);
      if (p.offRouteKm > 0.2) continue;
      const ref = step.exits ? step.exits.split(";")[0].trim() || null : null;
      raw.push({
        id: `osrm-step-${i}`,
        ref,
        name: step.name || step.destinations || null,
        exitTo: step.destinations || null,
        lat: loc[1],
        lng: loc[0],
        km: scale(p.km)
      });
    }
  }
  return dedupeExits(raw);
}

// ---------- helpers ----------

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const endpointKey = (o: PlaceRef, d: PlaceRef) => `${o.lat.toFixed(3)},${o.lng.toFixed(3)}|${d.lat.toFixed(3)},${d.lng.toFixed(3)}`;

async function fetchJson(url: string, timeoutMs: number, fetchImpl?: FetchImpl): Promise<{ status: number; ok: boolean; json: unknown }> {
  const f = fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(t);
  }
}

async function lookupTimezone(p: PlaceRef, sessionId?: string, fetchImpl?: FetchImpl): Promise<string> {
  const budget = getBudget("open-meteo");
  if (budget.take(sessionId)) return DEFAULT_TZ;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${p.lat.toFixed(4)}&longitude=${p.lng.toFixed(4)}&timezone=auto&forecast_days=1&current=temperature_2m`;
    const { ok, json } = await fetchJson(url, 8000, fetchImpl);
    const tz = ok && json && typeof (json as { timezone?: unknown }).timezone === "string" ? (json as { timezone: string }).timezone : null;
    return tz && tz !== "GMT" && tz.includes("/") ? tz : DEFAULT_TZ;
  } catch (err) {
    budget.error((err as Error).message);
    return DEFAULT_TZ;
  }
}

// ---------- route store (LRU) ----------

const STORE_MAX = 50;
const store = new Map<string, TripRoute>();

export function storeRoute(route: TripRoute): void {
  store.delete(route.id);
  store.set(route.id, route);
  while (store.size > STORE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function getStoredRoute(id: string): TripRoute | undefined {
  const r = store.get(id);
  if (r) {
    store.delete(id);
    store.set(id, r);
  }
  return r;
}

export function routeModelFor(route: TripRoute): RouteModel {
  return createRouteModel({
    id: route.id,
    source: route.source,
    attribution: route.attribution,
    origin: route.origin.label,
    destination: route.destination.label,
    coordinates: route.coordinates,
    exits: route.exits,
    durationMinutes: route.durationMinutes
  });
}

// ---------- resolve ----------

const routeCache = new Map<string, { at: number; route: TripRoute }>();

function fixtureRoute(origin: PlaceRef, destination: PlaceRef): TripRoute {
  const coords = routeFixture.coordinates as LngLat[];
  const cum = cumulativeKm(coords);
  return tripRouteSchema.parse({
    id: routeFixture.id,
    origin,
    destination,
    coordinates: coords,
    exits: routeFixture.exits,
    distanceKm: +cum[cum.length - 1].toFixed(2),
    durationMinutes: routeFixture.osrmDurationMinutes,
    source: "fixture",
    timezone: DEFAULT_TZ,
    fetchedAt: routeFixture.fetchedAt,
    attribution: `${OSM_ATTRIBUTION}. Geometry: OSRM; exits: Overpass motorway_junction (cached fixture).`
  });
}

export async function resolveRoute(
  origin: PlaceRef,
  destination: PlaceRef,
  opts: { sessionId?: string; fetchImpl?: FetchImpl } = {}
): Promise<TripRoute> {
  // a. offline fixture
  if (
    haversineKm([origin.lng, origin.lat], FIXTURE_ORIGIN) <= FIXTURE_RADIUS_KM &&
    haversineKm([destination.lng, destination.lat], FIXTURE_DEST) <= FIXTURE_RADIUS_KM
  ) {
    const r = fixtureRoute(origin, destination);
    storeRoute(r);
    return r;
  }

  // b. memory cache
  const key = endpointKey(origin, destination);
  const osrmBudget = getBudget("osrm");
  const hit = routeCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    osrmBudget.hit();
    const r: TripRoute = { ...hit.route, origin, destination, source: "cache" };
    storeRoute(r);
    return r;
  }

  // c. OSRM
  const refused = osrmBudget.take(opts.sessionId);
  if (refused) throw new RoutingServiceUnavailableError(refused);
  const url = `${OSRM_BASE}/route/v1/driving/${origin.lng.toFixed(5)},${origin.lat.toFixed(5)};${destination.lng.toFixed(5)},${destination.lat.toFixed(5)}?overview=full&geometries=geojson&steps=true`;
  let resp: { status: number; ok: boolean; json: unknown };
  try {
    resp = await fetchJson(url, OSRM_TIMEOUT_MS, opts.fetchImpl);
  } catch (err) {
    const msg = (err as Error).name === "AbortError" ? "timeout after 20 s" : (err as Error).message;
    osrmBudget.error(msg);
    throw new RoutingServiceUnavailableError(`Routing service (OSRM) unavailable: ${msg}`);
  }
  const body = resp.json as { code?: string; message?: string; routes?: OsrmRoute[] } | null;
  if (!body || typeof body.code !== "string") {
    osrmBudget.error(`http ${resp.status}`);
    throw new RoutingServiceUnavailableError(`Routing service (OSRM) returned an unexpected response (HTTP ${resp.status})`);
  }
  const osrmRoute = body.routes?.[0];
  if (body.code !== "Ok" || !osrmRoute || !osrmRoute.geometry?.coordinates || osrmRoute.geometry.coordinates.length < 2) {
    throw new RouteUnavailableError(
      `No drivable route found between "${origin.label}" and "${destination.label}"${body.code !== "Ok" ? ` (OSRM: ${body.code}${body.message ? ` — ${body.message}` : ""})` : ""}`
    );
  }

  // d. simplify (keep the full line for exit projection)
  const fullCoords = osrmRoute.geometry.coordinates.filter(
    (c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]
  );
  const coords = simplifyRoute(osrmRoute.geometry.coordinates);
  if (coords.length < 2) throw new RouteUnavailableError(`Route between "${origin.label}" and "${destination.label}" is degenerate (origin and destination coincide)`);
  const cum = cumulativeKm(coords);
  const distanceKm = +cum[cum.length - 1].toFixed(2);
  const id = `osrm-${hash(key)}`;

  // e. exits (Overpass corridor → OSRM off-ramp fallback)
  let exits: RouteExit[] = [];
  let exitSource: string;
  try {
    const boxes = corridorBoxes(coords);
    const query = `[out:json][timeout:60];(${boxes.map(([s, w, n, e]) => `node["highway"="motorway_junction"](${s},${w},${n},${e});`).join("")});out body;`;
    const res = await overpassQuery(query, { cacheKey: `route-exits:${key}`, sessionId: opts.sessionId, timeoutMs: 30000, fetchImpl: opts.fetchImpl });
    exits = exitsFromJunctions(fullCoords, res.elements, distanceKm);
    exitSource = "Overpass motorway_junction";
  } catch (err) {
    console.warn(`[routing] overpass exits failed: ${(err as Error).message}`);
    exitSource = "";
  }
  if (exits.length === 0) {
    exits = exitsFromOsrmSteps(fullCoords, osrmRoute, distanceKm);
    exitSource = exitSource ? "OSRM off-ramp maneuvers (Overpass returned no junctions)" : "OSRM off-ramp maneuvers (Overpass unavailable)";
  }

  // f. timezone
  const timezone = await lookupTimezone(origin, opts.sessionId, opts.fetchImpl);

  // g. assemble
  const route = tripRouteSchema.parse({
    id,
    origin,
    destination,
    coordinates: coords,
    exits,
    distanceKm,
    durationMinutes: Math.max(+(osrmRoute.duration / 60).toFixed(1), 0.1),
    source: "osrm",
    timezone,
    fetchedAt: new Date().toISOString(),
    attribution: `${OSM_ATTRIBUTION}. Geometry: OSRM demo server; exits: ${exitSource}.`
  });
  routeCache.set(key, { at: Date.now(), route });
  storeRoute(route);
  return route;
}

/** For tests. */
export function clearRoutingCache(): void {
  routeCache.clear();
  store.clear();
}
