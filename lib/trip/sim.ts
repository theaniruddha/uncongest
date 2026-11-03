import type { RouteModel } from "@/lib/route/model";
import type { StopPlan, StopStatus } from "@/lib/trip/types";

/**
 * Trip simulator over any RouteModel, with stop dwell.
 *
 * A car's position is a pure function of (car, elapsed minutes, the StopPlans it takes part in):
 * it leaves km 0 at `startOffsetMinutes`, drives at `speedKph`, and at every participating
 * SELECTED / EN_ROUTE / ARRIVED / COMPLETED / RESUMED stop it spends detour/2 exiting,
 * the dwell at the stop, then detour/2 returning to the highway at the stop's km.
 * PROPOSED and CANCELLED stops are ignored. This module is independent of lib/simulator.
 */
export interface TripCar {
  id: string;
  label: string;
  role: "lead" | "follower";
  speedKph: number;
  startOffsetMinutes: number;
  kids: number;
  adults: number;
  /** When set, GPS is "frozen" at this simulated minute (stale-position testing). */
  gpsFrozenAtElapsed?: number | null;
}

export type CarPhase = "not_started" | "driving" | "exiting" | "at_stop" | "returning" | "arrived";

export interface TripCarState {
  id: string;
  label: string;
  progressKm: number;
  /** 0 when stopped (not started, at a stop, arrived). */
  speedKph: number;
  lat: number;
  lng: number;
  headingDeg: number;
  phase: CarPhase;
  atStopId?: string;
  positionUpdatedMinutesAgo: number;
  drivingMinutesSinceRest: number;
}

export interface SimOptions {
  /**
   * A confirmed (COMPLETED/RESUMED) stop whose actual dwell is ≥ this many minutes counts as a
   * real rest and resets `drivingMinutesSinceRest`. Default 60.
   */
  restResetMinutes?: number;
}

export const DEFAULT_REST_RESET_MINUTES = 60;

/** Stop statuses that affect a car's motion. */
export const MOVING_STATUSES: readonly StopStatus[] = ["SELECTED", "EN_ROUTE", "ARRIVED", "COMPLETED", "RESUMED"];
const CONFIRMED: readonly StopStatus[] = ["COMPLETED", "RESUMED"];

export interface TimelineSegment {
  phase: Exclude<CarPhase, "not_started" | "arrived">;
  start: number;
  end: number;
  kmStart: number;
  kmEnd: number;
  stop?: StopPlan;
}

export interface CarTimeline {
  startElapsed: number;
  segments: TimelineSegment[];
  arrivalElapsed: number;
  /** Departure minute of each confirmed stop + its actual dwell (for rest accounting). */
  confirmedStops: Array<{ stopId: string; departedAt: number; dwell: number }>;
}

/** Stops this car actually takes part in, in route order. */
export function carStops(car: TripCar, stops: StopPlan[], route: RouteModel): StopPlan[] {
  return stops
    .filter((s) => MOVING_STATUSES.includes(s.status) && s.participants.includes(car.id) && s.km >= 0 && s.km < route.totalKm)
    .sort((a, b) => a.km - b.km);
}

/**
 * Whether the stop's recorded absolute times (arrivedAtElapsed / departedAtElapsed) apply to
 * this car. They are recorded from the lead car (see stopLifecycle.autoAdvance), so they apply to
 * the lead and to solo-participant stops; other participants use the recorded *durations*.
 */
function usesAbsoluteTimes(car: TripCar, stop: StopPlan): boolean {
  return car.role === "lead" || stop.participants.length === 1;
}

function dwellOf(stop: StopPlan): number {
  if (CONFIRMED.includes(stop.status)) {
    if (stop.actualDwellMinutes != null) return Math.max(0, stop.actualDwellMinutes);
    if (stop.arrivedAtElapsed != null && stop.departedAtElapsed != null) return Math.max(0, stop.departedAtElapsed - stop.arrivedAtElapsed);
  }
  return Math.max(0, stop.plannedDwellMinutes);
}

