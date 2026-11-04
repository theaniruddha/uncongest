import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import routeFixture from "@/data/routes/toronto-montreal.json";
import { createRouteModel, cumulativeKm, haversineKm, projectOnto, type RouteExit, type RouteModel } from "@/lib/route/model";
import { tripRouteSchema, type PlaceRef, type TripRoute } from "@/lib/trip/types";
import { getBudget } from "./budget";
import { overpassQuery, type OverpassElement } from "./overpass";

/**
 * Real route resolution for the configurable trip simulator. Server-only.
 * Order: offline fixture (Toronto → Montréal) → memory cache (24 h; 10 min for degraded routes)
 * → runtime disk cache → committed recordings (data/recorded/routes) → OSRM demo server.
 * Exits come from OSM motorway_junction nodes (Overpass, corridor bboxes) with an OSRM
 * off-ramp maneuver fallback. Geometry is never fabricated: no route → RouteUnavailableError.
 */
const OSRM_BASE = process.env.OSRM_URL || "https://router.project-osrm.org";
const UA = "uncongest-sim/0.2 (road-trip simulator)";
const TTL_MS = 24 * 60 * 60 * 1000;
/** Routes whose exits are degraded (OSRM ramp steps / none) are retried after 10 min. */
const DEGRADED_TTL_MS = 10 * 60 * 1000;
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
    if (el.tags?.barrier) continue; // border_control etc. share the query
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
  legs?: Array<{ summary?: string; steps?: OsrmStep[] }>;
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

export interface BorderCrossing {
  km: number;
  name: string | null;
  lat: number;
  lng: number;
}

/** OSM barrier=border_control nodes/ways (center) within 300 m of the route, deduped within 2 km. */
export function borderCrossingsFrom(coords: LngLat[], elements: OverpassElement[], targetTotalKm?: number): BorderCrossing[] {
  const cum = cumulativeKm(coords);
  const scale = kmScaler(cum, targetTotalKm);
  const raw: BorderCrossing[] = [];
  for (const el of elements) {
    if (el.tags?.barrier !== "border_control") continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    const p = projectOnto(coords, cum, lat, lng);
    if (p.offRouteKm > 0.3) continue;
    raw.push({ km: +scale(p.km).toFixed(2), name: el.tags.name ?? el.tags.operator ?? null, lat, lng });
  }
  raw.sort((a, b) => a.km - b.km);
  const out: BorderCrossing[] = [];
  for (const b of raw) {
    const prev = out[out.length - 1];
    if (prev && b.km - prev.km < 2) {
      if (!prev.name && b.name) prev.name = b.name;
      continue;
    }
    out.push(b);
  }
  return out;
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

// ---------- disk persistence (server-only; every fs call tolerates failure) ----------

/** Runtime cache dir (writable). Evaluated per call so tests / deployments can override via env. */
export function routeCacheDir(): string {
  const base = process.env.UNCONGEST_CACHE_DIR || (process.env.VERCEL ? "/tmp/uncongest-cache" : ".cache");
  return path.join(base, "routes");
}

/** Committed recordings (read-only at runtime). UNCONGEST_RECORDED_DIR overrides for tests. */
export function recordedRoutesDir(): string {
  return process.env.UNCONGEST_RECORDED_DIR || path.join(process.cwd(), "data", "recorded", "routes");
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");

async function readRouteFile(file: string): Promise<TripRoute | null> {
  try {
    const parsed = tripRouteSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeRouteFile(dir: string, route: TripRoute): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeId(route.id)}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(route));
  await rename(tmp, file);
  return file;
}

async function persistRoute(route: TripRoute): Promise<void> {
  try {
    await writeRouteFile(routeCacheDir(), route);
  } catch (err) {
    console.warn(`[routing] route cache write skipped: ${(err as Error).message}`);
  }
}

/** Write a route to data/recorded/routes/<id>.json (recorder script). Returns the file path. */
export async function recordRoute(route: TripRoute): Promise<string> {
  return writeRouteFile(recordedRoutesDir(), tripRouteSchema.parse(route));
}

// ---------- resolve ----------

type ExitsMode = "inline" | "defer";
interface ResolveOpts {
  sessionId?: string;
  fetchImpl?: FetchImpl;
  /** "inline" (default): wait for exits. "defer": return geometry ASAP with exitsStatus "pending". */
  exits?: ExitsMode;
}

/** Memory cache keyed by route id (id is a hash of the rounded endpoints). */
const routeCache = new Map<string, { at: number; ttl: number; route: TripRoute }>();
/** Full-resolution OSRM polyline + steps per route id (for exit projection), LRU-bounded. */
const geometryById = new Map<string, { full: LngLat[]; osrm: OsrmRoute }>();
const geometryInflight = new Map<string, Promise<TripRoute>>();
const exitsInflight = new Map<string, Promise<TripRoute>>();

function rememberGeometry(id: string, full: LngLat[], osrm: OsrmRoute): void {
  geometryById.delete(id);
  geometryById.set(id, { full, osrm });
  while (geometryById.size > STORE_MAX) {
    const oldest = geometryById.keys().next().value;
    if (oldest === undefined) break;
    geometryById.delete(oldest);
  }
}

function freshCached(id: string): TripRoute | null {
  const hit = routeCache.get(id);
  return hit && Date.now() - hit.at < hit.ttl ? hit.route : null;
}

function cacheRoute(route: TripRoute): void {
  const ttl = route.exitsStatus === "degraded" ? DEGRADED_TTL_MS : TTL_MS;
  routeCache.set(route.id, { at: Date.now(), ttl, route });
  storeRoute(route);
}

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
    exitsStatus: "ready",
    source: "fixture",
    timezone: DEFAULT_TZ,
    fetchedAt: routeFixture.fetchedAt,
    attribution: `${OSM_ATTRIBUTION}. Geometry: OSRM; exits: Overpass motorway_junction (cached fixture).`
  });
}

