import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluateUrgency, maxUrgency } from "@/lib/domain/urgency";
import { EMPTY_MEMORY, watch, type WatchInput } from "@/lib/domain/watcher";
import { applyIntentUpdate, emptyCarIntent, expireNeeds, regexIntentUpdate, toCollective, clearCoveredNeeds } from "@/lib/domain/carIntent";
import { applyHorizon, buildRecommendations, decideWithExploration, evaluateCandidates } from "@/lib/domain/engine";
import { allFixtureStops, MockPlaceProvider } from "@/lib/providers/places";
import { OpenMeteoWeatherProvider, addMinutesLocal, conditionFromWmo } from "@/lib/providers/weather";
import { MetaResponsesClient } from "@/lib/providers/ai";
import { allExits, nearestKm, pointAtKm, ROUTE } from "@/lib/route/route";
import { arrivalElapsed, carStateAt, defaultSimCar, elapsedToReach, maxReachableKm, placeCar, placeFollowerPlausibly } from "@/lib/simulator/simulator";
import { recommendStopsRequestSchema } from "@/lib/domain/schemas";
import { POST as recommendPOST } from "@/app/api/recommend-stops/route";
import { POST as intentPOST } from "@/app/api/intent/route";
import type { CarState, RecommendStopsRequest } from "@/lib/domain/types";

const STOPS = allFixtureStops();
const trip0 = { elapsedMinutes: 150, localTime: "12:00", minutesSinceLastStop: 60, lastMealMinutesAgo: null };
const calm = { needs: [], hungerLevel: 0 as const, kids: false };

function watchInput(over: Partial<WatchInput>): WatchInput {
  return {
    elapsedMinutes: 150,
    lead: { id: "car_a", progressKm: 180, speedKph: 100 },
    urgency: evaluateUrgency(calm, trip0),
    stops: STOPS,
    advanceNoticeMinutes: 10,
    routeTotalKm: ROUTE.totalKm,
    excludedStopIds: [],
    confirmedStopPending: false,
    memory: EMPTY_MEMORY,
    ...over
  };
}

function car(over: Partial<CarState> = {}): CarState {
  return { id: "car_a", label: "Car A", role: "lead", progressKm: 180, speedKph: 100, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: [], ...over };
}

function request(over: Partial<RecommendStopsRequest> = {}): RecommendStopsRequest {
  return {
    trip: { destination: "Montréal", direction: "eastbound", highway: "401", elapsedMinutes: 150, localTime: "12:00", minutesSinceLastStop: 60, lastMealMinutesAgo: null },
    config: { avoidRegion: "GTA", noOptionalStopsFirstMinutes: 60, maximumDetourMinutesPerCar: 12, maximumRegroupWaitMinutes: 15, advanceNoticeMinutes: 10, requiredDiet: [], groceriesCompleted: false, passengerLed: true },
    cars: [car()],
    collectiveIntent: { need: [], hungerLevel: 0, dietary: [], maxDetourMinutes: 12, kids: false },
    environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300 },
    ...over
  };
}

describe("real route fixture", () => {
  it("is the real Toronto→Montréal corridor with ordered eastbound exits", () => {
    expect(ROUTE.totalKm).toBeGreaterThan(520);
    expect(ROUTE.totalKm).toBeLessThan(580);
    const exits = allExits();
    expect(exits.length).toBeGreaterThan(50);
    for (let i = 1; i < exits.length; i++) expect(exits[i].km).toBeGreaterThanOrEqual(exits[i - 1].km);
  });
  it("snaps a map click back to the same route km", () => {
    for (const km of [10, 123.4, 300, 500]) {
      const p = pointAtKm(km);
      expect(Math.abs(nearestKm(p.lat, p.lng).km - km)).toBeLessThan(0.3);
    }
  });
  it("heading is roughly eastbound (NE/E) across eastern Ontario", () => {
    const h = pointAtKm(250).headingDeg;
    expect(h).toBeGreaterThan(30);
    expect(h).toBeLessThan(130);
  });
  it("fixture stops are anchored to real exits but stay labelled fictional", () => {
    for (const s of STOPS) {
      expect(s.isMock).toBe(true);
      expect(s.exitLabel).toBeTruthy();
      expect(Math.abs((s.exitKm ?? 0) - s.distanceAlongRouteKm)).toBeLessThan(15);
    }
  });
});

