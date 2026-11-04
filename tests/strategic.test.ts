import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StopCandidate } from "@/lib/domain/types";
import { createRouteModel, type RouteModel } from "@/lib/route/model";
import type { TripRoute } from "@/lib/trip/types";

// Place discovery is mocked: the real placesInWindows/borderCrossing logic runs on these candidates.
const LAT = 44;
const KM_PER_DEG_LNG = 111.32 * Math.cos((LAT * Math.PI) / 180);
const lngAt = (km: number) => -78 + km / KM_PER_DEG_LNG;
const cand = (id: string, km: number, categories: string[], restroomsVerified: boolean | null = null) =>
  ({
    id,
    name: `Place ${id}`,
    type: "restaurant",
    categories,
    region: "test",
    exitId: "x",
    distanceAlongRouteKm: km,
    lat: LAT,
    lng: lngAt(km),
    isMock: false,
    source: "osm",
    vegetarianVerified: null,
    restroomsVerified,
    parkingVerified: null,
    qualityScoreMock: 0.6,
    open24h: false
  }) as unknown as StopCandidate;
const CANDS = [
  cand("osm-80", 80, ["meal"]),
  cand("osm-95", 95, ["coffee"], true),
  cand("osm-120", 120, ["meal"], true),
  cand("osm-130", 130, ["meal", "restroom"], true),
  cand("osm-170", 170, ["restroom"], true)
];
const prefetchMock = vi.fn(async (_route: unknown, _windows: unknown, _opts?: unknown) => ({ trace: Array.from({ length: 12 }, (_, i) => `prefetch km ${i * 30}–${i * 30 + 30}: 5 place(s), live`), candidates: CANDS }));
vi.mock("@/lib/providers/routePlaces", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/providers/routePlaces")>();
  return { ...orig, prefetchWindows: (...a: Parameters<typeof orig.prefetchWindows>) => prefetchMock(a[0], a[1], a[2]) };
});

import { clearStrategicCache, runStrategicPlanner, strategicInputSchema, type ModelPlan, type StrategicDeps } from "@/lib/agent2/strategic";
import { callMuseStructured, resetMuseStructured, museCallStats } from "@/lib/agent2/museStructured";
import { computeFutureWindows, runTools, DEFAULT_TOOLS, type ToolContext, type ToolImpls, type ToolName, TOOL_ORDER } from "@/lib/agent2/strategicTools";

// ---- synthetic straight 300 km route eastward ----
const coords: Array<[number, number]> = [];
for (let k = 0; k <= 300; k += 2) coords.push([lngAt(k), LAT]);
const route: RouteModel = createRouteModel({ id: "strat-route", source: "test", attribution: "test", origin: "A", destination: "B", coordinates: coords, exits: [] });
const tripRoute: TripRoute = {
  id: "strat-route",
  origin: { label: "A", lat: LAT, lng: lngAt(0), type: "home", source: "search" },
  destination: { label: "B", lat: LAT, lng: lngAt(300), type: "hotel", source: "search" },
  coordinates: coords,
  exits: [],
  distanceKm: 300,
  durationMinutes: 180,
  exitsStatus: "ready",
  borderCrossings: [{ km: 150, name: "Test Bridge", lat: LAT, lng: lngAt(150) }],
  alternatives: [{ id: "alt-1", distanceKm: 320, durationMinutes: 195, summary: "Scenic road", coordinates: [[lngAt(0), LAT + 0.3], [lngAt(300), LAT + 0.3]] }],
  source: "osrm",
  timezone: "America/Toronto",
  fetchedAt: "2026-06-15T00:00:00Z",
  attribution: "test"
};

const baseInput = () =>
  strategicInputSchema.parse({
    routeRef: { id: "strat-route", origin: { label: "A", lat: LAT, lng: lngAt(0), type: "home" }, destination: { label: "B", lat: LAT, lng: lngAt(300), type: "hotel" } },
    routeVersion: "rv-1",
    contextVersion: "cv-1",
    sessionId: "test-session",
    timeZone: "America/Toronto",
    departureUtc: "2026-06-15T13:00:00Z", // 09:00 EDT
    elapsedMinutes: 120,
    leadKm: 20,
    leadSpeedKph: 100,
    localTime: "11:00",
    needs: { car_a: [], car_b: ["coffee"] },
    mood: ["relaxed"],
    mealPreference: "auto",
    kids: true,
    lastMealMinutesAgo: null,
    drivingMinutesSinceRest: 0
  });

const fakeWeather: Partial<ToolImpls> = {
  weatherAtWaypoints: async () => ({
    tool: "weatherAtWaypoints",
    summary: "km 200 13:00: rain 80% precip",
    provenance: "live",
    data: { points: [{ id: "wp1", km: 200, localTime: "13:00", description: "rain", tempC: 12, precipProbability: 80, source: "open-meteo", condition: "rain" }] }
  })
};