const isFixtureTrip = (o: PlaceRef, d: PlaceRef) =>
  haversineKm([o.lng, o.lat], FIXTURE_ORIGIN) <= FIXTURE_RADIUS_KM && haversineKm([d.lng, d.lat], FIXTURE_DEST) <= FIXTURE_RADIUS_KM;

function routeSummary(r: OsrmRoute): string {
  const s = r.legs?.[0]?.summary?.trim();
  if (s) return s;
  const names: string[] = [];
  for (const step of r.legs?.[0]?.steps ?? []) {
    const n = (step.ref || step.name || "").trim();
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= 3) break;
  }
  return names.join(", ") || "Alternative route";
}

/** OSRM (one request, alternatives=true) + timezone in parallel → route with exitsStatus "pending". */
async function loadGeometry(origin: PlaceRef, destination: PlaceRef, id: string, opts: ResolveOpts): Promise<TripRoute> {
  const t0 = Date.now();
  const osrmBudget = getBudget("osrm");
  const refused = osrmBudget.take(opts.sessionId);
  if (refused) throw new RoutingServiceUnavailableError(refused);
  const url = `${OSRM_BASE}/route/v1/driving/${origin.lng.toFixed(5)},${origin.lat.toFixed(5)};${destination.lng.toFixed(5)},${destination.lat.toFixed(5)}?overview=full&geometries=geojson&steps=true&alternatives=true`;
  const osrmCall = fetchJson(url, OSRM_TIMEOUT_MS, opts.fetchImpl).catch((err: Error) => {
    const msg = err.name === "AbortError" ? "timeout after 20 s" : err.message;
    osrmBudget.error(msg);
    throw new RoutingServiceUnavailableError(`Routing service (OSRM) unavailable: ${msg}`);
  });
  const [resp, timezone] = await Promise.all([osrmCall, lookupTimezone(origin, opts.sessionId, opts.fetchImpl)]);

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

  const fullCoords = osrmRoute.geometry.coordinates.filter((c, i, arr) => i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]);
  const coords = simplifyRoute(osrmRoute.geometry.coordinates);
  if (coords.length < 2) throw new RouteUnavailableError(`Route between "${origin.label}" and "${destination.label}" is degenerate (origin and destination coincide)`);
  const cum = cumulativeKm(coords);

  const alternatives = (body.routes ?? [])
    .slice(1, 3)
    .filter((r) => r.geometry?.coordinates?.length >= 2)
    .map((r, i) => ({
      id: `${id}-alt${i + 1}`,
      distanceKm: +(r.distance / 1000).toFixed(2),
      durationMinutes: +(r.duration / 60).toFixed(1),
      summary: routeSummary(r),
      coordinates: simplifyRoute(r.geometry.coordinates, SIMPLIFY_TOLERANCE_KM, 300)
    }));

  const route = tripRouteSchema.parse({
    id,
    origin,
    destination,
    coordinates: coords,
    exits: [],
    distanceKm: +cum[cum.length - 1].toFixed(2),
    durationMinutes: Math.max(+(osrmRoute.duration / 60).toFixed(1), 0.1),
    exitsStatus: "pending",
    borderCrossings: [],
    alternatives,
    source: "osrm",
    timezone,
    fetchedAt: new Date().toISOString(),
    attribution: `${OSM_ATTRIBUTION}. Geometry: OSRM demo server; exits: pending.`
  });
  rememberGeometry(id, fullCoords, osrmRoute);
  cacheRoute(route);
  console.info(`[routing] ${id} geometry ${Date.now() - t0}ms`);
  return route;
}

