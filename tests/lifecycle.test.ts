import { describe, it, expect } from "vitest";
import { createRouteModel, type RouteModel } from "@/lib/route/model";
import type { StopPlan } from "@/lib/trip/types";
import { sunTimes, formatInZone, isDark, localDateTimeToUtc, utcToLocal } from "@/lib/trip/daylight";
import {
  carStateOnRoute,
  elapsedAtKm,
  arrivalElapsed,
  placeLead,
  placeFollower,
  maxReachableKm,
  type TripCar
} from "@/lib/trip/sim";
import { destinationEta, etaImpactOfStop, defaultDwellMinutes, arrivalDaylight } from "@/lib/trip/eta";
import { stopReducer, autoAdvance } from "@/lib/trip/stopLifecycle";
import { buildAgentContext, type AgentContextState } from "@/lib/context/builder";

const TZ = "America/Toronto";
const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const near = (actual: string, expected: string, tol: number) => expect(Math.abs(hhmmToMin(actual) - hhmmToMin(expected))).toBeLessThanOrEqual(tol);

// Straight-ish synthetic road Toronto → Kingston-ish (about 250 km).
const route: RouteModel = createRouteModel({
  id: "test",
  source: "test",
  attribution: "test",
  origin: "Toronto",
  destination: "Kingston",
  coordinates: [
    [-79.38, 43.65],
    [-78.5, 43.9],
    [-77.5, 44.1],
    [-76.5, 44.23]
  ],
  exits: []
});
const DEST = { lat: 44.23, lng: -76.5 };

const lead: TripCar = { id: "car_a", label: "Car A", role: "lead", speedKph: 100, startOffsetMinutes: 0, kids: 1, adults: 2 };
const carB: TripCar = { id: "car_b", label: "Car B", role: "follower", speedKph: 100, startOffsetMinutes: 0, kids: 0, adults: 2 };
const carC: TripCar = { id: "car_c", label: "Car C", role: "follower", speedKph: 90, startOffsetMinutes: 5, kids: 0, adults: 2 };

function plan(over: Partial<StopPlan> = {}): StopPlan {
  const p = route.pointAtKm(100);
  return {
    stopId: "s1",
    name: "Stop One",
    km: 100,
    lat: p.lat + 0.01,
    lng: p.lng,
    categories: ["meal"],
    status: "SELECTED",
    detourMinutes: 10,
    plannedDwellMinutes: 30,
    participants: ["car_a"],
    satisfiedNeeds: [],
    ...over
  };
}

// ------------------------------------------------------------------ daylight
describe("daylight", () => {
  const sunset = (date: string, lat: number, lng: number) => formatInZone(sunTimes(localDateTimeToUtc(date, "12:00", TZ), lat, lng).sunset!, TZ);

  it("Toronto sunset Nov 3 2026 and Jun 21 2026", () => {
    // NOAA gives 17:05 EST for Nov 3 (the spec's 16:58 is ~7 min early); assert ±5 of NOAA and ±8 of spec.
    const nov = sunset("2026-11-03", 43.65, -79.38);
    near(nov, "17:05", 5);
    near(nov, "16:58", 8);
    near(sunset("2026-06-21", 43.65, -79.38), "21:03", 5);
  });

  it("Letchworth (42.57,-78.05) similar", () => {
    near(sunset("2026-11-03", 42.57, -78.05), "17:02", 5);
    near(sunset("2026-06-21", 42.57, -78.05), "20:53", 5);
  });

  it("civil dusk after sunset; isDark; polar nulls", () => {
    const t = sunTimes(localDateTimeToUtc("2026-11-03", "12:00", TZ), 43.65, -79.38);
    expect(t.civilDusk!.getTime()).toBeGreaterThan(t.sunset!.getTime());
    expect(isDark(localDateTimeToUtc("2026-11-03", "12:00", TZ), 43.65, -79.38)).toBe(false);
    expect(isDark(localDateTimeToUtc("2026-11-03", "18:00", TZ), 43.65, -79.38)).toBe(true);
    const polarNight = sunTimes(new Date(Date.UTC(2026, 11, 21, 12)), 78, 15);
    expect(polarNight.sunrise).toBeNull();
    expect(polarNight.sunset).toBeNull();
    expect(isDark(new Date(Date.UTC(2026, 11, 21, 12)), 78, 15)).toBe(true);
    expect(sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), 78, 15).sunset).toBeNull();
  });

  it("local ↔ UTC is DST-correct", () => {
    expect(localDateTimeToUtc("2026-11-03", "13:00", TZ).toISOString()).toBe("2026-11-03T18:00:00.000Z"); // EST
    expect(localDateTimeToUtc("2026-06-21", "13:00", TZ).toISOString()).toBe("2026-06-21T17:00:00.000Z"); // EDT
    expect(localDateTimeToUtc("2026-11-01", "01:30", TZ).toISOString()).toBe("2026-11-01T05:30:00.000Z"); // ambiguous → first
    expect(utcToLocal(new Date("2026-11-04T03:30:00Z"), TZ)).toEqual({ date: "2026-11-03", time: "22:30" });
    expect(formatInZone(new Date("2026-07-01T00:05:00Z"), TZ)).toBe("20:05");
  });
});

