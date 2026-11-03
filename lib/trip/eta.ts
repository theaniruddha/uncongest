import type { RouteModel } from "@/lib/route/model";
import type { StopPlan } from "@/lib/trip/types";
import { buildTimeline, type TripCar } from "@/lib/trip/sim";
import { formatInZone, localDateTimeToUtc, sunTimes, utcToLocal, isDark } from "@/lib/trip/daylight";

export interface EtaInput {
  car: TripCar;
  route: RouteModel;
  stops: StopPlan[];
  /** Trip departure (elapsed minute 0) as a UTC instant. */
  departureUtc: Date;
  timeZone: string;
}

export interface DestinationEta {
  arrivalUtc: Date;
  arrivalLocal: string;
  /** Pure highway driving minutes (route km ÷ speed). */
  driveMinutes: number;
  /** Minutes spent at stops (dwell). */
  stopMinutes: number;
  /** Minutes spent on stop detours (exit + return legs). */
  detourMinutes: number;
}

const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

export function destinationEta({ car, route, stops, departureUtc, timeZone }: EtaInput): DestinationEta {
  const tl = buildTimeline(car, route, stops);
  let driveMinutes = 0;
  let stopMinutes = 0;
  let detourMinutes = 0;
  for (const s of tl.segments) {
    const d = s.end - s.start;
    if (s.phase === "driving") driveMinutes += d;
    else if (s.phase === "at_stop") stopMinutes += d;
    else detourMinutes += d;
  }
  const arrivalUtc = addMinutes(departureUtc, tl.arrivalElapsed);
  return { arrivalUtc, arrivalLocal: formatInZone(arrivalUtc, timeZone), driveMinutes, stopMinutes, detourMinutes };
}

export interface StopImpact {
  addedMinutes: number;
  newArrivalLocal: string;
  baselineArrivalLocal: string;
  newArrivalUtc: Date;
  baselineArrivalUtc: Date;
}

/** How much a candidate stop (selected for `ctx.car` only) would push the car's arrival. */
export function etaImpactOfStop(
  candidate: { km: number; detourMinutes: number; lat?: number; lng?: number; stopId?: string },
  plannedDwellMinutes: number,
  ctx: EtaInput
): StopImpact {
  const baseline = destinationEta(ctx);
  const p = ctx.route.pointAtKm(candidate.km);
  const hypothetical: StopPlan = {
    stopId: candidate.stopId ?? "__candidate__",
    name: "candidate",
    km: candidate.km,
    lat: candidate.lat ?? p.lat,
    lng: candidate.lng ?? p.lng,
    categories: [],
    status: "SELECTED",
    detourMinutes: candidate.detourMinutes,
    plannedDwellMinutes,
    participants: [ctx.car.id],
    satisfiedNeeds: []
  };
  const withStop = destinationEta({ ...ctx, stops: [...ctx.stops.filter((s) => s.stopId !== hypothetical.stopId), hypothetical] });
  return {
    addedMinutes: (withStop.arrivalUtc.getTime() - baseline.arrivalUtc.getTime()) / 60_000,
    newArrivalLocal: withStop.arrivalLocal,
    baselineArrivalLocal: baseline.arrivalLocal,
    newArrivalUtc: withStop.arrivalUtc,
    baselineArrivalUtc: baseline.arrivalUtc
  };
}

/** Default dwell per stop kind, minutes. Editable per stop afterwards. */
export const DWELL_DEFAULTS = {
  restroom: 8,
  coffee: 12,
  grocery: 15,
  quick_bite: 20,
  /** "meal" with no/"auto" preference — between a quick bite and a proper meal. */
  meal: 30,
  ev_charge: 30,
  proper_meal: 45
} as const;

/**
 * Default dwell for a stop serving `categories`: the heaviest relevant need wins
 * (e.g. restroom + proper meal → 45). Meal length follows `mealPreference`
 * (quick_bite 20, proper_meal 45, coffee 12, auto/custom/undefined 30).
 */
export function defaultDwellMinutes(categories: string[], mealPreference?: string): number {
  let best = 0;
  for (const raw of categories) {
    const c = raw.toLowerCase();
    let m = 0;
    if (c === "meal" || c === "food" || c === "restaurant") {
      m = mealPreference === "quick_bite" ? DWELL_DEFAULTS.quick_bite
        : mealPreference === "proper_meal" ? DWELL_DEFAULTS.proper_meal
        : mealPreference === "coffee" ? DWELL_DEFAULTS.coffee
        : DWELL_DEFAULTS.meal;
    } else if (c in DWELL_DEFAULTS) {
      m = DWELL_DEFAULTS[c as keyof typeof DWELL_DEFAULTS];
    }
    best = Math.max(best, m);
  }
  return best || DWELL_DEFAULTS.restroom;
}

export interface ArrivalDaylight {
  sunsetLocal: string | null;
  afterDark: boolean;
  /** Arrival − sunset in minutes (negative = before sunset); null in polar cases. */
  minutesAfterSunset: number | null;
}

/** Daylight at the destination on the local day of arrival. "Dark" = sun below the horizon. */
export function arrivalDaylight({ arrivalUtc, destLat, destLng, timeZone }: { arrivalUtc: Date; destLat: number; destLng: number; timeZone: string }): ArrivalDaylight {
  const local = utcToLocal(arrivalUtc, timeZone);
  const t = sunTimes(localDateTimeToUtc(local.date, "12:00", timeZone), destLat, destLng);
  const afterDark = t.sunrise && t.sunset
    ? arrivalUtc.getTime() < t.sunrise.getTime() || arrivalUtc.getTime() > t.sunset.getTime()
    : isDark(arrivalUtc, destLat, destLng);
  return {
    sunsetLocal: t.sunset ? formatInZone(t.sunset, timeZone) : null,
    afterDark,
    minutesAfterSunset: t.sunset ? Math.round((arrivalUtc.getTime() - t.sunset.getTime()) / 60_000) : null
  };
}
