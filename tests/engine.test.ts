import { describe, it, expect } from "vitest";
import stopsFixture from "@/data/stops/highway-401.mock.json";
import { evaluateCandidates, deriveTriggerReasons, decide, buildRecommendations, isOpenAt } from "@/lib/domain/engine";
import { parseIntent, mergeCollectiveIntent } from "@/lib/domain/intent";
import type { CarState, CollectiveIntent, StopCandidate, TripConfig, TripContext, Environment, RecommendStopsRequest } from "@/lib/domain/types";

const stops = (stopsFixture as { stops: StopCandidate[] }).stops;

const baseConfig: TripConfig = {
  avoidRegion: "GTA",
  noOptionalStopsFirstMinutes: 60,
  maximumDetourMinutesPerCar: 12,
  maximumRegroupWaitMinutes: 15,
  advanceNoticeMinutes: 10,
  requiredDiet: ["vegetarian"],
  groceriesCompleted: false,
  passengerLed: true
};

const baseTrip: TripContext = {
  destination: "Montréal",
  direction: "eastbound",
  highway: "401",
  elapsedMinutes: 125,
  localTime: "17:10"
};

const baseEnv: Environment = { weather: "sunny", trafficDelayMinutes: 10, daylightMinutes: 95 };

function makeCars(): CarState[] {
  return [
    { id: "car_a", label: "Car A", role: "lead", progressKm: 150, speedKph: 100, passengers: 3, kids: true, ev: false, positionUpdatedMinutesAgo: 0, needs: ["restroom"] },
    { id: "car_b", label: "Car B", role: "passenger", progressKm: 145, speedKph: 98, passengers: 2, kids: false, ev: true, connector: "NACS", batteryPercent: 24, positionUpdatedMinutesAgo: 0, needs: ["meal"] },
    { id: "car_c", label: "Car C", role: "passenger", progressKm: 140, speedKph: 95, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: [] }
  ];
}

const hungryIntent: CollectiveIntent = {
  need: ["meal", "restroom"],
  hungerLevel: 3,
  dietary: ["vegetarian"],
  maxDetourMinutes: 12,
  kids: true
};

describe("intent parsing", () => {
  it("parses needs, hunger and dietary from freeform chat", () => {
    const p = parseIntent("all very hungry, kids need washrooms, vegetarian please");
    expect(p.needs).toContain("meal");
    expect(p.needs).toContain("restroom");
    expect(p.hungerLevel).toBe(3);
    expect(p.dietary).toContain("vegetarian");
  });

  it("detects EV charge intent", () => {
    expect(parseIntent("car B needs an EV charge and lunch").needs).toEqual(expect.arrayContaining(["ev_charge", "meal"]));
  });

  it("preserves saved preferences and merges new ones", () => {
    const saved: CollectiveIntent = { need: ["coffee"], hungerLevel: 1, dietary: [], maxDetourMinutes: 12, kids: false };
    const merged = mergeCollectiveIntent(parseIntent("very hungry"), saved);
    expect(merged.need).toContain("coffee");
    expect(merged.hungerLevel).toBe(3);
  });
});

describe("eligibility", () => {
  it("excludes GTA stops per config", () => {
    const { rejected } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, baseEnv);
    const gta = rejected.find((r) => r.stopId === "gta_plaza_demo");
    expect(gta?.reasons.join(" ")).toMatch(/excluded region/);
  });

  it("enforces vegetarian hard rule", () => {
    const { eligible, rejected } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, baseEnv);
    expect(eligible.find((e) => e.stop.id === "hwy_plaza_demo")).toBeUndefined();
    expect(rejected.find((r) => r.stopId === "hwy_plaza_demo")?.reasons.join(" ")).toMatch(/dietary/);
    expect(eligible.map((e) => e.stop.id)).toContain("veg_cafe_demo");
  });

  it("rejects exits with insufficient lead time", () => {
    const cars = makeCars();
    cars[0].progressKm = 200; // veg_cafe_demo at 205 km => 3 min ahead < 10 min notice
    const { rejected } = evaluateCandidates(stops, cars, hungryIntent, baseConfig, baseTrip, baseEnv);
    expect(rejected.find((r) => r.stopId === "veg_cafe_demo")?.reasons.join(" ")).toMatch(/lead time/);
  });

  it("rejects stops already passed", () => {
    const cars = makeCars();
    cars[0].progressKm = 260;
    const { rejected } = evaluateCandidates(stops, cars, hungryIntent, baseConfig, baseTrip, baseEnv);
    expect(rejected.find((r) => r.stopId === "veg_cafe_demo")?.reasons.join(" ")).toMatch(/passed/);
  });

  it("enforces EV charger compatibility", () => {
    const evIntent: CollectiveIntent = { ...hungryIntent, need: ["ev_charge", "meal"] };
    const { eligible, rejected } = evaluateCandidates(stops, makeCars(), evIntent, baseConfig, baseTrip, baseEnv);
    expect(eligible.map((e) => e.stop.id)).toContain("ev_bundle_demo");
    expect(rejected.find((r) => r.stopId === "veg_cafe_demo")?.reasons.join(" ")).toMatch(/charger/);
  });

  it("shrinks detour tolerance in poor weather", () => {
    const rainy: Environment = { weather: "rain", trafficDelayMinutes: 10, daylightMinutes: 95 };
    const { eligible } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, rainy);
    expect(eligible.find((e) => e.stop.id === "veg_cafe_demo")).toBeUndefined();
  });

  it("computes per-car arrivals and group wait", () => {
    const { eligible } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, baseEnv);
    const veg = eligible.find((e) => e.stop.id === "veg_cafe_demo");
    expect(veg).toBeDefined();
    expect(veg!.arrivalMinutesFromNowByCar.car_c).toBeGreaterThan(veg!.arrivalMinutesFromNowByCar.car_a);
    expect(veg!.maxGroupWaitMinutes).toBeGreaterThan(0);
  });

  it("flags stale positions", () => {
    const cars = makeCars();
    cars[1].positionUpdatedMinutesAgo = 10;
    const { rejected } = evaluateCandidates(stops, cars, hungryIntent, baseConfig, baseTrip, baseEnv);
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected.every((r) => r.reasons.join(" ").match(/stale/))).toBe(true);
  });

  it("no-optional-stops window suppresses early stops unless urgent", () => {
    const earlyTrip = { ...baseTrip, elapsedMinutes: 20 };
    const mild: CollectiveIntent = { ...hungryIntent, hungerLevel: 1 };
    const { rejected } = evaluateCandidates(stops, makeCars(), mild, baseConfig, earlyTrip, baseEnv);
    expect(rejected.length).toBeGreaterThan(0);
  });
});