describe("simulator cars", () => {
  it("placing re-anchors a car; position then advances at its speed", () => {
    const a = placeCar(defaultSimCar("car_a"), 100, 30);
    expect(carStateAt(a, 30).progressKm).toBeCloseTo(100, 0);
    expect(carStateAt(a, 90).progressKm).toBeCloseTo(200, 0);
  });
  it("time-consistent: default lead car departs Toronto (km 0) and reaches km = speed × elapsed", () => {
    const a = defaultSimCar("car_a");
    expect(carStateAt(a, 0).progressKm).toBe(0);
    expect(carStateAt(a, 47).progressKm).toBeCloseTo(78.3, 0);
    expect(elapsedToReach(440, 100)).toBeCloseTo(264, 0); // Cornwall-ish is ~4.4 h out, not 47 min
    expect(arrivalElapsed(a)).toBeCloseTo((ROUTE.totalKm / 100) * 60, 0);
  });
  it("followers are clamped to what they could reach since departure", () => {
    const b = defaultSimCar("car_b"); // 98 km/h
    expect(maxReachableKm(b, 30)).toBeCloseTo(49, 0);
    const p = placeFollowerPlausibly(b, 440, 30);
    expect(p.clamped).toBe(true);
    expect(carStateAt(p.car, 30).progressKm).toBeCloseTo(49, 0);
    expect(placeFollowerPlausibly(b, 20, 30).clamped).toBe(false);
  });
  it("frozen GPS reports a stale, non-advancing position", () => {
    const a = { ...placeCar(defaultSimCar("car_a"), 100, 0), gpsFrozenAtElapsed: 10 };
    const s = carStateAt(a, 20);
    expect(s.positionUpdatedMinutesAgo).toBe(10);
    expect(s.progressKm).toBeCloseTo(100 + 100 * (10 / 60), 0);
  });
});

describe("urgency (deterministic)", () => {
  it("lunch passing with unknown meal history → low-urgency reminder, not an assumption of hunger", () => {
    const u = evaluateUrgency(calm, trip0);
    expect(u.level).toBe("low");
    expect(u.needs).toContain("meal");
    expect(u.reminderOnly).toBe(true);
    expect(u.reasons.join(" ")).toMatch(/meal history unknown/);
  });
  it("lunch window closing soon escalates to moderate", () => {
    expect(evaluateUrgency(calm, { ...trip0, localTime: "13:30" }).level).toBe("moderate");
  });
  it("known recent meal or 'not hungry' suppresses the reminder", () => {
    expect(evaluateUrgency(calm, { ...trip0, lastMealMinutesAgo: 60 }).level).toBe("none");
    expect(evaluateUrgency({ ...calm, notHungry: true }, trip0).level).toBe("none");
  });
  it("urgent restroom is high", () => {
    expect(evaluateUrgency({ ...calm, restroomUrgent: true }, trip0).level).toBe("high");
  });
  it("outside meal windows and recently stopped → none", () => {
    expect(evaluateUrgency(calm, { ...trip0, localTime: "15:30" }).level).toBe("none");
  });
  it("three cars: group urgency is the max, needs are unioned", () => {
    const g = maxUrgency([
      evaluateUrgency({ ...calm, needs: ["coffee"] }, { ...trip0, localTime: "15:30" }),
      evaluateUrgency({ ...calm, restroomUrgent: true, kids: true }, { ...trip0, localTime: "15:30" }),
      evaluateUrgency(calm, { ...trip0, localTime: "15:30" })
    ]);
    expect(g.level).toBe("high");
    expect(g.needs).toEqual(expect.arrayContaining(["coffee", "restroom"]));
  });
});

