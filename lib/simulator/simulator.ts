import scenario from "@/data/scenarios/highway-401.json";
import type { CarState, Need } from "@/lib/domain/types";
import { clampKm, pointAtKm, ROUTE } from "@/lib/route/route";

/**
 * Deterministic simulation on the real Toronto → Montréal road geometry.
 * A car is defined by where it was placed (anchorKm at anchorElapsed) and its cruise speed;
 * its position at any simulated minute is a pure function of those. Placing or dragging a car
 * on the map simply re-anchors it.
 */
export interface SimCar {
  id: string;
  label: string;
  role: "lead" | "passenger";
  anchorKm: number;
  anchorElapsed: number;
  speedKph: number;
  needs: Need[];
  ev: boolean;
  connector?: "NACS" | "CCS1";
  batteryPercent?: number;
  passengers: number;
  kids: boolean;
  /** When set, GPS is "frozen" at this simulated minute (stale-position testing). */
  gpsFrozenAtElapsed?: number | null;
}

export interface SimCarState extends CarState {
  lat: number;
  lng: number;
  headingDeg: number;
}

export interface SimState {
  elapsedMinutes: number;
  localTime: string;
  cars: SimCarState[];
}

type ScenarioFile = typeof scenario;

export function loadScenario(): ScenarioFile {
  return scenario;
}

export const ROUTE_TOTAL_KM = ROUTE.totalKm;
export const CAR_IDS = ["car_a", "car_b", "car_c"] as const;
export const CAR_COLORS: Record<string, string> = { car_a: "#2563eb", car_b: "#db2777", car_c: "#d97706" };

export function addMinutesToHHMM(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const total = (((h * 60 + m + Math.floor(minutes)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Departure "HH:mm" from the scenario fixture (13:00 by default). */
export function scenarioDeparture(): string {
  return (scenario as ScenarioFile).departureLocal.slice(11, 16);
}

export function localTimeAt(elapsedMinutes: number, departure = scenarioDeparture()): string {
  return addMinutesToHHMM(departure, elapsedMinutes);
}

export function progressAt(car: SimCar, elapsedMinutes: number): number {
  const t = car.gpsFrozenAtElapsed != null ? Math.min(elapsedMinutes, car.gpsFrozenAtElapsed) : elapsedMinutes;
  return clampKm(car.anchorKm + (car.speedKph * (t - car.anchorElapsed)) / 60);
}

/** Re-anchor a car so it is at `km` at simulated minute `elapsed`. */
export function placeCar(car: SimCar, km: number, elapsed: number): SimCar {
  return { ...car, anchorKm: clampKm(km), anchorElapsed: elapsed, gpsFrozenAtElapsed: car.gpsFrozenAtElapsed != null ? elapsed : null };
}

/**
 * Time-consistency rules (everything departs Toronto, km 0, at the trip's departure time):
 * - farthest a car can be at `elapsed` is speed × elapsed;
 * - placing the LEAD car moves the clock to when it would really be there (km ÷ speed);
 * - placing another car clamps it to what it could have reached by now.
 */
export function maxReachableKm(car: SimCar, elapsedMinutes: number): number {
  return clampKm((car.speedKph * Math.max(elapsedMinutes, 0)) / 60);
}

/** Minutes after departure at which a car driving at its speed from km 0 reaches `km`. */
export function elapsedToReach(km: number, speedKph: number): number {
  return (clampKm(km) / Math.max(speedKph, 1)) * 60;
}

/** Simulated minute at which this car reaches the destination. */
export function arrivalElapsed(car: SimCar): number {
  return car.anchorElapsed + ((ROUTE.totalKm - car.anchorKm) / Math.max(car.speedKph, 1)) * 60;
}

export function placeFollowerPlausibly(car: SimCar, km: number, elapsed: number): { car: SimCar; km: number; clamped: boolean } {
  const max = maxReachableKm(car, elapsed);
  const target = Math.min(clampKm(km), max);
  return { car: placeCar(car, target, elapsed), km: target, clamped: target < clampKm(km) - 0.05 };
}

export function carStateAt(car: SimCar, elapsedMinutes: number): SimCarState {
  const progressKm = progressAt(car, elapsedMinutes);
  const p = pointAtKm(progressKm);
  const arrived = progressKm >= ROUTE_TOTAL_KM;
  const frozen = car.gpsFrozenAtElapsed != null;
  return {
    id: car.id,
    label: car.label,
    role: car.role,
    progressKm: Math.round(progressKm * 10) / 10,
    speedKph: arrived ? 0 : car.speedKph,
    passengers: car.passengers,
    kids: car.kids,
    ev: car.ev,
    connector: car.connector,
    batteryPercent: car.batteryPercent,
    positionUpdatedMinutesAgo: frozen ? Math.max(0, Math.round(elapsedMinutes - car.gpsFrozenAtElapsed!)) : 0,
    needs: car.needs,
    lat: p.lat,
    lng: p.lng,
    headingDeg: Math.round(p.headingDeg)
  };
}

/** Default cars: Car A alone (one-car milestone); B and C can be added. */
export function defaultSimCar(id: (typeof CAR_IDS)[number]): SimCar {
  const base: Record<string, Partial<SimCar>> = {
    car_a: { label: "Car A", role: "lead", anchorKm: 0, speedKph: 100, passengers: 3, kids: true },
    car_b: { label: "Car B", role: "passenger", anchorKm: 0, speedKph: 98, passengers: 2, kids: false, ev: true, connector: "NACS", batteryPercent: 38 },
    car_c: { label: "Car C", role: "passenger", anchorKm: 0, speedKph: 96, passengers: 2, kids: false }
  };
  return {
    id,
    label: id,
    role: "passenger",
    anchorKm: 0,
    anchorElapsed: 0,
    speedKph: 100,
    needs: [],
    ev: false,
    passengers: 2,
    kids: false,
    gpsFrozenAtElapsed: null,
    ...base[id]
  } as SimCar;
}

/** Legacy helper (scenario fixture cars, 3-car) kept for compatibility with earlier callers. */
export function simCars(): SimCar[] {
  return (scenario as ScenarioFile).cars.map((c, i) => ({
    ...defaultSimCar(CAR_IDS[i] ?? "car_c"),
    id: c.id,
    label: c.label,
    role: (c.role === "lead" ? "lead" : "passenger") as SimCar["role"],
    anchorKm: c.virtualStartProgressKm,
    anchorElapsed: 0,
    speedKph: Math.round(100 * c.drivingFactor),
    needs: c.needs as Need[]
  }));
}

export function stateAt(elapsedMinutes: number, cars: SimCar[] = simCars(), departure = scenarioDeparture()): SimState {
  return {
    elapsedMinutes,
    localTime: localTimeAt(elapsedMinutes, departure),
    cars: cars.map((c) => carStateAt(c, elapsedMinutes))
  };
}