const baseDeps = (extra: StrategicDeps = {}): StrategicDeps => ({ route, tripRoute, tools: fakeWeather, noCache: true, ...extra });

const okMuse = (value: ModelPlan) => vi.fn(async () => ({ ok: true as const, value, ms: 5, usage: { total_tokens: 1 } }));

beforeEach(() => {
  clearStrategicCache();
  resetMuseStructured();
  prefetchMock.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("AI_PROVIDER", "mock");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("strategic tools", () => {
  it("runs tools concurrently with a bound of 3 and assigns e1..eN", async () => {
    let active = 0;
    let maxActive = 0;
    const slow = (name: ToolName) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 100));
      active--;
      return { tool: name, summary: `${name} ok`, provenance: "simulated" as const, data: {} };
    };
    const impls = Object.fromEntries(TOOL_ORDER.map((n) => [n, slow(n)])) as unknown as ToolImpls;
    const t0 = Date.now();
    const { evidence, trace } = await runTools({} as ToolContext, impls);
    const ms = Date.now() - t0;
    expect(maxActive).toBe(3);
    expect(ms).toBeLessThan(450); // sequential would be ≥ 600
    expect(ms).toBeGreaterThanOrEqual(190);
    expect(evidence.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e4", "e5", "e6"]);
    expect(trace).toHaveLength(6);
    expect(trace.every((t) => typeof t.ms === "number")).toBe(true);
  });

  it("a hanging tool times out as unavailable evidence without blocking the rest", async () => {
    const impls = Object.fromEntries(TOOL_ORDER.map((n) => [n, async () => ({ tool: n, summary: "ok", provenance: "simulated" as const, data: {} })])) as unknown as ToolImpls;
    impls.weatherAtWaypoints = () => new Promise(() => {});
    const { evidence } = await runTools({ input: { leadKm: 0, timeZone: "UTC" }, route, windows: [] } as unknown as ToolContext, impls, { timeoutMs: 80 });
    const w = evidence.find((e) => e.tool === "weatherAtWaypoints")!;
    expect(w.provenance).toBe("unavailable");
    expect(w.summary).toMatch(/timed out/);
    expect(evidence.filter((e) => e.provenance === "simulated")).toHaveLength(5);
  });

  it("future windows include lunch ahead of the lead at projected local times", () => {
    const ws = computeFutureWindows(baseInput(), route, 100);
    expect(ws.length).toBeGreaterThan(0);
    const lunch = ws.find((w) => w.kinds.includes("meal"))!;
    expect(lunch.fromKm).toBeGreaterThanOrEqual(20);
    expect(lunch.expectedLocalFrom >= "11:00").toBe(true);
    expect(ws.some((w) => w.kinds.includes("rest_break"))).toBe(true);
  });
});