describe("ambient trip watcher", () => {
  const meal = STOPS.filter((s) => s.categories.includes("meal")).sort((a, b) => a.distanceAlongRouteKm - b.distanceAlongRouteKm);
  const target = meal.find((s) => s.distanceAlongRouteKm > 150)!;

  it("proactive lunch: calls Agent 2 when a suitable exit is approaching, with enough notice", () => {
    const lead = { id: "car_a", progressKm: target.distanceAlongRouteKm - 30, speedKph: 100 }; // 18 min ahead
    const d = watch(watchInput({ lead }));
    expect(d.shouldCall).toBe(true);
    expect(d.nextOpportunity?.stopId).toBe(target.id);
    expect(d.nextOpportunity!.minutesAhead).toBeGreaterThanOrEqual(10);
  });
  it("stays quiet while the next exit is still far for a low-urgency reminder", () => {
    const lead = { id: "car_a", progressKm: target.distanceAlongRouteKm - 80, speedKph: 100 }; // 48 min ahead
    const d = watch(watchInput({ lead }));
    expect(d.shouldCall).toBe(false);
  });
  it("never offers an exit inside the safety-notice window", () => {
    const lead = { id: "car_a", progressKm: target.distanceAlongRouteKm - 10, speedKph: 100 }; // 6 min ahead
    const d = watch(watchInput({ lead }));
    expect(d.nextOpportunity?.stopId).not.toBe(target.id);
  });
  it("urgent restroom triggers immediately", () => {
    const d = watch(watchInput({ urgency: evaluateUrgency({ ...calm, restroomUrgent: true }, trip0), lead: { id: "car_a", progressKm: 120, speedKph: 100 } }));
    expect(d.shouldCall).toBe(true);
  });
  it("no duplicate notifications for the same situation", () => {
    const lead = { id: "car_a", progressKm: target.distanceAlongRouteKm - 30, speedKph: 100 };
    const first = watch(watchInput({ lead }));
    const again = watch(watchInput({ lead: { ...lead, progressKm: lead.progressKm + 2 }, elapsedMinutes: 151, memory: { ...EMPTY_MEMORY, lastKey: first.key, lastCallElapsed: 150 } }));
    expect(again.shouldCall).toBe(false);
    expect(again.reasons.join(" ")).toMatch(/deduplicated/);
  });
  it("missed recommended exit → recalculate", () => {
    const lead = { id: "car_a", progressKm: target.distanceAlongRouteKm + 2, speedKph: 100 };
    const d = watch(
      watchInput({
        lead,
        elapsedMinutes: 200,
        memory: { lastKey: "low|x|meal", lastCallElapsed: 180, lastRecommendedKm: target.distanceAlongRouteKm, lastRecommendedStopId: target.id }
      })
    );
    expect(d.missedRecommendation).toBe(true);
    expect(d.reasons.join(" ")).toMatch(/recalculating/);
  });
  it("genuine quiet: no need → no call", () => {
    const d = watch(watchInput({ urgency: evaluateUrgency(calm, { ...trip0, localTime: "15:30" }) }));
    expect(d.shouldCall).toBe(false);
  });
  it("confirmed stop pending → quiet", () => {
    const d = watch(watchInput({ urgency: evaluateUrgency({ ...calm, restroomUrgent: true }, trip0), confirmedStopPending: true }));
    expect(d.shouldCall).toBe(false);
  });
});

