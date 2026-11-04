import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateUrgency } from "@/lib/domain/urgency";
import { EMPTY_MEMORY, watch, type WatchInput } from "@/lib/domain/watcher";
import { decideWithExploration, dietFit, evaluateCandidates } from "@/lib/domain/engine";
import { runTactical, tacticalDecisionSchema, toLlmDecision, tacticalUserPayload } from "@/lib/agent2/tactical";
import { checkTacticalStaleness } from "@/lib/agent2/staleness";
import { percentile, summarize, versionHash } from "@/lib/agent2/metrics";
import { MockPlaceProvider } from "@/lib/providers/places";
import type { CarState, CollectiveIntent, EligibleStop, RecommendStopsRequest, StopCandidate } from "@/lib/domain/types";

/* ---------- helpers ---------- */
const trip = { elapsedMinutes: 8, localTime: "10:23", minutesSinceLastStop: 8, lastMealMinutesAgo: null as number | null };
function stop(id: string, km: number, cats: StopCandidate["categories"], extra: Partial<StopCandidate> = {}): StopCandidate {
  return {
    id,
    name: id,
    type: "restaurant",
    categories: cats,
    region: "",
    exitId: `x-${km}`,
    distanceAlongRouteKm: km,
    lat: 43,
    lng: -79,
    isMock: false,
    source: "osm",
    vegetarianVerified: null,
    restroomsVerified: null,
    parkingVerified: null,
    qualityScoreMock: 0.6,
    open24h: false,
    accessMinutes: 4,
    ...extra
  };
}
function car(over: Partial<CarState> = {}): CarState {
  return { id: "car_a", label: "Car A", role: "lead", progressKm: 12, speedKph: 100, passengers: 4, kids: true, ev: false, positionUpdatedMinutesAgo: 0, needs: [], ...over };
}
function request(over: Partial<RecommendStopsRequest> = {}, intent: Partial<CollectiveIntent> = {}): RecommendStopsRequest {
  return {
    trip: { destination: "Letchworth", direction: "toward destination", highway: "route", elapsedMinutes: 90, localTime: "11:45", minutesSinceLastStop: 90, lastMealMinutesAgo: null },
    config: { avoidRegion: null, noOptionalStopsFirstMinutes: 30, maximumDetourMinutesPerCar: 12, maximumRegroupWaitMinutes: 20, advanceNoticeMinutes: 10, requiredDiet: [], groceriesCompleted: true, passengerLed: true },
    cars: [car({ progressKm: 100 })],
    collectiveIntent: { need: [], hungerLevel: 0, dietary: [], maxDetourMinutes: 12, kids: true, ...intent },
    environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300 },
    ...over
  };
}
const providerOf = (stops: StopCandidate[]) => ({ name: "test", isMock: false, getCandidates: async (_p: string, o: { minKm: number; maxKm: number }) => stops.filter((s) => s.distanceAlongRouteKm >= o.minKm && s.distanceAlongRouteKm <= o.maxKm) });

function watchIn(over: Partial<WatchInput>): WatchInput {
  return {
    elapsedMinutes: 8,
    lead: { id: "car_a", progressKm: 12, speedKph: 100 },
    urgency: evaluateUrgency({ needs: [], hungerLevel: 0, kids: true }, { ...trip, localTime: "12:00", elapsedMinutes: 95, mood: ["hungry"] }),
    stops: [stop("near_diner", 40, ["meal", "restroom"]), stop("next_diner", 50, ["meal"])],
    advanceNoticeMinutes: 10,
    routeTotalKm: 234,
    excludedStopIds: [],
    confirmedStopPending: false,
    departureQuiet: { untilElapsed: 30, reason: "just left home" },
    memory: EMPTY_MEMORY,
    ...over
  };
}