describe("runStrategicPlanner", () => {
  it("Muse disabled → deterministic fallback with real candidate ids only", async () => {
    const res = await runStrategicPlanner(baseInput(), baseDeps());
    expect(res.meta.status).toBe("fallback");
    expect(res.meta.provider).toBe("deterministic");
    expect(res.meta.muse?.error).toMatch(/^disabled/);
    const real = new Set(CANDS.map((c) => c.id));
    const ids = res.plan.opportunities.flatMap((o) => o.candidateIds);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => real.has(id))).toBe(true);
    expect(res.plan.opportunities.some((o) => o.kind === "meal" && o.candidateIds.length > 0)).toBe(true);
    // every tool is in the trace with ms + provenance
    for (const t of TOOL_ORDER) {
      const tr = res.meta.toolTrace.find((x) => x.tool === t)!;
      expect(tr).toBeTruthy();
      expect(typeof tr.ms).toBe("number");
      expect(tr.provenance).toBeTruthy();
    }
    expect(res.plan.routeVersion).toBe("rv-1");
  });

  it("border crossing → route_choice opportunity with before/after counts", async () => {
    const res = await runStrategicPlanner(baseInput(), baseDeps());
    const border = res.plan.evidence.find((e) => e.tool === "borderCrossing")!;
    // within 40 km before km 150: osm-120, osm-130; after: osm-170
    expect(border.summary).toMatch(/2 food\/restroom place\(s\) within 40 km before vs 1 after/);
    const rc = res.plan.opportunities.find((o) => o.kind === "route_choice")!;
    expect(rc).toBeTruthy();
    expect(rc.reason).toMatch(/2 .* before .* vs 1 after/);
    expect(rc.candidateIds.length).toBeGreaterThan(0);
    expect(rc.candidateIds.every((id) => ["osm-120", "osm-130"].includes(id))).toBe(true);
    expect(rc.evidenceRefs).toContain(border.id);
    expect(res.plan.routeDecisions.some((d) => d.alternativeRouteId === "alt-1")).toBe(true);
  });

  it("long gap without food/restroom → limited_service_stretch; arrival evidence present", async () => {
    const res = await runStrategicPlanner({ ...baseInput(), kids: false }, baseDeps());
    expect(res.plan.opportunities.some((o) => o.kind === "limited_service_stretch" && o.candidateIds.length === 0)).toBe(true);
    expect(res.plan.evidence.some((e) => e.tool === "destinationArrival" && /Arrive B/.test(e.summary))).toBe(true);
  });

  it("arrival after dark → arrival opportunity in the fallback plan", async () => {
    const res = await runStrategicPlanner({ ...baseInput(), elapsedMinutes: 630, localTime: "19:30" }, baseDeps());
    const arr = res.plan.opportunities.find((o) => o.kind === "arrival")!;
    expect(arr).toBeTruthy();
    expect(arr.reason).toMatch(/after sunset/);
  });

  it("valid Muse plan → validated, hallucinated ids dropped, versions forced, behind-lead dropped", async () => {
    const muse = okMuse({
      summary: "Lunch near km 120, then the border.",
      opportunities: [
        { id: "o1", kind: "meal", title: "Lunch", fromKm: 100, toKm: 140, candidateIds: ["osm-120", "fake-999"], reason: "Lunch window", evidenceRefs: ["e1", "e2", "e99"], priority: "medium", confidence: 0.8, watchFor: null },
        { id: "o2", kind: "coffee", title: "Old coffee", fromKm: 2, toKm: 10, candidateIds: [], reason: "already passed", evidenceRefs: [], priority: "low", confidence: 0.5, watchFor: null },
        { id: "o3", kind: "arrival", title: "Arrival", fromKm: 280, toKm: 900, candidateIds: [], reason: "end", evidenceRefs: ["e4"], priority: "low", confidence: 2, watchFor: null }
      ],
      routeDecisions: [{ id: "d1", title: "Alt", atKm: 20, detail: "x", alternativeRouteId: "made-up", deltaMinutes: 15 }],
      replanTriggers: ["Lead passes km 140"],
      expiresAtKm: 5,
      uncertainty: null
    });
    const input = baseInput();
    const res = await runStrategicPlanner(input, baseDeps({ muse }));
    expect(muse).toHaveBeenCalledTimes(1);
    const call = (muse.mock.calls[0] as unknown[])[0] as { effort: string; schemaName: string; user: string };
    expect(call.effort).toBe("medium");
    expect(call.user).toContain("osm-120");
    expect(res.meta.status).toBe("completed");
    expect(res.plan.routeVersion).toBe("rv-1");
    expect(res.plan.contextVersion).toBe("cv-1");
    const ids = res.plan.opportunities.map((o) => o.id);
    expect(ids).toEqual(["o1", "o3"]);
    const o1 = res.plan.opportunities[0];
    expect(o1.candidateIds).toEqual(["osm-120"]);
    expect(o1.evidenceRefs).toEqual(["e1", "e2"]);
    expect(o1.expectedLocalFrom).toBe("11:48");
    const o3 = res.plan.opportunities[1];
    expect(o3.toKm).toBeLessThanOrEqual(route.totalKm + 0.01);
    expect(o3.confidence).toBe(1);
    expect(res.plan.routeDecisions[0].alternativeRouteId).toBeUndefined();
    expect(res.plan.expiresAtKm!).toBeGreaterThan(input.leadKm);
  });

  it("Muse timeout → status timeout with fallback plan within deadline + margin", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("AI_PROVIDER", "meta");
    vi.stubEnv("MUSE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          })
      )
    );
    const t0 = Date.now();
    const res = await runStrategicPlanner(baseInput(), baseDeps({ deadlineMs: 200 }));
    const ms = Date.now() - t0;
    expect(res.meta.status).toBe("timeout");
    expect(ms).toBeLessThan(200 + 500);
    expect(res.plan.opportunities.length).toBeGreaterThan(0);
    expect(museCallStats().timeouts).toBe(1);
  });

  it("invalid Muse JSON → deterministic fallback, error 'invalid'", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("AI_PROVIDER", "meta");
    vi.stubEnv("MUSE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "not json at all" }] }] }), { status: 200 }))
    );
    const res = await runStrategicPlanner(baseInput(), baseDeps());
    expect(res.meta.status).toBe("fallback");
    expect(res.meta.muse?.error).toMatch(/^invalid/);
    expect(res.plan.opportunities.length).toBeGreaterThan(0);
  });

  it("cache hit → status cached (one Muse call)", async () => {
    const muse = okMuse({ summary: "ok", opportunities: [], routeDecisions: [], replanTriggers: [], expiresAtKm: null, uncertainty: null });
    const deps = { ...baseDeps({ muse }), noCache: false };
    const a = await runStrategicPlanner(baseInput(), deps);
    const b = await runStrategicPlanner(baseInput(), deps);
    expect(a.meta.status).toBe("completed");
    expect(b.meta.status).toBe("cached");
    expect(muse).toHaveBeenCalledTimes(1);
    const c = await runStrategicPlanner({ ...baseInput(), contextVersion: "cv-2" }, deps);
    expect(c.meta.status).toBe("completed");
    expect(c.plan.contextVersion).toBe("cv-2");
    expect(muse).toHaveBeenCalledTimes(2);
  });

  it("same versions far along the trip → recomputed, not a cached plan from the earlier position", async () => {
    const muse = okMuse({ summary: "ok", opportunities: [], routeDecisions: [], replanTriggers: [], expiresAtKm: null, uncertainty: null });
    const deps = { ...baseDeps({ muse }), noCache: false };
    const a = await runStrategicPlanner({ ...baseInput(), leadKm: 0, elapsedMinutes: 0 }, deps);
    expect(a.meta.status).toBe("completed");
    const near = await runStrategicPlanner({ ...baseInput(), leadKm: 2, elapsedMinutes: 2 }, deps);
    expect(near.meta.status).toBe("cached");
    const far = await runStrategicPlanner({ ...baseInput(), leadKm: 150, elapsedMinutes: 95 }, deps);
    expect(far.meta.status).not.toBe("cached");
    expect(far.plan.createdAtElapsed).toBe(95);
    // same lead bucket but much later in time (e.g. a long stop) → recomputed too
    const later = await runStrategicPlanner({ ...baseInput(), leadKm: 150, elapsedMinutes: 140 }, deps);
    expect(later.meta.status).not.toBe("cached");
    expect(later.plan.createdAtElapsed).toBe(140);
    expect(muse).toHaveBeenCalledTimes(3);
  });
});