describe("Agent 2 bounded exploration", () => {
  const cars = [car({ progressKm: 180 })];
  const intent = { need: ["meal" as const, "restroom" as const], hungerLevel: 2 as const, dietary: [], maxDetourMinutes: 12, kids: false };
  const { eligible } = evaluateCandidates(STOPS, cars, intent, request().config, { ...request().trip, elapsedMinutes: 150 }, request().environment);

  it("high urgency keeps only the nearest exits; low looks farther", () => {
    const high = applyHorizon(eligible, 180, "high");
    const low = applyHorizon(eligible, 180, "low");
    const maxKm = (xs: typeof eligible) => Math.max(...xs.map((e) => e.stop.distanceAlongRouteKm));
    expect(high.kept.length).toBeGreaterThan(0);
    expect(new Set(high.kept.map((e) => e.stop.exitId)).size).toBeLessThanOrEqual(2);
    expect(maxKm(low.kept)).toBeGreaterThan(maxKm(high.kept));
  });
  it("moderate compares at most the next two usable exits", () => {
    const mod = applyHorizon(eligible, 180, "moderate");
    expect(new Set(mod.kept.map((e) => e.stop.exitId)).size).toBeLessThanOrEqual(2);
  });
  it("high urgency ranks nearest first", () => {
    const recs = buildRecommendations(applyHorizon(eligible, 180, "high").kept, 3, 2, true);
    const kms = recs.map((r) => STOPS.find((s) => s.id === r.stopId)!.distanceAlongRouteKm);
    expect([...kms].sort((a, b) => a - b)).toEqual(kms);
  });
  it("relaxed (low) request may select a better, later stop than urgent", async () => {
    const urgentRes = await decideWithExploration(
      request({ cars, collectiveIntent: { ...intent, need: ["restroom"], hungerLevel: 0, restroomUrgent: true } }),
      new MockPlaceProvider(),
      "mock",
      true
    );
    const relaxedRes = await decideWithExploration(request({ cars, collectiveIntent: { ...intent, need: [], hungerLevel: 1 } }), new MockPlaceProvider(), "mock", true);
    const km = (id?: string) => STOPS.find((s) => s.id === id)?.distanceAlongRouteKm ?? 0;
    expect(urgentRes.urgency?.level).toBe("high");
    expect(relaxedRes.urgency?.level).toBe("low");
    const relaxedMax = Math.max(...relaxedRes.recommendations.map((r) => km(r.stopId)));
    expect(relaxedMax).toBeGreaterThanOrEqual(km(urgentRes.recommendations[0]?.stopId));
    expect(relaxedRes.exploration.join(" ")).toMatch(/urgency low/);
  });
  it("skipped stops are excluded and re-planned", async () => {
    const first = await decideWithExploration(request({ cars, collectiveIntent: intent }), new MockPlaceProvider(), "mock", true);
    const top = first.recommendations[0].stopId;
    const second = await decideWithExploration(request({ cars, collectiveIntent: intent, options: { weatherMode: "simulated", excludeStopIds: [top] } }), new MockPlaceProvider(), "mock", true);
    expect(second.recommendations.map((r) => r.stopId)).not.toContain(top);
  });
  it("notes limited facilities / no further stops near the destination", async () => {
    const res = await decideWithExploration(
      request({ cars: [car({ progressKm: 330 })], collectiveIntent: intent }),
      new MockPlaceProvider(),
      "mock",
      true,
      undefined,
      { destinationKm: ROUTE.totalKm }
    );
    expect(res.exploration.join(" ")).toMatch(/no further known stops|limited facilities|next alternative/);
  });
  it("model STAY_SILENT is honoured only at low urgency", async () => {
    const silent = async () => ({ action: "STAY_SILENT", picks: [] });
    const low = await decideWithExploration(request({ cars, collectiveIntent: { ...intent, need: [], hungerLevel: 1 } }), new MockPlaceProvider(), "m", false, silent);
    const high = await decideWithExploration(request({ cars, collectiveIntent: { ...intent, restroomUrgent: true } }), new MockPlaceProvider(), "m", false, silent);
    expect(low.action).toBe("STAY_SILENT");
    expect(high.action).toBe("PROPOSE_STOP");
  });
  it("genuine STAY_SILENT when nothing is needed (kids aboard, recent stop, off-mealtime)", async () => {
    const res = await decideWithExploration(
      request({ trip: { ...request().trip, localTime: "15:30", minutesSinceLastStop: 30 }, cars: [car({ kids: true })], collectiveIntent: { ...intent, need: [], hungerLevel: 0, kids: true } }),
      new MockPlaceProvider(),
      "mock",
      true
    );
    expect(res.action).toBe("STAY_SILENT");
    expect(res.triggerReasons).toEqual([]);
  });
});

describe("diet rules (veg-friendly vs strict)", () => {
  const stop = (id: string) => STOPS.find((s) => s.id === id)!;
  it("vegetarian: excludes only clearly non-veg-friendly menus, and only for meals", async () => {
    const { dietFit } = await import("@/lib/domain/engine");
    expect(dietFit(stop("late_diner_demo"), ["vegetarian"], ["meal"]).ok).toBe(false);
    expect(dietFit(stop("late_diner_demo"), ["vegetarian"], ["meal"]).reason).toMatch(/not veg-friendly/);
    expect(dietFit(stop("chain_demo"), ["vegetarian"], ["meal"]).ok).toBe(true);
    expect(dietFit(stop("hwy_plaza_demo"), ["vegetarian"], ["meal"]).ok).toBe(true);
    // just using the restroom at a diner is fine
    expect(dietFit(stop("late_diner_demo"), ["vegetarian"], ["restroom"]).ok).toBe(true);
  });
  it("diet never blocks a coffee/restroom-only stop for an urgent restroom need", () => {
    const { eligible } = evaluateCandidates(
      STOPS,
      [car({ progressKm: 240 })],
      { need: ["restroom"], hungerLevel: 0, dietary: ["vegetarian"], maxDetourMinutes: 12, kids: true, restroomUrgent: true },
      request().config,
      request().trip,
      request().environment
    );
    expect(eligible.map((e) => e.stop.id)).toContain("coffee_alt_demo");
  });
  it("halal stays strict for meal stops", async () => {
    const { dietFit } = await import("@/lib/domain/engine");
    expect(dietFit(stop("chain_demo"), ["halal"], ["meal"]).ok).toBe(false);
    expect(dietFit(stop("harvest_table_demo"), ["halal", "vegetarian"], ["meal"]).ok).toBe(true);
  });
});

