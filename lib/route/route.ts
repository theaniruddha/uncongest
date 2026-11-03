import routeFixture from "@/data/routes/toronto-montreal.json";
import { createRouteModel, exitLabel as exitLabelImpl, type RouteData, type RouteExit, type RoutePoint } from "./model";

/**
 * The cached Toronto → Montréal (Hwy 401 / A-20) route, as a RouteModel.
 * Module-level helpers are kept for the original /simulate page; new code should take a RouteModel.
 */
export type { RouteExit, RoutePoint } from "./model";

export const TORONTO_MONTREAL = createRouteModel(routeFixture as unknown as RouteData);

export const ROUTE = {
  id: TORONTO_MONTREAL.id,
  source: TORONTO_MONTREAL.source,
  attribution: TORONTO_MONTREAL.attribution,
  origin: TORONTO_MONTREAL.origin,
  destination: TORONTO_MONTREAL.destination,
  totalKm: TORONTO_MONTREAL.totalKm
};

export const routeLatLngs = (): Array<[number, number]> => TORONTO_MONTREAL.latLngs();
export const clampKm = (km: number): number => TORONTO_MONTREAL.clampKm(km);
export const pointAtKm = (km: number): RoutePoint => TORONTO_MONTREAL.pointAtKm(km);
export const nearestKm = (lat: number, lng: number) => TORONTO_MONTREAL.nearestKm(lat, lng);
export const allExits = (): RouteExit[] => TORONTO_MONTREAL.exits();
export const exitsAhead = (km: number, horizonKm: number): RouteExit[] => TORONTO_MONTREAL.exitsAhead(km, horizonKm);
export const nearestExit = (km: number): RouteExit => TORONTO_MONTREAL.nearestExit(km)!;
export const exitLabel = exitLabelImpl;
