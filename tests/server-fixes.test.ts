import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideWithExploration, dietFit, evaluateCandidates } from "@/lib/domain/engine";
import { reconcileTactical, type TacticalDecision } from "@/lib/agent2/tactical";
import type { CarState, Need, RecommendStopsRequest, StopCandidate } from "@/lib/domain/types";
import type { PlaceProvider } from "@/lib/providers/places";
import { TORONTO_MONTREAL } from "@/lib/route/route";

// The route calls runTactical; replace it with a controllable stub (never calls Muse live).
const tacticalStub = vi.hoisted(() => ({ impl: null as null | ((ctx: unknown, deps?: { deadlineMs?: number }) => Promise<unknown>) }));
vi.mock("@/lib/agent2/tactical", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/agent2/tactical")>();
  return { ...mod, runTactical: (ctx: unknown, deps?: { deadlineMs?: number }) => tacticalStub.impl!(ctx, deps) };
});
import { POST } from "@/app/api/recommend-stops/route";
import { toLlmDecision } from "@/lib/agent2/tactical";

function car(over: Partial<CarState> = {}): CarState {
  return { id: "car_a", label: "Car A", role: "lead", progressKm: 100, speedKph: 100, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: [], ...over };
}

function request(over: Partial<RecommendStopsRequest> = {}, intent: Partial<RecommendStopsRequest["collectiveIntent"]> = {}): RecommendStopsRequest {
  return {
    trip: { destination: "Montréal", direction: "eastbound", highway: "401", elapsedMinutes: 150, localTime: "16:00", minutesSinceLastStop: 60, lastMealMinutesAgo: null },
    config: { avoidRegion: "GTA", noOptionalStopsFirstMinutes: 60, maximumDetourMinutesPerCar: 12, maximumRegroupWaitMinutes: 15, advanceNoticeMinutes: 10, requiredDiet: [], groceriesCompleted: true, passengerLed: true },
    cars: [car()],
    collectiveIntent: { need: [], hungerLevel: 0, dietary: [], maxDetourMinutes: 12, kids: false, ...intent },
    environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300 },
    ...over
  };
}

function stop(id: string, km: number, categories: StopCandidate["categories"], over: Partial<StopCandidate> = {}): StopCandidate {
  return {
    id,
    name: id,
    exitId: `exit_${id}`,
    exitLabel: `Exit ${km}`,
    distanceAlongRouteKm: km,
    lat: 44,
    lng: -78,
    region: "EAST",
    type: "restaurant",
    categories,
    accessMinutes: 3,
    open24h: true,
    restroomsVerified: true,
    qualityScoreMock: 0.8,
    isMock: true,
    ...over
  } as StopCandidate;
}

const providerOf = (stops: StopCandidate[]): PlaceProvider => ({ name: "test", isMock: true, getCandidates: async () => stops });

describe("tactical reconciliation (Muse vs engine)", () => {
  const d = (decision: TacticalDecision["decision"], picks: string[] = []): TacticalDecision => ({
    decision,
    picks: picks.map((stopId) => ({ stopId, reason: "r", tradeoffs: [] })),
    headline: "Nothing suitable nearby",
    evidenceRefs: []
  });

  it("SEARCH_FARTHER ignored by the engine at moderate urgency → overridden, decision consistent with the action", () => {
    const r = reconcileTactical(d("SEARCH_FARTHER"), { action: "PROPOSE_STOP", recommendations: [{ stopId: "a" }] });
    expect(r.overridden).toBe(true);
    if (r.overridden) expect(r.decision).toBe("RECOMMEND");
  });
  it("RECOMMEND whose picks all failed validation → overridden", () => {
    expect(reconcileTactical(d("RECOMMEND", ["ghost"]), { action: "PROPOSE_STOP", recommendations: [{ stopId: "a" }] }).overridden).toBe(true);
  });
  it("accepted picks / honoured STAY_SILENT → not overridden", () => {
    expect(reconcileTactical(d("RECOMMEND", ["a", "ghost"]), { action: "PROPOSE_STOP", recommendations: [{ stopId: "a" }] }).overridden).toBe(false);
    expect(reconcileTactical(d("STAY_SILENT"), { action: "STAY_SILENT", recommendations: [] }).overridden).toBe(false);
  });
});