/** Overpass (junctions + border_control in one union, retried once) → OSRM ramp-step fallback. */
async function computeExits(base: TripRoute, opts: ResolveOpts): Promise<TripRoute> {
  const t0 = Date.now();
  const geo = geometryById.get(base.id);
  const full = geo?.full ?? (base.coordinates as LngLat[]);
  const boxes = corridorBoxes(base.coordinates as LngLat[]);
  const q = boxes
    .map(([s, w, n, e]) => {
      const bb = `(${s},${w},${n},${e})`;
      return `node["highway"="motorway_junction"]${bb};node["barrier"="border_control"]${bb};way["barrier"="border_control"]${bb};`;
    })
    .join("");
  const query = `[out:json][timeout:60];(${q});out center;`;
  let elements: OverpassElement[] | null = null;
  for (let attempt = 1; attempt <= 2 && !elements; attempt++) {
    try {
      const res = await overpassQuery(query, { cacheKey: `route-exits-v2:${base.id}`, sessionId: opts.sessionId, timeoutMs: 30000, fetchImpl: opts.fetchImpl });
      elements = res.elements;
    } catch (err) {
      console.warn(`[routing] overpass exits failed (attempt ${attempt}/2): ${(err as Error).message}`);
    }
  }
  let exits = elements ? exitsFromJunctions(full, elements, base.distanceKm) : [];
  const borderCrossings = elements ? borderCrossingsFrom(full, elements, base.distanceKm) : [];
  let exitSource = "Overpass motorway_junction";
  const degraded = exits.length === 0;
  if (degraded) {
    exits = geo ? exitsFromOsrmSteps(full, geo.osrm, base.distanceKm) : [];
    exitSource = elements ? "OSRM ramp steps (no OSM junctions found)" : "OSRM ramp steps (OSM junctions unavailable)";
  }
  const route = tripRouteSchema.parse({
    ...base,
    exits,
    borderCrossings,
    exitsStatus: degraded ? "degraded" : "ready",
    attribution: `${OSM_ATTRIBUTION}. Geometry: OSRM demo server; exits: ${exitSource}.`
  });
  cacheRoute(route);
  if (!degraded) await persistRoute(route);
  console.info(`[routing] ${base.id} exits ${Date.now() - t0}ms (${route.exitsStatus}, ${exits.length} exits, ${borderCrossings.length} border crossings)`);
  return route;
}

/**
 * Fill exits + border crossings for a route resolved with exits: "defer".
 * Concurrent calls for the same id share one in-flight promise. If the id is unknown (evicted / other
 * instance) and endpoints are given, geometry is re-resolved from them first (cache → OSRM).
 */