describe("per-car intent (Agent 1 state)", () => {
  it("adds halal without erasing vegetarian; corrections remove; 'already ate' clears meal", () => {
    let a = emptyCarIntent("car_a", { dietary: ["vegetarian"] });
    a = applyIntentUpdate(a, regexIntentUpdate("car_a", "halal food and a coffee please").updates[0], 10);
    expect(a.dietary).toEqual(expect.arrayContaining(["vegetarian", "halal"]));
    expect(a.needs.map((n) => n.need)).toContain("coffee");
    a = applyIntentUpdate(a, regexIntentUpdate("car_a", "actually no coffee").updates[0], 12);
    expect(a.needs.map((n) => n.need)).not.toContain("coffee");
    a = applyIntentUpdate(a, regexIntentUpdate("car_a", "we're very hungry").updates[0], 20);
    expect(a.hungerLevel).toBe(3);
    a = applyIntentUpdate(a, regexIntentUpdate("car_a", "we already ate").updates[0], 30);
    expect(a.hungerLevel).toBe(0);
    expect(a.notHungry).toBe(true);
    expect(a.needs.map((n) => n.need)).not.toContain("meal");
  });
  it("urgent restroom detected and cleared by a confirmed stop", () => {
    let a = applyIntentUpdate(emptyCarIntent("car_a"), regexIntentUpdate("car_a", "kids really need a washroom asap").updates[0], 5);
    expect(a.restroomUrgent).toBe(true);
    expect(a.kids).toBe(true);
    a = clearCoveredNeeds(a, ["meal", "restroom"]);
    expect(a.restroomUrgent).toBe(false);
    expect(a.needs).toEqual([]);
  });
  it("temporary needs expire; persistent properties remain", () => {
    let a = applyIntentUpdate(emptyCarIntent("car_a", { dietary: ["vegan"] }), regexIntentUpdate("car_a", "coffee").updates[0], 0);
    a = expireNeeds(a, 200);
    expect(a.needs).toEqual([]);
    expect(a.dietary).toEqual(["vegan"]);
  });
  it("per-car intents collapse into the collective engine shape", () => {
    const c = toCollective([
      { ...emptyCarIntent("car_a", { dietary: ["vegetarian"] }), needs: [{ need: "restroom", sinceElapsed: 0 }] },
      { ...emptyCarIntent("car_b"), hungerLevel: 2, needs: [{ need: "meal", sinceElapsed: 0 }] },
      { ...emptyCarIntent("car_c", { maxDetourMinutes: 8 }), restroomUrgent: true }
    ]);
    expect(c.need).toEqual(expect.arrayContaining(["restroom", "meal"]));
    expect(c.hungerLevel).toBe(2);
    expect(c.maxDetourMinutes).toBe(8);
    expect(c.restroomUrgent).toBe(true);
  });
});