export function buildTimeline(car: TripCar, route: RouteModel, stops: StopPlan[]): CarTimeline {
  const speed = Math.max(car.speedKph, 1);
  const minutesFor = (km: number) => (km / speed) * 60;
  const segments: TimelineSegment[] = [];
  const confirmedStops: CarTimeline["confirmedStops"] = [];
  let t = Math.max(0, car.startOffsetMinutes);
  let km = 0;
  for (const stop of carStops(car, stops, route)) {
    const reach = t + minutesFor(stop.km - km);
    if (stop.km > km) segments.push({ phase: "driving", start: t, end: reach, kmStart: km, kmEnd: stop.km });
    const half = Math.max(0, stop.detourMinutes) / 2;
    const absolute = usesAbsoluteTimes(car, stop);
    let arrive = reach + half;
    if (absolute && stop.arrivedAtElapsed != null) arrive = Math.max(reach, stop.arrivedAtElapsed);
    let depart = arrive + dwellOf(stop);
    if (absolute && stop.departedAtElapsed != null && CONFIRMED.includes(stop.status)) depart = Math.max(arrive, stop.departedAtElapsed);
    const back = depart + half;
    segments.push({ phase: "exiting", start: reach, end: arrive, kmStart: stop.km, kmEnd: stop.km, stop });
    segments.push({ phase: "at_stop", start: arrive, end: depart, kmStart: stop.km, kmEnd: stop.km, stop });
    segments.push({ phase: "returning", start: depart, end: back, kmStart: stop.km, kmEnd: stop.km, stop });
    if (CONFIRMED.includes(stop.status)) confirmedStops.push({ stopId: stop.stopId, departedAt: depart, dwell: depart - arrive });
    t = back;
    km = stop.km;
  }
  const arrival = t + minutesFor(route.totalKm - km);
  if (route.totalKm > km) segments.push({ phase: "driving", start: t, end: arrival, kmStart: km, kmEnd: route.totalKm });
  return { startElapsed: Math.max(0, car.startOffsetMinutes), segments, arrivalElapsed: arrival, confirmedStops };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function lerp(a: number, b: number, f: number) {
  return a + (b - a) * f;
}

export function carStateOnRoute(car: TripCar, elapsed: number, route: RouteModel, stops: StopPlan[], opts: SimOptions = {}): TripCarState {
  const restReset = opts.restResetMinutes ?? DEFAULT_REST_RESET_MINUTES;
  const frozen = car.gpsFrozenAtElapsed != null;
  const t = frozen ? Math.min(elapsed, car.gpsFrozenAtElapsed as number) : elapsed;
  const tl = buildTimeline(car, route, stops);
  const base = {
    id: car.id,
    label: car.label,
    positionUpdatedMinutesAgo: frozen ? Math.max(0, Math.round(elapsed - (car.gpsFrozenAtElapsed as number))) : 0,
    drivingMinutesSinceRest: Math.round(drivingSinceRest(tl, t, restReset))
  };

  if (t < tl.startElapsed) {
    const p = route.pointAtKm(0);
    return { ...base, progressKm: 0, speedKph: 0, lat: p.lat, lng: p.lng, headingDeg: Math.round(p.headingDeg), phase: "not_started" };
  }
  const seg = tl.segments.find((s) => t >= s.start && t < s.end);
  if (!seg) {
    const p = route.pointAtKm(route.totalKm);
    return { ...base, progressKm: r1(route.totalKm), speedKph: 0, lat: p.lat, lng: p.lng, headingDeg: Math.round(p.headingDeg), phase: "arrived" };
  }
  const f = seg.end > seg.start ? (t - seg.start) / (seg.end - seg.start) : 1;
  if (seg.phase === "driving") {
    const km = lerp(seg.kmStart, seg.kmEnd, f);
    const p = route.pointAtKm(km);
    return { ...base, progressKm: r1(km), speedKph: car.speedKph, lat: p.lat, lng: p.lng, headingDeg: Math.round(p.headingDeg), phase: "driving" };
  }
  const stop = seg.stop as StopPlan;
  const onRoad = route.pointAtKm(stop.km);
  let lat = stop.lat;
  let lng = stop.lng;
  if (seg.phase === "exiting") {
    lat = lerp(onRoad.lat, stop.lat, f);
    lng = lerp(onRoad.lng, stop.lng, f);
  } else if (seg.phase === "returning") {
    lat = lerp(stop.lat, onRoad.lat, f);
    lng = lerp(stop.lng, onRoad.lng, f);
  }
  return {
    ...base,
    progressKm: r1(stop.km),
    speedKph: seg.phase === "at_stop" ? 0 : car.speedKph,
    lat,
    lng,
    headingDeg: Math.round(onRoad.headingDeg),
    phase: seg.phase,
    atStopId: stop.stopId
  };
}

/** Moving minutes (driving + detour legs) since the last confirmed stop with dwell ≥ threshold. */
function drivingSinceRest(tl: CarTimeline, t: number, threshold: number): number {
  let from = -Infinity;
  for (const c of tl.confirmedStops) if (c.dwell >= threshold && c.departedAt <= t) from = Math.max(from, c.departedAt);
  let sum = 0;
  for (const s of tl.segments) {
    if (s.phase === "at_stop") continue;
    const a = Math.max(s.start, from);
    const b = Math.min(s.end, t);
    if (b > a) sum += b - a;
  }
  return sum;
}

/** Minute at which the car reaches `km` on the highway (the first time), accounting for stops. */
export function elapsedAtKm(car: TripCar, km: number, route: RouteModel, stops: StopPlan[]): number {
  const target = route.clampKm(km);
  const tl = buildTimeline(car, route, stops);
  if (target <= 0) return tl.startElapsed;
  for (const s of tl.segments) {
    if (s.phase !== "driving") continue;
    if (target >= s.kmStart && target <= s.kmEnd) {
      const span = s.kmEnd - s.kmStart;
      return span > 0 ? s.start + ((target - s.kmStart) / span) * (s.end - s.start) : s.start;
    }
  }
  return tl.arrivalElapsed;
}

/** Minute at which the car reaches the destination. */
export function arrivalElapsed(car: TripCar, route: RouteModel, stops: StopPlan[]): number {
  return buildTimeline(car, route, stops).arrivalElapsed;
}

// ------------------------------------------------------------------ placement

/**
 * Placing the LEAD car moves the clock to when it would really be at `km`
 * (respecting the stops it has made / planned before that km).
 */
export function placeLead(car: TripCar, km: number, route: RouteModel, stops: StopPlan[]): { elapsed: number; km: number } {
  const k = route.clampKm(km);
  return { elapsed: elapsedAtKm(car, k, route, stops), km: k };
}

/** Farthest km a car could have reached by `elapsed` had it left at departure (offset 0). */
export function maxReachableKm(car: TripCar, elapsed: number, route: RouteModel, stops: StopPlan[]): number {
  const fresh = { ...car, startOffsetMinutes: 0, gpsFrozenAtElapsed: null };
  return carStateOnRoute(fresh, elapsed, route, stops).progressKm;
}

/**
 * Place a follower at `km` at the current `elapsed` without moving the clock: the km is clamped to
 * what it could have reached, and the car's `startOffsetMinutes` is re-derived so the pure
 * position function puts it exactly there.
 */
export function placeFollower(
  car: TripCar,
  km: number,
  elapsed: number,
  route: RouteModel,
  stops: StopPlan[]
): { car: TripCar; km: number; clamped: boolean } {
  const wanted = route.clampKm(km);
  const max = maxReachableKm(car, elapsed, route, stops);
  const target = Math.min(wanted, max);
  const fresh = { ...car, startOffsetMinutes: 0 };
  const offset = Math.max(0, elapsed - elapsedAtKm(fresh, target, route, stops));
  return {
    car: { ...car, startOffsetMinutes: offset, gpsFrozenAtElapsed: car.gpsFrozenAtElapsed != null ? elapsed : null },
    km: target,
    clamped: target < wanted - 0.05
  };
}