describe("engine: no model call without a trigger", () => {
  it("never calls the resolver when there is no active need", async () => {
    const spy = vi.fn(async () => ({ action: "PROPOSE_STOP", picks: [{ stopId: "s1", reason: "x", tradeoffs: [] }] }));
    const r = await decideWithExploration(request(), providerOf([stop("s1", 130, ["meal", "restroom"])]), "m", false, spy);
    expect(r.triggerReasons).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(r.action).toBe("STAY_SILENT");
  });
});

describe("engine: inferred meal reminder vs explicit restroom request", () => {
  // 12:40, 120 min in, no meal history → urgency adds an inferred "meal".
  const lunch = { ...request().trip, localTime: "12:40", elapsedMinutes: 120 };
  const plaza = stop("plaza", 130, ["restroom", "meal", "coffee"], { type: "highway-plaza" });
  const diner = stop("diner", 132, ["meal"]);
  const restArea = stop("rest", 128, ["restroom"]);

  it("a halal group asking only for a restroom keeps the unverified plaza eligible", async () => {
    const r = await decideWithExploration(request({ trip: lunch }, { need: ["restroom"], dietary: ["halal"] }), providerOf([plaza, diner]), "mock", true);
    const ids = r.recommendations.map((x) => x.stopId);
    expect(ids).toContain("plaza");
    expect(r.rejected.find((x) => x.stopId === "plaza")?.reasons.join(" ")).toMatch(/not recommended for a meal/);
  });

  it("explicit restroom need is not outweighed by the inferred meal (single-need weight)", () => {
    const evalIntent = { need: ["restroom", "meal"] as Need[], hungerLevel: 0 as const, dietary: [], maxDetourMinutes: 12, kids: false };
    const { eligible } = evaluateCandidates([restArea, diner, plaza], [car()], evalIntent, request().config, lunch, request().environment, ["meal"]);
    const by = Object.fromEntries(eligible.map((e) => [e.stop.id, e]));
    expect(by.rest.scoreBreakdown.unmetNeeds).toBe(0);
    expect(by.rest.score).toBeGreaterThan(by.diner.score);
  });

  it("an explicit meal request still hard-rejects unverified halal", () => {
    const { eligible, rejected } = evaluateCandidates([plaza], [car()], { need: ["meal"], hungerLevel: 0, dietary: ["halal"], maxDetourMinutes: 12, kids: false }, request().config, lunch, request().environment);
    expect(eligible).toHaveLength(0);
    expect(rejected[0].reasons.join(" ")).toMatch(/halal/);
  });
});

describe("engine: early-trip quiet window holds inferred-only needs", () => {
  const meal = stop("m1", 130, ["meal", "restroom"]);
  const early = { ...request().trip, elapsedMinutes: 100, localTime: "12:40" }; // lunch reminder fires (elapsed ≥ 90)
  const cfg = { ...request().config, noOptionalStopsFirstMinutes: 120 };

  it("reminder-only meal is held inside the window", async () => {
    const r = await decideWithExploration(request({ trip: early, config: cfg }), providerOf([meal]), "mock", true);
    expect(r.recommendations).toHaveLength(0);
    expect(r.rejected.find((x) => x.stopId === "m1")?.reasons.join(" ")).toMatch(/no-optional-stops window/);
  });
  it("trip.overrideInitialQuiet lets it through", async () => {
    const r = await decideWithExploration(request({ trip: { ...early, overrideInitialQuiet: true }, config: cfg }), providerOf([meal]), "mock", true);
    expect(r.recommendations.map((x) => x.stopId)).toContain("m1");
  });
  it("an explicit need still bypasses the window", async () => {
    const r = await decideWithExploration(request({ trip: early, config: cfg }, { need: ["restroom"] }), providerOf([meal]), "mock", true);
    expect(r.recommendations.map((x) => x.stopId)).toContain("m1");
  });
});