// ------------------------------------------------------------------ sim
describe("trip sim", () => {
  it("drives linearly with no stops", () => {
    const s = carStateOnRoute(lead, 30, route, []);
    expect(s.phase).toBe("driving");
    expect(s.progressKm).toBeCloseTo(50, 1);
    expect(arrivalElapsed(lead, route, [])).toBeCloseTo((route.totalKm / 100) * 60, 6);
    expect(carStateOnRoute(carC, 3, route, []).phase).toBe("not_started");
    expect(carStateOnRoute(lead, 10_000, route, []).phase).toBe("arrived");
  });

  it("dwell pauses the car and shifts arrival by detour + dwell", () => {
    const stops = [plan()];
    const base = arrivalElapsed(lead, route, []);
    expect(arrivalElapsed(lead, route, stops) - base).toBeCloseTo(40, 6);
    // reaches km 100 at 60 → exiting 60..65 → at stop 65..95 → returning 95..100
    expect(carStateOnRoute(lead, 62, route, stops).phase).toBe("exiting");
    const at = carStateOnRoute(lead, 80, route, stops);
    expect(at.phase).toBe("at_stop");
    expect(at.speedKph).toBe(0);
    expect(at.atStopId).toBe("s1");
    expect(at.progressKm).toBe(100);
    expect(carStateOnRoute(lead, 97, route, stops).phase).toBe("returning");
    const after = carStateOnRoute(lead, 106, route, stops);
    expect(after.phase).toBe("driving");
    expect(after.progressKm).toBeCloseTo(110, 1);
  });

  it("PROPOSED and CANCELLED stops are ignored", () => {
    const base = arrivalElapsed(lead, route, []);
    expect(arrivalElapsed(lead, route, [plan({ status: "PROPOSED" })])).toBeCloseTo(base, 6);
    expect(arrivalElapsed(lead, route, [plan({ status: "CANCELLED" })])).toBeCloseTo(base, 6);
  });

  it("independent participation: car B not stopping keeps moving", () => {
    const stops = [plan({ participants: ["car_a"] })];
    const b = carStateOnRoute(carB, 80, route, stops);
    expect(b.phase).toBe("driving");
    expect(b.progressKm).toBeCloseTo(133.3, 1);
    expect(carStateOnRoute(lead, 80, route, stops).phase).toBe("at_stop");
  });

  it("completed stop uses actual times; resume continues from stop km", () => {
    const stops = [plan({ status: "RESUMED", arrivedAtElapsed: 65, departedAtElapsed: 115, actualDwellMinutes: 50 })];
    expect(carStateOnRoute(lead, 110, route, stops).phase).toBe("at_stop");
    // returning 115..120, then drives from km 100
    const s = carStateOnRoute(lead, 126, route, stops);
    expect(s.phase).toBe("driving");
    expect(s.progressKm).toBeCloseTo(110, 1);
    expect(elapsedAtKm(lead, 110, route, stops)).toBeCloseTo(126, 6);
    expect(elapsedAtKm(lead, 50, route, stops)).toBeCloseTo(30, 6);
  });

  it("completing a 45-min stop resets drivingMinutesSinceRest with threshold 30 but not 60", () => {
    const stops = [plan({ status: "COMPLETED", plannedDwellMinutes: 30, arrivedAtElapsed: 65, departedAtElapsed: 110, actualDwellMinutes: 45 })];
    // at 130: moving minutes = 60 drive + 5 exit + 5 return + 15 drive = 85; since rest (dep 110) = 5 + 15 = 20
    expect(carStateOnRoute(lead, 130, route, stops, { restResetMinutes: 30 }).drivingMinutesSinceRest).toBe(20);
    expect(carStateOnRoute(lead, 130, route, stops, { restResetMinutes: 60 }).drivingMinutesSinceRest).toBe(85);
    expect(carStateOnRoute(lead, 130, route, stops).drivingMinutesSinceRest).toBe(85); // default 60
    // an unconfirmed (SELECTED) 45-min stop never resets
    const sel = [plan({ plannedDwellMinutes: 45 })];
    expect(carStateOnRoute(lead, 130, route, sel, { restResetMinutes: 30 }).drivingMinutesSinceRest).toBe(85);
  });

  it("GPS freeze reports stale position", () => {
    const s = carStateOnRoute({ ...lead, gpsFrozenAtElapsed: 20 }, 30, route, []);
    expect(s.progressKm).toBeCloseTo(33.3, 1);
    expect(s.positionUpdatedMinutesAgo).toBe(10);
  });

  it("placement: lead sets the clock respecting completed stops; followers clamp", () => {
    const stops = [plan({ status: "RESUMED", arrivedAtElapsed: 65, departedAtElapsed: 95, actualDwellMinutes: 30 })];
    expect(placeLead(lead, 150, route, stops).elapsed).toBeCloseTo(130, 6);
    expect(placeLead(lead, 50, route, stops).elapsed).toBeCloseTo(30, 6);
    expect(maxReachableKm(carB, 30, route, [])).toBeCloseTo(50, 1);
    const far = placeFollower(carB, 120, 30, route, []);
    expect(far.clamped).toBe(true);
    expect(far.km).toBeCloseTo(50, 1);
    const behind = placeFollower(carB, 20, 30, route, []);
    expect(behind.clamped).toBe(false);
    expect(behind.car.startOffsetMinutes).toBeCloseTo(18, 6);
    expect(carStateOnRoute(behind.car, 30, route, []).progressKm).toBeCloseTo(20, 1);
  });
});