export async function resolveExits(
  routeId: string,
  opts: { sessionId?: string; fetchImpl?: FetchImpl; origin?: PlaceRef; destination?: PlaceRef } = {}
): Promise<TripRoute> {
  const relabel = (r: TripRoute): TripRoute =>
    opts.origin && opts.destination ? { ...r, origin: opts.origin, destination: opts.destination } : r;
  const fresh = freshCached(routeId);
  if (fresh && fresh.exitsStatus !== "pending") return relabel(fresh);
  const pending = exitsInflight.get(routeId);
  if (pending) return relabel(await pending);

  let base: TripRoute | null = fresh;
  if (!base) {
    const stored = getStoredRoute(routeId);
    // Expired / degraded entry whose full geometry is still in memory: recompute exits without OSRM.
    if (stored && stored.exitsStatus !== "ready" && geometryById.has(routeId)) base = stored;
    else if (stored && stored.exitsStatus === "ready" && routeId === routeFixture.id) return relabel(stored);
  }
  if (!base) {
    if (!opts.origin || !opts.destination) throw new RouteUnavailableError(`Unknown route id "${routeId}" — resolve the route first`);
    const r = await resolveRoute(opts.origin, opts.destination, { sessionId: opts.sessionId, fetchImpl: opts.fetchImpl, exits: "defer" });
    if (r.exitsStatus !== "pending") return r;
    if (r.id !== routeId) return resolveExits(r.id, opts);
    base = freshCached(r.id) ?? r;
  }
  const b = base;
  const run = computeExits(b, opts);
  exitsInflight.set(routeId, run);
  try {
    return relabel(await run);
  } finally {
    exitsInflight.delete(routeId);
  }
}

export async function resolveRoute(origin: PlaceRef, destination: PlaceRef, opts: ResolveOpts = {}): Promise<TripRoute> {
  const mode: ExitsMode = opts.exits ?? "inline";
  // a. offline fixture
  if (isFixtureTrip(origin, destination)) {
    const r = fixtureRoute(origin, destination);
    storeRoute(r);
    return r;
  }

  const key = endpointKey(origin, destination);
  const id = `osrm-${hash(key)}`;
  const osrmBudget = getBudget("osrm");
  const asCached = (cached: TripRoute, suffix = ""): TripRoute => {
    osrmBudget.hit();
    const r: TripRoute = { ...cached, origin, destination, source: "cache", attribution: cached.attribution + suffix };
    storeRoute(r);
    return r;
  };

  // b. memory cache (pending routes reuse geometry; inline mode then fills exits)
  const hit = freshCached(id);
  if (hit) {
    if (hit.exitsStatus !== "pending" || mode === "defer") return asCached(hit);
    return { ...(await resolveExits(id, { sessionId: opts.sessionId, fetchImpl: opts.fetchImpl })), origin, destination, source: "cache" };
  }

  // b2. runtime disk cache, then committed recordings (always exitsStatus ready)
  const disk = await readRouteFile(path.join(routeCacheDir(), `${safeId(id)}.json`));
  if (disk && disk.exitsStatus === "ready") {
    cacheRoute(disk);
    return asCached(disk);
  }
  const recorded = await readRouteFile(path.join(recordedRoutesDir(), `${safeId(id)}.json`));
  if (recorded && recorded.exitsStatus === "ready") {
    const withSuffix = { ...recorded, attribution: `${recorded.attribution} · recorded ${recorded.fetchedAt.slice(0, 10)}` };
    cacheRoute(withSuffix);
    return asCached(withSuffix);
  }

  // c. OSRM geometry (deduped per id)
  let geom = geometryInflight.get(id);
  if (!geom) {
    geom = loadGeometry(origin, destination, id, opts);
    geometryInflight.set(id, geom);
    geom.then(
      () => geometryInflight.delete(id),
      () => geometryInflight.delete(id)
    );
  }
  const pendingRoute = { ...(await geom), origin, destination };
  if (mode === "defer") return pendingRoute;
  const ready = await resolveExits(id, { sessionId: opts.sessionId, fetchImpl: opts.fetchImpl });
  return { ...ready, origin, destination, source: "osrm" };
}

/** For tests. */
export function clearRoutingCache(): void {
  routeCache.clear();
  store.clear();
  geometryById.clear();
  geometryInflight.clear();
  exitsInflight.clear();
}
