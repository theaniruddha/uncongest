import routeFixture from "@/data/routes/toronto-montreal.json";

/**
 * Real road geometry (OSRM) and eastbound motorway exits (OSM), cached as an offline fixture.
 * Pure helpers: no network, safe on client and server.
 */
export interface RouteExit {
  id: string;
  ref: string | null;
  name: string | null;
  exitTo: string | null;
  lat: number;
  lng: number;
  km: number;
}

export interface RoutePoint {
  lat: number;
  lng: number;
  /** Compass bearing of travel, degrees clockwise from north. */
  headingDeg: number;
}

interface RouteFile {
  id: string;
  source: string;
  attribution: string;
  origin: string;
  destination: string;
  distanceKm: number;
  osrmDurationMinutes: number;
  coordinates: Array<[number, number]>; // [lng, lat]
  exits: RouteExit[];
}

const route = routeFixture as unknown as RouteFile;
const coords = route.coordinates;
const toRad = (d: number) => (d * Math.PI) / 180;

function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371.0088;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const cumKm: number[] = [0];
for (let i = 1; i < coords.length; i++) cumKm.push(cumKm[i - 1] + haversineKm(coords[i - 1], coords[i]));

export const ROUTE = {
  id: route.id,
  source: route.source,
  attribution: route.attribution,
  origin: route.origin,
  destination: route.destination,
  totalKm: cumKm[cumKm.length - 1]
};

export function routeLatLngs(): Array<[number, number]> {
  return coords.map(([lng, lat]) => [lat, lng]);
}

function bearing(a: [number, number], b: [number, number]): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

/** Segment index i such that cumKm[i-1] <= km <= cumKm[i]. */
function segmentAt(km: number): number {
  let lo = 1;
  let hi = cumKm.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumKm[mid] < km) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function clampKm(km: number): number {
  return Math.min(Math.max(km, 0), ROUTE.totalKm);
}

export function pointAtKm(km: number): RoutePoint {
  const k = clampKm(km);
  const i = segmentAt(k);
  const a = coords[i - 1];
  const b = coords[i];
  const span = Math.max(cumKm[i] - cumKm[i - 1], 1e-9);
  const t = (k - cumKm[i - 1]) / span;
  // smooth heading over ~1 km so tiny segments don't jitter the arrow
  const ahead = coords[segmentAt(clampKm(k + 0.5))];
  const behind = coords[Math.max(segmentAt(clampKm(k - 0.5)) - 1, 0)];
  return {
    lng: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    headingDeg: bearing(behind, ahead)
  };
}

/** Snap an arbitrary map click to the route; returns km along route and distance off-route. */
export function nearestKm(lat: number, lng: number): { km: number; offRouteKm: number } {
  const kx = Math.cos(toRad(lat)) * 111.32;
  const ky = 110.57;
  let best = { d: Infinity, km: 0 };
  for (let i = 1; i < coords.length; i++) {
    const [ax0, ay0] = coords[i - 1];
    const [bx0, by0] = coords[i];
    const ax = ax0 * kx, ay = ay0 * ky, bx = bx0 * kx, by = by0 * ky, px = lng * kx, py = lat * ky;
    const vx = bx - ax, vy = by - ay;
    const len2 = vx * vx + vy * vy || 1e-12;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
    const dx = ax + t * vx - px, dy = ay + t * vy - py;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best.d) best = { d, km: cumKm[i - 1] + t * (cumKm[i] - cumKm[i - 1]) };
  }
  return { km: best.km, offRouteKm: best.d };
}

export function allExits(): RouteExit[] {
  return route.exits;
}

/** Exits strictly ahead of `km`, within `horizonKm`, in travel order. */
export function exitsAhead(km: number, horizonKm: number): RouteExit[] {
  return route.exits.filter((e) => e.km > km && e.km <= km + horizonKm);
}

export function nearestExit(km: number): RouteExit {
  let best = route.exits[0];
  for (const e of route.exits) if (Math.abs(e.km - km) < Math.abs(best.km - km)) best = e;
  return best;
}

export function exitLabel(e: RouteExit): string {
  const ref = e.ref ? `Exit ${e.ref}` : "Unnumbered exit";
  return e.exitTo ? `${ref} (${e.exitTo.replace(/;/g, " / ")})` : ref;
}