// ------------------------------------------------------------------ eta
describe("eta", () => {
  const departureUtc = localDateTimeToUtc("2026-11-03", "13:00", TZ);
  const ctx = { car: lead, route, stops: [] as StopPlan[], departureUtc, timeZone: TZ };

  it("destination ETA breaks down drive / stop / detour", () => {
    const e = destinationEta({ ...ctx, stops: [plan()] });
    expect(e.stopMinutes).toBeCloseTo(30, 6);
    expect(e.detourMinutes).toBeCloseTo(10, 6);
    expect(e.driveMinutes).toBeCloseTo((route.totalKm / 100) * 60, 6);
    expect(e.arrivalUtc.getTime() - departureUtc.getTime()).toBeCloseTo((e.driveMinutes + 40) * 60_000, -1);
    expect(e.arrivalLocal).toBe(formatInZone(e.arrivalUtc, TZ));
  });

  it("30-min meal → ETA +30 + detour exactly", () => {
    const imp = etaImpactOfStop({ km: 120, detourMinutes: 8 }, 30, ctx);
    expect(imp.addedMinutes).toBeCloseTo(38, 9);
    expect(hhmmToMin(imp.newArrivalLocal) - hhmmToMin(imp.baselineArrivalLocal)).toBeGreaterThanOrEqual(37);
  });

  it("default dwell picks the heaviest need", () => {
    expect(defaultDwellMinutes(["restroom"])).toBe(8);
    expect(defaultDwellMinutes(["coffee", "restroom"])).toBe(12);
    expect(defaultDwellMinutes(["grocery"])).toBe(15);
    expect(defaultDwellMinutes(["meal"], "quick_bite")).toBe(20);
    expect(defaultDwellMinutes(["meal", "restroom"], "proper_meal")).toBe(45);
    expect(defaultDwellMinutes(["ev_charge", "coffee"])).toBe(30);
    expect(defaultDwellMinutes(["ev_charge", "meal"], "proper_meal")).toBe(45);
  });

  it("arrival daylight after a stop flips to afterDark on a November afternoon trip", () => {
    const dep = localDateTimeToUtc("2026-11-03", "14:00", TZ);
    const c = { ...ctx, departureUtc: dep };
    const before = arrivalDaylight({ arrivalUtc: destinationEta(c).arrivalUtc, destLat: DEST.lat, destLng: DEST.lng, timeZone: TZ });
    expect(before.afterDark).toBe(false);
    expect(before.minutesAfterSunset!).toBeLessThan(0);
    const withStop = destinationEta({ ...c, stops: [plan({ plannedDwellMinutes: 45, detourMinutes: 10 })] });
    const after = arrivalDaylight({ arrivalUtc: withStop.arrivalUtc, destLat: DEST.lat, destLng: DEST.lng, timeZone: TZ });
    expect(after.afterDark).toBe(true);
    expect(after.minutesAfterSunset!).toBeGreaterThan(0);
    expect(after.sunsetLocal).toMatch(/^16:|^17:/);
  });
});

