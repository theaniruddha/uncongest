/**
 * Generic route model: any real road geometry + exits along it.
 * Pure (no network). Used for the 401 fixture and for custom routes built from OSRM/Overpass.
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

export interface RouteData {
  id: string;
  source: string;
  attribution: string;
  origin: string;
  destination: string;
  /** [lng, lat] pairs in travel order. */
  coordinates: Array<[number, number]>;
  exits: RouteExit[];
  /** Router's own duration estimate for the whole route, if known. */
  durationMinutes?: number;
}

export interface RouteModel {
  id: string;
  source: string;
  attribution: string;
  origin: string;
  destination: string;
  totalKm: number;
  durationMinutes: number | null;
  latLngs(): Array<[number, number]>;
  pointAtKm(km: number): RoutePoint;
  nearestKm(lat: number, lng: number): { km: number; offRouteKm: number };
  clampKm(km: number): number;
  exits(): RouteExit[];
  exitsAhead(km: number, horizonKm: number): RouteExit[];
  nearestExit(km: number): RouteExit | null;
  /** Sample points every `stepKm` between [fromKm, toKm] (inclusive ends). */
  sample(fromKm: number, toKm: number, stepKm: number): Array<RoutePoint & { km: number }>;
}

const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371.0088;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a: [number, number], b: [number, number]): number {
  const φ1 = toRad(a[1]);
  const φ2 = toRad(b[1]);
  const Δλ = toRad(b[0] - a[0]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Cumulative km per coordinate index. */
export function cumulativeKm(coords: Array<[number, number]>): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]));
  return cum;
}

/** Project a point onto a polyline: km along route and perpendicular distance (km). */
export function projectOnto(coords: Array<[number, number]>, cumKm: number[], lat: number, lng: number): { km: number; offRouteKm: number } {
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

export function createRouteModel(data: RouteData): RouteModel {
  const coords = data.coordinates;
  if (coords.length < 2) throw new Error("route needs at least 2 coordinates");
  const cum = cumulativeKm(coords);
  const totalKm = cum[cum.length - 1];
  const exits = [...data.exits].sort((a, b) => a.km - b.km);

  const clampKm = (km: number) => Math.min(Math.max(km, 0), totalKm);
  const segmentAt = (km: number) => {
    let lo = 1;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < km) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const pointAtKm = (km: number): RoutePoint => {
    const k = clampKm(km);
    const i = segmentAt(k);
    const a = coords[i - 1];
    const b = coords[i];
    const span = Math.max(cum[i] - cum[i - 1], 1e-9);
    const t = (k - cum[i - 1]) / span;
    const ahead = coords[segmentAt(clampKm(k + 0.5))];
    const behind = coords[Math.max(segmentAt(clampKm(k - 0.5)) - 1, 0)];
    return { lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t, headingDeg: bearing(behind, ahead) };
  };

  return {
    id: data.id,
    source: data.source,
    attribution: data.attribution,
    origin: data.origin,
    destination: data.destination,
    totalKm,
    durationMinutes: data.durationMinutes ?? null,
    latLngs: () => coords.map(([lng, lat]) => [lat, lng]),
    pointAtKm,
    nearestKm: (lat, lng) => projectOnto(coords, cum, lat, lng),
    clampKm,
    exits: () => exits,
    exitsAhead: (km, horizonKm) => exits.filter((e) => e.km > km && e.km <= km + horizonKm),
    nearestExit: (km) => {
      if (exits.length === 0) return null;
      let best = exits[0];
      for (const e of exits) if (Math.abs(e.km - km) < Math.abs(best.km - km)) best = e;
      return best;
    },
    sample: (fromKm, toKm, stepKm) => {
      const out: Array<RoutePoint & { km: number }> = [];
      const a = clampKm(fromKm);
      const b = clampKm(toKm);
      for (let k = a; k < b; k += Math.max(stepKm, 0.1)) out.push({ km: k, ...pointAtKm(k) });
      out.push({ km: b, ...pointAtKm(b) });
      return out;
    }
  };
}

export function exitLabel(e: RouteExit): string {
  const ref = e.ref ? `Exit ${e.ref}` : e.name ? e.name : "Unnumbered exit";
  return e.exitTo ? `${ref} (${e.exitTo.replace(/;/g, " / ")})` : ref;
}
