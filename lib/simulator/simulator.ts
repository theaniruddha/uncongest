import scenario from "@/data/scenarios/highway-401.json";
import type { CarState } from "@/lib/domain/types";

export interface SimCar {
  id: string;
  label: string;
  role: "lead" | "passenger";
  startKm: number;
  drivingFactor: number;
  needs: import("@/lib/domain/types").Need[];
  ev: boolean;
  connector?: "NACS" | "CCS1";
  batteryPercent?: number;
  passengers: number;
  kids: boolean;
}

export interface SimState {
  elapsedMinutes: number;
  localTime: string;
  cars: CarState[];
}

type ScenarioFile = typeof scenario;

export function loadScenario(): ScenarioFile {
  return scenario;
}

export const ROUTE_TOTAL_KM = 420;
const BASE_KPH = 100;

export function routePointAtKm(km: number): { lat: number; lng: number } {
  const pts = (scenario as ScenarioFile).routeAnchorPoints as Array<[number, number]>;
  const segLen: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    total += Math.sqrt(dx * dx + dy * dy);
    segLen.push(total);
  }
  const scale = ROUTE_TOTAL_KM / total;
  const target = Math.min(Math.max(km, 0), ROUTE_TOTAL_KM) / scale;
  for (let i = 1; i < segLen.length; i++) {
    if (target <= segLen[i]) {
      const t = (target - segLen[i - 1]) / Math.max(segLen[i] - segLen[i - 1], 1e-9);
      return {
        lat: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
        lng: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t
      };
    }
  }
  const last = pts[pts.length - 1];
  return { lat: last[1], lng: last[0] };
}

function addMinutesToLocal(isoLocal: string, minutes: number): string {
  const [datePart, timePart] = isoLocal.split("T");
  const [h, m] = timePart.slice(0, 5).split(":").map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(total / 60) % 24;
  const mm = total % 60;
  return `${datePart}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function localTimeAt(elapsedMinutes: number): string {
  return addMinutesToLocal((scenario as ScenarioFile).departureLocal, elapsedMinutes).slice(11, 16);
}

export function simCars(): SimCar[] {
  const cfg = (scenario as ScenarioFile).config;
  return (scenario as ScenarioFile).cars.map((c) => ({
    id: c.id,
    label: c.label,
    role: c.role as "lead" | "passenger",
    startKm: c.virtualStartProgressKm,
    drivingFactor: c.drivingFactor,
    needs: c.needs as SimCar["needs"],
    ev: c.id === "car_b",
    connector: c.id === "car_b" ? ("NACS" as const) : undefined,
    batteryPercent: c.id === "car_b" ? 24 : undefined,
    passengers: c.id === "car_a" ? 3 : 2,
    kids: cfg.carCount > 0 && c.id === "car_a"
  }));
}

export function stateAt(elapsedMinutes: number): SimState {
  const cars: CarState[] = simCars().map((c) => {
    const progressKm = Math.min(c.startKm + BASE_KPH * c.drivingFactor * (elapsedMinutes / 60), ROUTE_TOTAL_KM);
    const speedKph = Math.round(BASE_KPH * c.drivingFactor * (1 + 0.05 * Math.sin(elapsedMinutes / 17)));
    const { lat, lng } = routePointAtKm(progressKm);
    return {
      id: c.id,
      label: c.label,
      role: c.role,
      progressKm: Math.round(progressKm * 10) / 10,
      speedKph,
      passengers: c.passengers,
      kids: c.kids,
      ev: c.ev,
      connector: c.connector,
      batteryPercent: c.batteryPercent,
      positionUpdatedMinutesAgo: 0,
      needs: c.needs,
      lat,
      lng
    } as CarState & { lat: number; lng: number };
  });
  return { elapsedMinutes, localTime: localTimeAt(elapsedMinutes), cars };
}