describe("callMuseStructured", () => {
  it("is disabled without meta provider / key", async () => {
    const { z } = await import("zod");
    const r = await callMuseStructured({ system: "s", user: "u", schemaName: "x", jsonSchema: {}, zod: z.object({}), effort: "low", deadlineMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("disabled");
  });

  it("posts non-streaming json_schema text.format and validates the output", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("AI_PROVIDER", "meta");
    vi.stubEnv("MUSE_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: "completed", usage: { total_tokens: 3 }, output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { z } = await import("zod");
    const r = await callMuseStructured({ system: "s", user: "u", schemaName: "x", jsonSchema: { type: "object" }, zod: z.object({ a: z.number() }), effort: "low", deadlineMs: 1000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: 1 });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/responses$/);
    expect(body.stream).toBe(false);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.text.format).toMatchObject({ type: "json_schema", name: "x", strict: true });
  });

  it("rate guard returns rate_limited", async () => {
    vi.stubEnv("UNCONGEST_MODE", "live-muse");
    vi.stubEnv("AI_PROVIDER", "meta");
    vi.stubEnv("MUSE_API_KEY", "test-key");
    vi.stubEnv("LLM_MAX_CALLS_PER_10_MIN", "0");
    const { z } = await import("zod");
    const r = await callMuseStructured({ system: "s", user: "u", schemaName: "x", jsonSchema: {}, zod: z.object({}), effort: "low", deadlineMs: 100 });
    expect(!r.ok && r.reason).toBe("rate_limited");
  });
});


describe("strategic demo evidence", () => {
  it("provides labeled fictional places and dated weather without network access", async () => {
    vi.stubEnv("UNCONGEST_MODE", "demo");
    const fetchMock = vi.fn(() => { throw new Error("offline test must not fetch"); });
    vi.stubGlobal("fetch", fetchMock);
    const input = { ...baseInput(), dataMode: "demo" as const, weatherCondition: "rain" as const };
    const ctx: ToolContext = {
      input, route, tripRoute, cruiseSpeedKph: 100, nowUtc: new Date(input.departureUtc),
      windows: [{ id: "demo", fromKm: 20, toKm: 300, kinds: ["meal"], reason: "lunch", expectedLocalFrom: "11:00", expectedLocalTo: "14:00" }]
    };
    const places = await DEFAULT_TOOLS.placesInWindows(ctx);
    expect(places.provenance).toBe("simulated");
    expect(places.summary).toMatch(/fictional/);
    const data = places.data as { candidates: Array<{ isMock: boolean; source: string }> };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates.every((c) => c.isMock && /fictional/.test(c.source))).toBe(true);
    const weather = await DEFAULT_TOOLS.weatherAtWaypoints(ctx);
    expect(weather.provenance).toBe("simulated");
    expect(weather.summary).toMatch(/Mock weather snapshot/);
    const points = (weather.data as { points: Array<{ recordedAt: string; condition: string }> }).points;
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => /^2026-/.test(p.recordedAt) && p.condition === "rain")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