describe("opening hours", () => {
  it("closed diner rejected at 17:10 ETA is open, but closed at 19:00", () => {
    const diner = stops.find((s) => s.id === "late_diner_demo")!;
    expect(isOpenAt(diner, "17:10").open).toBe(true);
    expect(isOpenAt(diner, "19:00").open).toBe(false);
  });
});

describe("decision pipeline", () => {
  function request(intent: CollectiveIntent, env: Environment = baseEnv): RecommendStopsRequest {
    return { trip: baseTrip, config: baseConfig, cars: makeCars(), collectiveIntent: intent, environment: env };
  }

  it("STAY_SILENT when no trigger", () => {
    const calm: CollectiveIntent = { need: [], hungerLevel: 0, dietary: ["vegetarian"], maxDetourMinutes: 12, kids: false };
    const r = decide(request(calm), stops, null, "mock", true);
    expect(r.action).toBe("STAY_SILENT");
    expect(r.recommendations).toHaveLength(0);
  });

  it("returns 2-3 ranked recommendations for dinner", () => {
    const r = decide(request(hungryIntent), stops, null, "mock", true);
    expect(r.action).toBe("PROPOSE_STOP");
    expect(r.recommendations.length).toBeGreaterThanOrEqual(2);
    expect(r.recommendations.length).toBeLessThanOrEqual(3);
    expect(r.recommendations[0].mapsUrl).toContain("google.com/maps");
  });

  it("model hallucinated ID is dropped, valid picks kept", () => {
    const r = decide(request(hungryIntent), stops, {
      action: "PROPOSE_STOP",
      picks: [
        { stopId: "nonexistent_stop", reason: "hallucinated", tradeoffs: [] },
        { stopId: "veg_cafe_demo", reason: "verified vegetarian, good mock score", tradeoffs: ["8 min detour"] }
      ]
    }, "mistral", false);
    expect(r.recommendations.map((x) => x.stopId)).toEqual(["veg_cafe_demo"]);
  });

  it("all picks hallucinated falls back to deterministic ranking", () => {
    const r = decide(request(hungryIntent), stops, { action: "PROPOSE_STOP", picks: [{ stopId: "fake", reason: "x", tradeoffs: [] }] }, "mistral", false);
    expect(r.recommendations.length).toBeGreaterThan(0);
    expect(r.recommendations[0].stopId).not.toBe("fake");
  });

  it("grocery trigger fires when cold + dark + not purchased", () => {
    const env: Environment = { weather: "cold", trafficDelayMinutes: 0, daylightMinutes: 30 };
    const trip = { ...baseTrip, elapsedMinutes: 300, localTime: "21:00" };
    const triggers = deriveTriggerReasons({ ...hungryIntent, hungerLevel: 0, need: [] }, baseConfig, trip, env);
    expect(triggers.join(" ")).toMatch(/groceries/);
    const r = decide({ trip, config: baseConfig, cars: makeCars(), collectiveIntent: { ...hungryIntent, hungerLevel: 0, need: ["grocery"] }, environment: env }, stops, null, "mock", true);
    expect(r.action).toBe("PROPOSE_STOP");
  });

  it("groceries completed suppresses the reminder", () => {
    const env: Environment = { weather: "cold", trafficDelayMinutes: 0, daylightMinutes: 30 };
    const trip = { ...baseTrip, elapsedMinutes: 300, localTime: "21:00" };
    const cfg = { ...baseConfig, groceriesCompleted: true };
    const triggers = deriveTriggerReasons({ ...hungryIntent, hungerLevel: 0, need: [] }, cfg, trip, env);
    expect(triggers.join(" ")).not.toMatch(/groceries/);
  });
});

describe("recommendation builder", () => {
  it("labels mock data and includes maps url", () => {
    const { eligible } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, baseEnv);
    const recs = buildRecommendations(eligible, 3);
    expect(recs.every((r) => r.mock)).toBe(true);
    expect(recs.every((r) => r.mapsUrl.includes("destination="))).toBe(true);
    expect(recs[0].risks.join(" ")).toMatch(/SIMULATED/);
  });
});