/* ---------- home departure ---------- */
describe("home departure quiet window", () => {
  it("does not call Agent 2 for a routine meal-time reminder right after leaving home", () => {
    const d = watch(watchIn({}));
    expect(d.shouldCall).toBe(false);
    expect(d.reasons.join(" ")).toMatch(/just left home/);
  });
  it("an explicit passenger request overrides the quiet window", () => {
    const u = evaluateUrgency({ needs: ["coffee"], hungerLevel: 0, kids: false }, { ...trip });
    const d = watch(watchIn({ urgency: u, stops: [stop("cafe", 30, ["coffee"])] }));
    expect(d.shouldCall).toBe(true);
  });
  it("urgent restroom overrides the quiet window", () => {
    const u = evaluateUrgency({ needs: [], hungerLevel: 0, restroomUrgent: true, kids: true }, { ...trip });
    expect(watch(watchIn({ urgency: u })).shouldCall).toBe(true);
  });
  it("the last suitable stop before a long gap overrides the quiet window", () => {
    const d = watch(watchIn({ stops: [stop("last_good", 40, ["meal", "restroom"]), stop("far", 180, ["meal"])] }));
    expect(d.shouldCall).toBe(true);
    expect(d.overrideInitialQuiet).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/last suitable stop before a \d+ km gap/);
  });
  it("after the window, normal behaviour resumes (no fixed radius ban)", () => {
    const d = watch(watchIn({ elapsedMinutes: 31, lead: { id: "car_a", progressKm: 22, speedKph: 100 } }));
    expect(d.reasons.join(" ")).not.toMatch(/just left home/);
  });
  it("engine: routine stops in the early window are held, explicit ones are not", () => {
    const early = { ...request().trip, elapsedMinutes: 10 };
    const s = [stop("diner", 40, ["meal", "restroom"])];
    const routine = evaluateCandidates(s, [car()], { need: [], hungerLevel: 1, dietary: [], maxDetourMinutes: 12, kids: true }, request().config, early, request().environment);
    expect(routine.rejected[0]?.reasons.join(" ")).toMatch(/no-optional-stops window/);
    const overridden = evaluateCandidates(s, [car()], { need: [], hungerLevel: 1, dietary: [], maxDetourMinutes: 12, kids: true }, request().config, { ...early, overrideInitialQuiet: true }, request().environment);
    expect(overridden.eligible.map((e) => e.stop.id)).toContain("diner");
  });
});

/* ---------- flexible place suitability ---------- */
describe("flexible restroom and quick-bite matching", () => {
  const gas = stop("petro", 140, ["restroom"], { type: "fuel", evidence: { restroom: { level: "possible", source: "chain-level typical" }, service: "fuel" } });
  const steak = stop("bar_grill", 145, ["meal", "restroom"], { evidence: { service: "sit_down" } });
  it("a non-urgent restroom need can be served by a gas station — no restaurant required", async () => {
    const r = await decideWithExploration(request({}, { need: ["restroom"] }), providerOf([gas]), "mock", true);
    expect(r.recommendations.map((x) => x.stopId)).toContain("petro");
  });
  it("coffee + quick bite prefers a place that covers both", async () => {
    const timmies = stop("tim_hortons", 150, ["coffee", "meal", "restroom"], { brand: "Tim Hortons", evidence: { service: "quick_service" } });
    const cafeOnly = stop("cafe_only", 135, ["coffee"]);
    const r = await decideWithExploration(request({}, { need: ["coffee", "meal"], hungerLevel: 1 }), providerOf([cafeOnly, timmies, steak]), "mock", true);
    expect(r.recommendations[0].stopId).toBe("tim_hortons");
  });
  it("bar-and-grill and gas stations are not universally banned", async () => {
    const r = await decideWithExploration(request({}, { need: ["meal"], hungerLevel: 2 }), providerOf([steak]), "mock", true);
    expect(r.recommendations.map((x) => x.stopId)).toContain("bar_grill");
  });
});