// ------------------------------------------------------------------ lifecycle
describe("stop lifecycle", () => {
  const proposed = plan({ status: "PROPOSED" });

  it("walks the full lifecycle and records actual dwell", () => {
    let r = stopReducer([], { type: "select", plan: proposed });
    expect(r.error).toBeUndefined();
    expect(r.plans[0].status).toBe("SELECTED");
    r = stopReducer(r.plans, { type: "setDwell", stopId: "s1", minutes: 20 });
    expect(r.plans[0].plannedDwellMinutes).toBe(20);
    r = stopReducer(r.plans, { type: "enRoute", stopId: "s1", elapsed: 55 });
    r = stopReducer(r.plans, { type: "arrive", stopId: "s1", elapsed: 65 });
    expect(r.plans[0].satisfiedNeeds).toEqual([]);
    r = stopReducer(r.plans, { type: "complete", stopId: "s1", elapsed: 92, satisfiedNeeds: ["restroom"] });
    expect(r.plans[0].status).toBe("COMPLETED");
    expect(r.plans[0].actualDwellMinutes).toBe(27);
    expect(r.plans[0].departedAtElapsed).toBe(92);
    r = stopReducer(r.plans, { type: "resume", stopId: "s1", elapsed: 97 });
    expect(r.plans[0].status).toBe("RESUMED");
    // the meal category is NOT inferred as satisfied
    expect(r.plans[0].satisfiedNeeds).toEqual(["restroom"]);
  });

  it("satisfiedNeeds only from explicit action (select ignores pre-filled; autoAdvance never sets)", () => {
    const r = stopReducer([], { type: "select", plan: { ...proposed, satisfiedNeeds: ["meal"] } });
    expect(r.plans[0].satisfiedNeeds).toEqual([]);
    const a = autoAdvance(r.plans, [lead], 200, route);
    expect(a.plans[0].status).toBe("ARRIVED");
    expect(a.plans[0].satisfiedNeeds).toEqual([]);
  });

  it("rejects invalid transitions and returns the same array", () => {
    const sel = stopReducer([], { type: "select", plan: proposed }).plans;
    const bad = stopReducer(sel, { type: "complete", stopId: "s1", elapsed: 80, satisfiedNeeds: ["meal"] });
    expect(bad.error).toMatch(/invalid transition/);
    expect(bad.plans).toBe(sel);
    const arrived = stopReducer(stopReducer(sel, { type: "enRoute", stopId: "s1", elapsed: 50 }).plans, { type: "arrive", stopId: "s1", elapsed: 65 }).plans;
    expect(stopReducer(arrived, { type: "cancel", stopId: "s1" }).error).toBeDefined();
    expect(stopReducer(sel, { type: "cancel", stopId: "s1" }).plans[0].status).toBe("CANCELLED");
    expect(stopReducer(sel, { type: "arrive", stopId: "nope", elapsed: 1 }).error).toMatch(/unknown/);
  });

  it("only one active stop per car", () => {
    const sel = stopReducer([], { type: "select", plan: proposed }).plans;
    const second = stopReducer(sel, { type: "select", plan: plan({ stopId: "s2", status: "PROPOSED", participants: ["car_a", "car_b"] }) });
    expect(second.error).toMatch(/car_a/);
    const okB = stopReducer(sel, { type: "select", plan: plan({ stopId: "s2", status: "PROPOSED", participants: ["car_b"] }) });
    expect(okB.error).toBeUndefined();
    expect(stopReducer(okB.plans, { type: "setParticipants", stopId: "s2", carIds: ["car_a", "car_b"] }).error).toBeDefined();
  });

  it("autoAdvance derives EN_ROUTE then ARRIVED from the lead car's position", () => {
    const sel = stopReducer([], { type: "select", plan: plan({ status: "PROPOSED", participants: ["car_a", "car_b"] }) }).plans;
    expect(autoAdvance(sel, [lead, carB], 30, route).plans[0].status).toBe("SELECTED");
    const en = autoAdvance(sel, [lead, carB], 52, route);
    expect(en.plans[0].status).toBe("EN_ROUTE");
    const ar = autoAdvance(en.plans, [lead, carB], 70, route);
    expect(ar.plans[0].status).toBe("ARRIVED");
    expect(ar.plans[0].arrivedAtElapsed).toBeCloseTo(65, 6);
    // complete at 90 → actual dwell 25 → lead leaves at 90, back on road at 95
    const done = stopReducer(ar.plans, { type: "complete", stopId: "s1", elapsed: 90, satisfiedNeeds: ["meal"] }).plans;
    expect(carStateOnRoute(lead, 96, route, done).phase).toBe("driving");
    expect(arrivalElapsed(lead, route, done) - arrivalElapsed(lead, route, [])).toBeCloseTo(35, 6);
  });
});