describe("engine: diet evidence + need dedupe", () => {
  it("vegan request respects vegetarian=unsuitable evidence", () => {
    const s = stop("v", 130, ["meal"], {
      vegOptions: "some",
      evidence: { vegetarian: { level: "unsuitable", source: "osm:diet:vegetarian=no" }, vegan: { level: "unknown", source: "none" } }
    } as Partial<StopCandidate>);
    const r = dietFit(s, ["vegan"], ["meal"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/vegetarian-suitable/);
  });

  it("hungerLevel 3 + need meal uses the single-need weight (no duplicate 'meal')", () => {
    const coffee = stop("c", 130, ["coffee"], { qualityScoreMock: 1, accessMinutes: 0 });
    const intent = { need: ["meal"] as Need[], hungerLevel: 3 as const, dietary: [], maxDetourMinutes: 12, kids: false };
    const { eligible } = evaluateCandidates([coffee], [car()], intent, request().config, request().trip, request().environment);
    // 1 - 0.15 * unmetNorm(1) - 0.05 * fatigue(60/180); with a duplicated "meal" the weight would be 0.35.
    expect(eligible[0].score).toBeCloseTo(1 - 0.15 - 0.05 * (60 / 180), 5);
  });
});

describe("route: tactical labelling + whole-request deadline", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AI_PROVIDER = "mock";
    process.env.TACTICAL_DEADLINE_MS = "5000";
  });
  afterEach(() => {
    process.env = { ...env };
    tacticalStub.impl = null;
    vi.unstubAllGlobals();
  });

  const tacticalBody = (weatherMode: "live" | "simulated") => {
    const r = request({ trip: { ...request().trip, localDate: "2026-11-03" } }, { need: ["meal"], hungerLevel: 2 });
    return {
      ...r,
      cars: [car({ progressKm: 180 })],
      options: { weatherMode, excludeStopIds: [] },
      context: {
        route: { id: TORONTO_MONTREAL.id, origin: { label: "Toronto", lat: 43.65, lng: -79.38 }, destination: { label: "Montréal", lat: 45.5, lng: -73.57 } },
        dataMode: "demo",
        workflow: "tactical"
      }
    };
  };
  const post = (body: unknown) => POST(new Request("http://x/api/recommend-stops", { method: "POST", body: JSON.stringify(body) }));

  it("Muse SEARCH_FARTHER at moderate urgency is reported as an engine override, without its headline", async () => {
    const decision: TacticalDecision = { decision: "SEARCH_FARTHER", picks: [], headline: "Nothing suitable nearby", evidenceRefs: [] };
    tacticalStub.impl = async () => ({ decision, llm: toLlmDecision(decision), meta: { status: "muse", provider: "muse tactical", ms: 10, decision: decision.decision, headline: decision.headline } });
    const json = await (await post(tacticalBody("simulated"))).json();
    expect(json.urgency.level).toBe("moderate");
    expect(json.action).toBe("PROPOSE_STOP");
    expect(json.tactical.status).not.toBe("muse");
    expect(json.tactical.status).toBe("overridden");
    expect(json.tactical.decision).toBe("RECOMMEND");
    expect(json.tactical.museDecision).toBe("SEARCH_FARTHER");
    expect(json.tactical.headline).toBeUndefined();
    expect(json.speakMessage).toBeUndefined();
    expect(json.provider).toMatch(/override/);
  });

  it("a hung live weather service cannot push the Tactical decision past its budget", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    let seenDeadline = Infinity;
    tacticalStub.impl = async (_ctx, deps) => {
      seenDeadline = deps?.deadlineMs ?? Infinity;
      return { decision: null, llm: null, meta: { status: "timeout", provider: "deterministic fallback", ms: 0 } };
    };
    const t0 = Date.now();
    const json = await (await post(tacticalBody("live"))).json();
    const took = Date.now() - t0;
    expect(seenDeadline).toBeLessThan(5000);
    expect(seenDeadline).toBeGreaterThanOrEqual(1500);
    // car weather ≤1.5 s + stop weather ≤1.5 s; Muse would get the remaining ~2 s.
    expect(took).toBeLessThan(5000);
    expect(json.weather.cars[0].source).not.toBe("open-meteo");
    expect(json.exploration.join(" ")).toMatch(/timed out|unavailable|simulated/);
  }, 10_000);
});