/* ---------- dietary evidence ---------- */
describe("dietary evidence levels", () => {
  it("unknown evidence is not treated as verified", () => {
    const f = dietFit(stop("x", 10, ["meal"]), ["vegetarian"], ["meal"]);
    expect(f.ok).toBe(true);
    expect(f.note ?? "").not.toMatch(/verified \(/);
    expect(f.note ?? "").toMatch(/unverified|likely/);
  });
  it("chain-level 'possible' is labelled possible, not verified", () => {
    const f = dietFit(stop("subway", 10, ["meal"], { evidence: { vegetarian: { level: "possible", source: "chain's official menu" } } }), ["vegetarian"], ["meal"]);
    expect(f.note).toMatch(/possible/);
    expect(f.note).toMatch(/not verified/);
  });
  it("explicit OSM diet tag is verified; unsuitable is rejected", () => {
    expect(dietFit(stop("v", 10, ["meal"], { evidence: { vegetarian: { level: "verified", source: "osm:diet:vegetarian=yes" } } }), ["vegetarian"], ["meal"]).note).toMatch(/verified/);
    expect(dietFit(stop("s", 10, ["meal"], { evidence: { vegan: { level: "unsuitable", source: "osm:cuisine=steak_house" } } }), ["vegan"], ["meal"]).ok).toBe(false);
  });
  it("halal requires verified evidence", () => {
    expect(dietFit(stop("h", 10, ["meal"], { evidence: { halal: { level: "possible", source: "x" } } }), ["halal"], ["meal"]).ok).toBe(false);
    expect(dietFit(stop("h2", 10, ["meal"], { evidence: { halal: { level: "verified", source: "osm:diet:halal=yes" } } }), ["halal"], ["meal"]).ok).toBe(true);
  });
});

/* ---------- Tactical workflow ---------- */
function eligibleFor(stops: StopCandidate[]): EligibleStop[] {
  return evaluateCandidates(stops, [car({ progressKm: 100 })], { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: true }, request().config, request().trip, request().environment).eligible;
}
const baseCtx = () => {
  const r = request({}, { need: ["meal"], hungerLevel: 2 });
  return { trip: r.trip, config: r.config, cars: r.cars, intent: r.collectiveIntent, environment: r.environment, rejected: [], triggerReasons: ["hungry"], eligible: eligibleFor([stop("a", 130, ["meal"]), stop("b", 150, ["meal", "coffee"])]) };
};

describe("Tactical decision workflow", () => {
  it("valid structured Muse output is mapped to a decision", async () => {
    const muse = vi.fn(async () => ({ ok: true as const, ms: 1800, usage: {}, value: { decision: "RECOMMEND" as const, picks: [{ stopId: "b", reason: "covers lunch and coffee", tradeoffs: ["2 min farther"] }], headline: "Lunch at b in 30 min", evidenceRefs: [] } }));
    const r = await runTactical(baseCtx(), { muse: muse as never });
    expect(r.meta.status).toBe("muse");
    expect(r.llm?.action).toBe("PROPOSE_STOP");
    expect(r.llm?.picks[0].stopId).toBe("b");
    expect((muse.mock.calls[0] as unknown[])[0]).toMatchObject({ effort: "minimal", deadlineMs: 5000, schemaName: "tactical_decision" });
  });
  it("deadline exceeded → deterministic fallback, never an unvalidated pick", async () => {
    const muse = vi.fn(async () => ({ ok: false as const, reason: "timeout" as const, detail: "5000 ms", ms: 5001 }));
    const r = await runTactical(baseCtx(), { muse: muse as never });
    expect(r.meta.status).toBe("timeout");
    expect(r.llm).toBeNull();
  });
  it("invalid output → fallback", async () => {
    const r = await runTactical(baseCtx(), { muse: (async () => ({ ok: false, reason: "invalid", detail: "schema", ms: 900 })) as never });
    expect(r.meta.status).toBe("invalid");
  });
  it("no candidates → no Muse call", async () => {
    const muse = vi.fn();
    const r = await runTactical({ ...baseCtx(), eligible: [] }, { muse: muse as never });
    expect(muse).not.toHaveBeenCalled();
    expect(r.meta.status).toBe("fallback");
  });
  it("hallucinated stop ids from the model are dropped by the deterministic engine", async () => {
    const res = await decideWithExploration(request({}, { need: ["meal"], hungerLevel: 2 }), providerOf([stop("real_one", 130, ["meal"])]), "muse", false, async () =>
      toLlmDecision({ decision: "RECOMMEND", picks: [{ stopId: "invented", reason: "x", tradeoffs: [] }], headline: "", evidenceRefs: [] })
    );
    expect(res.recommendations.map((r) => r.stopId)).toEqual(["real_one"]);
  });
  it("explicit urgent need overrides strategic hints (urgency stays high, nearest-first)", async () => {
    const res = await decideWithExploration(
      request({}, { need: ["restroom"], restroomUrgent: true }),
      providerOf([stop("near", 125, ["restroom"], { evidence: { restroom: { level: "verified", source: "osm" } } }), stop("planned_lunch", 160, ["meal", "restroom"])]),
      "mock",
      true
    );
    expect(res.urgency?.level).toBe("high");
    expect(res.recommendations[0].stopId).toBe("near");
  });
  it("prompt is compact and question-based", () => {
    const payload = tacticalUserPayload({ ...baseCtx(), strategicHints: [{ id: "o1", kind: "meal", title: "Lunch before border", fromKm: 120, toKm: 140, candidateIds: ["a"], priority: "high" }] });
    expect(payload.length).toBeLessThan(3000);
    expect(JSON.parse(payload).strategicHints).toHaveLength(1);
    expect(tacticalDecisionSchema.safeParse({ decision: "MAYBE", picks: [], headline: "", evidenceRefs: [] }).success).toBe(false);
  });
});

/* ---------- staleness + metrics ---------- */
describe("stale tactical results", () => {
  const r = { recommendations: [{ stopId: "a", rank: 1 }, { stopId: "b", rank: 2 }], recommendedStops: [{ id: "a", distanceAlongRouteKm: 120 }, { id: "b", distanceAlongRouteKm: 160 }], decidedFor: { contextVersion: "v1" } };
  it("context changed → stale", () => expect(checkTacticalStaleness(r, "v2", 100, 16)).toEqual({ stale: true, reason: "context_changed" }));
  it("car passed the exits while waiting → stale", () => expect(checkTacticalStaleness(r, "v1", 150, 16)).toEqual({ stale: true, reason: "exits_passed" }));
  it("partially passed → keep only reachable", () => expect(checkTacticalStaleness(r, "v1", 110, 16)).toEqual({ stale: false, keepStopIds: ["b"], dropped: ["a"] }));
  it("fresh → keep all", () => expect(checkTacticalStaleness(r, "v1", 90, 16)).toEqual({ stale: false, keepStopIds: ["a", "b"], dropped: [] }));
});

describe("metrics", () => {
  it("percentiles and target share", () => {
    const now = Date.now();
    const s = [1000, 2000, 3000, 4000, 9000].map((ms, i) => ({ ms, status: i === 4 ? "timeout" : "muse", at: now }));
    expect(percentile(s.map((x) => x.ms), 50)).toBe(3000);
    expect(summarize(s, 5000)).toMatchObject({ count: 5, p50: 3000, p95: 9000, withinTargetPct: 80, fallbackPct: 20, timeoutPct: 20 });
  });
  it("version hash is stable and sensitive", () => {
    expect(versionHash({ a: 1 })).toBe(versionHash({ a: 1 }));
    expect(versionHash({ a: 1 })).not.toBe(versionHash({ a: 2 }));
  });
});

/* ---------- regression: legacy demo still decides with fixtures ---------- */
describe("compatibility", () => {
  it("classic fixture path still works (1–3 cars)", async () => {
    const cars = [car({ progressKm: 180 }), car({ id: "car_b", role: "passenger", progressKm: 175, kids: false }), car({ id: "car_c", role: "passenger", progressKm: 170, kids: false })];
    const r = await decideWithExploration(request({ cars, trip: { ...request().trip, elapsedMinutes: 150, localTime: "12:00" } }, { need: ["meal"], hungerLevel: 2 }), new MockPlaceProvider(), "mock", true);
    expect(r.action).toBe("PROPOSE_STOP");
    expect(Object.keys(r.recommendations[0].detourMinutesByCar)).toHaveLength(3);
  });
});

/* ---------- border detection fallback (no Overpass) ---------- */
describe("country-change border fallback", () => {
  beforeEach(() => {
    vi.stubEnv("UNCONGEST_MODE", "full-live");
    vi.stubEnv("BORDER_LOOKUP", "1");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const { resetBudgets } = await import("@/lib/providers/budget");
    resetBudgets();
  });
  it("locates a CA→US crossing by binary search and never invents one for same-country trips", async () => {
    const { countryChangeCrossing } = await import("@/lib/providers/routing");
    const { clearGeocodeCache } = await import("@/lib/providers/geocode");
    const { resetBudgets } = await import("@/lib/providers/budget");
    clearGeocodeCache();
    resetBudgets();
    const coords: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i++) coords.push([-79.6 + i * 0.03, 43.2 - i * 0.005]); // ~100 km eastward
    const route = { id: "b1", origin: { label: "a", lat: 43.2, lng: -79.6, type: "other" as const, source: "search" as const }, destination: { label: "b", lat: 43, lng: -78.4, type: "other" as const, source: "search" as const }, coordinates: coords, exits: [], exitsStatus: "pending" as const, borderCrossings: [], alternatives: [], distanceKm: 100, durationMinutes: 70, source: "osrm" as const, timezone: "America/Toronto", fetchedAt: "x", attribution: "x" };
    // border at lng -79.0 (≈ km 49)
    const fetchImpl = (async (url: string) => {
      const lon = Number(new URL(url).searchParams.get("lon"));
      return new Response(JSON.stringify({ address: { country_code: lon < -79.0 ? "ca" : "us" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const found = await countryChangeCrossing(route, { fetchImpl });
    expect(found).toHaveLength(1);
    expect(found[0].name).toMatch(/CA → US/);
    expect(Math.abs(found[0].km - 49)).toBeLessThan(4);
    const same = (async () => new Response(JSON.stringify({ address: { country_code: "ca" } }), { status: 200 })) as unknown as typeof fetch;
    clearGeocodeCache();
    expect(await countryChangeCrossing({ ...route, id: "b2" }, { fetchImpl: same })).toEqual([]);
  }, 30000);
});