// ------------------------------------------------------------------ context
describe("context builder", () => {
  const base = (over: Partial<AgentContextState> = {}): AgentContextState => ({
    elapsedMinutes: 60,
    localTime: "14:00",
    route: { totalKm: 250, remainingKm: 150, remainingMinutes: 90 },
    origin: { label: "Home, Toronto", lat: 43.65, lng: -79.38, type: "home", source: "search" },
    destination: { label: "Hotel, Kingston", lat: 44.23, lng: -76.5, type: "hotel", source: "search" },
    arrival: { local: "15:30", minutesFromNow: 90, sunsetLocal: "17:01", afterDark: false, minutesAfterSunset: -91 },
    cars: [lead, carB, carC].map((c, i) => ({
      id: c.id,
      label: c.label,
      role: c.role,
      adults: c.adults,
      kids: c.kids,
      dietary: i === 0 ? ["vegetarian"] : [],
      progressKm: 100 - i * 5,
      speedKph: c.speedKph,
      phase: "driving",
      positionUpdatedMinutesAgo: 0,
      needs: i === 1 ? ["coffee"] : [],
      recentUtterances: [
        "we left a bit late, sorry everyone, traffic was awful on the DVP this morning",
        "kids are getting restless in the back seat, maybe soon we stop somewhere nice",
        "can we find somewhere with good vegetarian food and clean washrooms please, thanks a lot",
        "actually make that coffee first, we are not that hungry yet but would love a drink"
      ]
    })),
    stops: [],
    mealHistory: { kind: "unknown" },
    drivingMinutesSinceRest: 60,
    mood: ["relaxed"],
    mealPreference: "auto",
    ...over
  });

  it("omits destination when nothing makes it relevant; unknown meal stays unknown", () => {
    const r = buildAgentContext(base());
    expect(r.context.destination).toBeUndefined();
    expect(r.context.origin).toBeUndefined();
    expect(r.includedBecause).toEqual([]);
    expect(r.context.lastMeal).toBe("unknown");
  });

  it("includes destination when arriving within 60 min", () => {
    const r = buildAgentContext(base({ arrival: { local: "14:50", minutesFromNow: 50, sunsetLocal: "17:01", afterDark: false, minutesAfterSunset: -131 } }));
    expect(r.context.destination).toBeDefined();
    expect(r.includedBecause.join()).toMatch(/within 60/);
  });

  it("includes destination when arrival is after or near sunset", () => {
    expect(buildAgentContext(base({ arrival: { local: "17:20", minutesFromNow: 200, sunsetLocal: "17:01", afterDark: true, minutesAfterSunset: 19 } })).context.destination).toBeDefined();
    expect(buildAgentContext(base({ arrival: { local: "16:30", minutesFromNow: 150, sunsetLocal: "17:01", afterDark: false, minutesAfterSunset: -31 } })).includedBecause.join()).toMatch(/sunset/);
  });

  it("includes destination for bad weather, long candidate delay, few food options", () => {
    expect(buildAgentContext(base({ weatherAtDestination: { condition: "snow", tempC: -2 } })).context.destination).toBeDefined();
    expect(buildAgentContext(base({ weatherAtDestination: { condition: "sunny", tempC: 15 } })).context.destination).toBeUndefined();
    expect(buildAgentContext(base({ candidateDelayMinutes: 25 })).context.destination).toBeDefined();
    expect(buildAgentContext(base({ candidateDelayMinutes: 15 })).context.destination).toBeUndefined();
    expect(buildAgentContext(base({ foodOptionsAhead: 1 })).context.destination).toBeDefined();
    expect(buildAgentContext(base({ foodOptionsAhead: 4 })).context.destination).toBeUndefined();
  });

  it("origin only in the first 15 min", () => {
    expect(buildAgentContext(base({ elapsedMinutes: 5 })).context.origin).toBeDefined();
    expect(buildAgentContext(base({ elapsedMinutes: 20 })).context.origin).toBeUndefined();
  });

  it("uses confirmed stops for history, caps utterances at 2, stays small", () => {
    const stops = [plan({ status: "RESUMED", arrivedAtElapsed: 30, departedAtElapsed: 50, actualDwellMinutes: 20, satisfiedNeeds: ["meal"] })];
    const r = buildAgentContext(base({ stops, weatherAtDestination: { condition: "rain", tempC: 4 }, foodOptionsAhead: 1, elapsedMinutes: 120 }));
    expect(r.context.lastMeal).toEqual({ at: "Stop One", minAgo: 70 });
    const cars = r.context.cars as Array<{ said?: string[]; stable: unknown; now: unknown; needs: unknown }>;
    expect(cars.every((c) => (c.said ?? []).length <= 2)).toBe(true);
    expect(cars[0].stable).toBeDefined();
    expect(JSON.stringify(r.context).length).toBeLessThan(2500);
  });
});