describe("weather at arrival (Open-Meteo, cached, failure-labelled)", () => {
  beforeEach(() => { vi.stubEnv("UNCONGEST_MODE", "full-live"); });
  afterEach(() => { vi.unstubAllEnvs(); });
  const hourly = (base: number) => ({
    time: ["2026-11-03T12:00", "2026-11-03T13:00", "2026-11-03T14:00"],
    temperature_2m: [base, base + 1, base + 2],
    precipitation_probability: [0, 40, 80],
    weather_code: [0, 3, 61]
  });
  it("returns per-waypoint forecasts for each ETA hour, then serves from cache", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ hourly: hourly(10) }, { hourly: hourly(2) }]), { status: 200 }));
    const p = new OpenMeteoWeatherProvider(fetchMock as unknown as typeof fetch);
    const pts = [
      { id: "now", lat: 43.11, lng: -79.11, localDateTime: "2026-11-03T12:10" },
      { id: "eta", lat: 45.21, lng: -74.21, localDateTime: addMinutesLocal("2026-11-03", "12:10", 115) }
    ];
    const r = await p.getReadings(pts, "sunny");
    expect(r[0]).toMatchObject({ source: "open-meteo", forHour: "2026-11-03T12:00", tempC: 10, condition: "sunny" });
    expect(r[1]).toMatchObject({ source: "open-meteo", forHour: "2026-11-03T14:00", tempC: 4, condition: "rain", precipProbability: 80 });
    await p.getReadings(pts, "sunny");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("provider failure → labelled 'unavailable' with the simulated fallback, never silent", async () => {
    const p = new OpenMeteoWeatherProvider((async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch);
    const [r] = await p.getReadings([{ id: "x", lat: 10.01, lng: 10.01, localDateTime: "2026-11-03T12:00" }], "cloudy");
    expect(r.source).toBe("unavailable");
    expect(r.condition).toBe("cloudy");
    expect(r.note).toMatch(/offline/);
  });
  it("maps WMO codes and cold temperatures", () => {
    expect(conditionFromWmo(73, -2)).toBe("snow");
    expect(conditionFromWmo(0, 1)).toBe("cold");
    expect(conditionFromWmo(3, 12)).toBe("cloudy");
  });
});

describe("Meta Responses client (SSE format from Meta docs)", () => {
  it("accumulates output_text deltas and reads usage from response.completed", async () => {
    const sse = [
      'data: {"type":"response.created","response":{"status":"in_progress"}}',
      'data: {"type":"response.output_text.delta","delta":"{\\"action\\":"}',
      'data: {"type":"response.output_text.delta","delta":"\\"STAY_SILENT\\",\\"picks\\":[]}"}',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"total_tokens":42},"output":[]}}',
      ""
    ].join("\n");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    const client = new MetaResponsesClient({ agent: "decision", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "muse-spark-1.3", temperature: 1, topP: 1, maxOutputTokens: 100, reasoningEffort: "low", timeoutMs: 5000 });
    const out = await client.complete("sys", "user");
    expect(JSON.parse(out.text)).toEqual({ action: "STAY_SILENT", picks: [] });
    expect(out.usage).toEqual({ total_tokens: 42 });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://example.invalid/v1/responses");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ model: "muse-spark-1.3", stream: true, reasoning: { effort: "low" } });
    fetchSpy.mockRestore();
  });
});

describe("API contract (route handlers, mock providers, offline)", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.AI_PROVIDER = "mock";
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it("simulator-shaped Agent 2 request validates and returns 200 with recommendations", async () => {
    const a = carStateAt(placeCar(defaultSimCar("car_a"), 180, 150), 150);
    const body = {
      ...request({ cars: [{ ...a, needs: ["meal"] }], collectiveIntent: { need: ["meal"], hungerLevel: 2, dietary: ["vegetarian"], maxDetourMinutes: 12, kids: true, restroomUrgent: false, notHungry: false } }),
      trip: { ...request().trip, localDate: "2026-11-03" },
      options: { weatherMode: "simulated", excludeStopIds: [] }
    };
    expect(recommendStopsRequestSchema.safeParse(body).success).toBe(true);
    const res = await recommendPOST(new Request("http://x/api/recommend-stops", { method: "POST", body: JSON.stringify(body) }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.action).toBe("PROPOSE_STOP");
    expect(json.recommendations.length).toBeGreaterThan(0);
    expect(json.weather.mode).toBe("simulated");
    expect(json.urgency.level).toBe("moderate");
  });

  it("invalid request returns 422 with Zod issue paths", async () => {
    const res = await recommendPOST(new Request("http://x", { method: "POST", body: JSON.stringify({ ...request(), cars: [{ id: "car_a" }] }) }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.issues.some((i: { path: string[] }) => i.path.join(".").startsWith("cars.0"))).toBe(true);
  });

  it("Agent 1 endpoint falls back to the regex parser offline", async () => {
    const res = await intentPOST(
      new Request("http://x", {
        method: "POST",
        body: JSON.stringify({
          carId: "car_b",
          source: "driver_voice",
          text: "we need halal food",
          localTime: "12:00",
          cars: [
            { id: "car_a", label: "Car A" },
            { id: "car_b", label: "Car B" }
          ],
          current: {}
        })
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.provider).toBe("regex-parser");
    expect(json.updates[0]).toMatchObject({ carId: "car_b", addDietary: ["halal"], addNeeds: ["meal"] });
  });
});
