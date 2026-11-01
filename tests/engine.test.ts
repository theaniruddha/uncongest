import { describe, it, expect } from "vitest";
import stopsFixture from "@/data/stops/highway-401.mock.json";
import { evaluateCandidates, deriveTriggerReasons, decide, buildRecommendations, isOpenAt } from "@/lib/domain/engine";
import { parseIntent, mergeCollectiveIntent } from "@/lib/domain/intent";
import { decideWithExploration } from "@/lib/domain/engine";
import { MockPlaceProvider } from "@/lib/providers/places";
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
  it("excludes GTA stops per config when not urgent", () => {
    const mild: CollectiveIntent = { ...hungryIntent, hungerLevel: 1, need: ["coffee"] };
    const earlyCars = makeCars();
    earlyCars.forEach((c) => (c.progressKm = 20));
    const { rejected } = evaluateCandidates(stops, earlyCars, mild, baseConfig, baseTrip, baseEnv);
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

  it("shrinks detour tolerance in poor weather for non-urgent needs", () => {
    const rainy: Environment = { weather: "rain", trafficDelayMinutes: 10, daylightMinutes: 95 };
    const mild: CollectiveIntent = { ...hungryIntent, hungerLevel: 2 };
    const { eligible } = evaluateCandidates(stops, makeCars(), mild, baseConfig, baseTrip, rainy);
    expect(eligible.find((e) => e.stop.id === "veg_cafe_demo")).toBeUndefined();
  });

  it("bad weather does not suppress urgent recommendations", () => {
    const snowy: Environment = { weather: "snow", trafficDelayMinutes: 5, daylightMinutes: 40 };
    const { eligible } = evaluateCandidates(stops, makeCars(), hungryIntent, baseConfig, baseTrip, snowy);
    expect(eligible.find((e) => e.stop.id === "veg_cafe_demo")).toBeDefined();
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

describe("agentic improvements", () => {
  it("negation removes needs", () => {
    const p = parseIntent("actually no coffee needed");
    expect(p.removeNeeds).toContain("coffee");
    expect(p.needs).not.toContain("coffee");
  });

  it("correction resets hunger", () => {
    const saved: CollectiveIntent = { need: ["meal"], hungerLevel: 3, dietary: [], maxDetourMinutes: 12, kids: false };
    const merged = mergeCollectiveIntent(parseIntent("actually, forget it, we're not hungry"), saved);
    expect(merged.hungerLevel).toBe(0);
  });

  it("urgent need allows excluded region with soft note", () => {
    const urgent: CollectiveIntent = { ...hungryIntent, need: ["meal"], hungerLevel: 3 };
    const earlyCars = makeCars();
    earlyCars.forEach((c) => (c.progressKm = 20));
    const { eligible, rejected } = evaluateCandidates(stops, earlyCars, urgent, baseConfig, baseTrip, baseEnv);
    expect(eligible.map((e) => e.stop.id)).toContain("gta_plaza_demo");
    expect(rejected.find((r) => r.stopId === "gta_plaza_demo")?.reasons.join(" ")).toMatch(/allowed under urgent need/);
  });

  it("low-quality-only corridor yields fallback tier with caveat, not silence", () => {
    const farCars = makeCars();
    farCars.forEach((c) => (c.progressKm = 260));
    const noDietCfg = { ...baseConfig, requiredDiet: [] as never[] };
    const mealOnly: CollectiveIntent = { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: false };
    const { eligible } = evaluateCandidates(stops, farCars, mealOnly, noDietCfg, { ...baseTrip, elapsedMinutes: 200 }, baseEnv);
    const mealStops = eligible.filter((e) => e.stop.categories.includes("meal"));
    expect(mealStops.length).toBeGreaterThan(0);
    expect(mealStops.every((e) => e.tier === "fallback")).toBe(true);
    const recs = buildRecommendations(eligible, 3);
    expect(recs.some((r) => r.risks.join(" ").match(/FALLBACK/))).toBe(true);
  });

  it("result includes explainability trace", () => {
    const r = decide({ trip: baseTrip, config: baseConfig, cars: makeCars(), collectiveIntent: hungryIntent, environment: baseEnv }, stops, null, "mock", true);
    expect(r.understood.length).toBeGreaterThan(0);
    expect(r.verifiedChecks.some((c) => c.includes("freshness"))).toBe(true);
    expect(r.action).toBe("PROPOSE_STOP");
  });

  it("bounded exploration noted when only fallback options exist", async () => {
    const farCars = makeCars();
    farCars.forEach((c) => (c.progressKm = 290));
    const r = await decideWithExploration(
      { trip: { ...baseTrip, elapsedMinutes: 200 }, config: { ...baseConfig, requiredDiet: [] }, cars: farCars, collectiveIntent: { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: false }, environment: baseEnv },
      new MockPlaceProvider(), "mock", true
    );
    expect(r.exploration.join(" ")).toMatch(/second search|fallback|newly discovered/i);
  });
});

describe("real bounded exploration (second provider pass)", () => {
  it("second search discovers a better later-exit option and changes the top recommendation", async () => {
    // Cars just past all base-fixture restaurants; initial pass finds only fallback/chain options.
    const lateCars = makeCars();
    lateCars.forEach((c) => (c.progressKm = 262));
    const noDietCfg = { ...baseConfig, requiredDiet: [] as never[] };
    const mealOnly: CollectiveIntent = { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: false };
    const trip = { ...baseTrip, elapsedMinutes: 200, localTime: "16:30" };
    const clearEnv: Environment = { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 95 };

    const withoutExploration = await decideWithExploration(
      { trip, config: noDietCfg, cars: lateCars, collectiveIntent: mealOnly, environment: clearEnv },
      new (class extends MockPlaceProvider {
        override async getCandidates(pass: "initial" | "nextExits") {
          const all = await super.getCandidates("initial", { minKm: 0, maxKm: 1000, needs: [] });
          return pass === "initial" ? all : [];
        }
      })(), "mock", true
    );

    const withExploration = await decideWithExploration(
      { trip, config: noDietCfg, cars: lateCars, collectiveIntent: mealOnly, environment: clearEnv },
      new MockPlaceProvider(), "mock", true
    );

    expect(withExploration.exploration.join(" ")).toMatch(/second search/);
    expect(withExploration.recommendations.map((r) => r.stopId)).toContain("harvest_table_demo");
    expect(withExploration.exploration.join(" ")).toMatch(/changed the top recommendation|confirmed/);
    const noExpTop = withoutExploration.recommendations[0]?.stopId;
    const expTop = withExploration.recommendations[0]?.stopId;
    if (noExpTop) expect(expTop).not.toBe(noExpTop);
  });

  it("exploration trace records provider pass, validation and comparison", async () => {
    const lateCars = makeCars();
    lateCars.forEach((c) => (c.progressKm = 262));
    const r = await decideWithExploration(
      { trip: { ...baseTrip, elapsedMinutes: 200, localTime: "16:30" }, config: { ...baseConfig, requiredDiet: [] }, cars: lateCars, collectiveIntent: { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: false }, environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 95 } },
      new MockPlaceProvider(), "mock", true
    );
    const trace = r.exploration.join(" ");
    expect(trace).toMatch(/pass=nextExits/);
    expect(trace).toMatch(/validated \d+ newly discovered/);
  });
});

describe("reasoning corrections", () => {
  it("checks opening hours at projected arrival, not current time", () => {
    // late_diner_demo closes 18:30. At 18:20 now with 15 min drive, arrival 18:35 -> closed.
    const cars = makeCars();
    cars.forEach((c) => (c.progressKm = 285));
    cars[0].speedKph = 60; // 300-285=15km -> 15 min
    const trip = { ...baseTrip, elapsedMinutes: 200, localTime: "18:20" };
    const cfg = { ...baseConfig, requiredDiet: [] as never[], advanceNoticeMinutes: 5 };
    const intent: CollectiveIntent = { need: ["meal"], hungerLevel: 2, dietary: [], maxDetourMinutes: 12, kids: false };
    const { rejected } = evaluateCandidates(stops, cars, intent, cfg, trip, baseEnv);
    expect(rejected.find((r) => r.stopId === "late_diner_demo")?.reasons.join(" ")).toMatch(/18:35/);
  });

  it("treats unknown last-stop time as unknown (no fatigue penalty)", () => {
    const withKnown = evaluateCandidates(stops, makeCars(), { ...hungryIntent }, baseConfig, { ...baseTrip, minutesSinceLastStop: 240 }, baseEnv);
    const without = evaluateCandidates(stops, makeCars(), { ...hungryIntent }, baseConfig, { ...baseTrip, minutesSinceLastStop: undefined }, baseEnv);
    const a = withKnown.eligible.find((e) => e.stop.id === "veg_cafe_demo")!.score;
    const b = without.eligible.find((e) => e.stop.id === "veg_cafe_demo")!.score;
    expect(b).toBeGreaterThan(a); // no fabricated fatigue when unknown
  });

  it("respects specific hard dietary restrictions (halal)", () => {
    const halal: CollectiveIntent = { need: ["meal"], hungerLevel: 2, dietary: ["halal"], maxDetourMinutes: 12, kids: false };
    const { eligible, rejected } = evaluateCandidates(stops, makeCars(), halal, { ...baseConfig, requiredDiet: ["halal"] }, baseTrip, baseEnv);
    // base fixture: nothing verifies halal -> all meal stops rejected
    expect(eligible.filter((e) => e.stop.categories.includes("meal")).length).toBe(0);
    expect(rejected.length).toBeGreaterThan(0);
  });

  it("urgent hunger promotes a convenient lower-rated big-box stop to rank 1", async () => {
    const cars = makeCars();
    cars.forEach((c) => (c.progressKm = 250));
    const r = await decideWithExploration(
      { trip: { ...baseTrip, elapsedMinutes: 200, localTime: "16:30" }, config: { ...baseConfig, requiredDiet: [] }, cars, collectiveIntent: { need: ["meal"], hungerLevel: 3, dietary: [], maxDetourMinutes: 12, kids: false }, environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 95 } },
      new MockPlaceProvider(), "mock", true
    );
    expect(r.recommendations[0].stopId).toBe("bigbox_mart_demo");
  });
});
