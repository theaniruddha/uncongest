import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CarState, RecommendStopsRequest, StopCandidate } from "@/lib/domain/types";
import { createRouteModel, type RouteModel } from "@/lib/route/model";
import type { TripRoute } from "@/lib/trip/types";

/*
 * Regression tests for requirements not covered elsewhere:
 *  1. Strategic place coverage: un-fetched tiles are UNKNOWN, never "no services".
 *  2. Border tool: only one side covered → provenance "unavailable", counts unknown.
 *  3. Overpass client: cacheOnly never waits on an in-flight live query; memory hit is served.
 *  4. Tactical route integration (/api/recommend-stops, workflow "tactical", demo data).
 *  5. Strategic route: invalid body → 422.
 * (6. Home-departure quiet window is already covered in tests/optimize.test.ts.)
 */

// ---- place discovery is mocked; the real tool logic runs on the trace/candidates we hand it ----
type PrefetchResult = { trace: string[]; candidates: StopCandidate[] };
let prefetchImpl: (windows: Array<{ minKm: number; maxKm: number }>) => PrefetchResult = () => ({ trace: [], candidates: [] });
const prefetchMock = vi.fn(async (_route: unknown, windows: Array<{ minKm: number; maxKm: number }>, _opts?: unknown) => prefetchImpl(windows));
vi.mock("@/lib/providers/routePlaces", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/providers/routePlaces")>();
  return { ...orig, prefetchWindows: (...a: Parameters<typeof orig.prefetchWindows>) => prefetchMock(a[0], a[1], a[2]) };
});

import { clearStrategicCache, runStrategicPlanner, strategicInputSchema, type StrategicDeps, type StrategicInput } from "@/lib/agent2/strategic";
import { resetMuseStructured } from "@/lib/agent2/museStructured";
import { computeFutureWindows, coveredTiles, cruiseSpeedFor, DEFAULT_TOOLS, type BorderData, type PlacesData, type ToolContext, type ToolImpls } from "@/lib/agent2/strategicTools";
import { tilesFor } from "@/lib/providers/routePlaces";
import { clearOverpassCache, overpassQuery } from "@/lib/providers/overpass";
import { resetBudgets } from "@/lib/providers/budget";
import { POST as recommendPOST } from "@/app/api/recommend-stops/route";
import { POST as strategicPOST } from "@/app/api/strategic/route";

// ---- synthetic straight 300 km eastbound route with a border at km 150 ----
const LAT = 44;
const KM_PER_DEG_LNG = 111.32 * Math.cos((LAT * Math.PI) / 180);
const lngAt = (km: number) => -78 + km / KM_PER_DEG_LNG;
const coords: Array<[number, number]> = [];
for (let k = 0; k <= 300; k += 2) coords.push([lngAt(k), LAT]);
const route: RouteModel = createRouteModel({ id: "req-route", source: "test", attribution: "test", origin: "A", destination: "B", coordinates: coords, exits: [] });
const tripRoute: TripRoute = {
  id: "req-route",
  origin: { label: "A", lat: LAT, lng: lngAt(0), type: "home", source: "search" },
  destination: { label: "B", lat: LAT, lng: lngAt(300), type: "hotel", source: "search" },
  coordinates: coords,
  exits: [],
  distanceKm: 300,
  durationMinutes: 180,
  exitsStatus: "ready",
  borderCrossings: [{ km: 150, name: "Test Bridge", lat: LAT, lng: lngAt(150) }],
  alternatives: [],
  source: "osrm",
  timezone: "America/Toronto",
  fetchedAt: "2026-06-15T00:00:00Z",
  attribution: "test"
};

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

const baseInput = (): StrategicInput =>
  strategicInputSchema.parse({
    routeRef: { id: "req-route", origin: { label: "A", lat: LAT, lng: lngAt(0), type: "home" }, destination: { label: "B", lat: LAT, lng: lngAt(300), type: "hotel" } },
    routeVersion: "rv-1",
    contextVersion: "cv-1",
    sessionId: "req-session",
    timeZone: "America/Toronto",
    departureUtc: "2026-06-15T13:00:00Z",
    elapsedMinutes: 120,
    leadKm: 20,
    leadSpeedKph: 100,
    localTime: "11:00",
    needs: { car_a: [], car_b: ["coffee"] },
    mood: ["relaxed"],
    mealPreference: "auto",
    kids: false,
    lastMealMinutesAgo: null,
    drivingMinutesSinceRest: 0
  });

const fakeWeather: Partial<ToolImpls> = {
  weatherAtWaypoints: async () => ({ tool: "weatherAtWaypoints", summary: "dry", provenance: "simulated", data: { points: [] } })
};
const deps = (): StrategicDeps => ({ route, tripRoute, tools: fakeWeather, noCache: true });

function toolCtx(input: StrategicInput = baseInput()): ToolContext {
  const cruiseSpeedKph = cruiseSpeedFor(input);
  return { input, route, tripRoute, windows: computeFutureWindows(input, route, cruiseSpeedKph), cruiseSpeedKph, nowUtc: new Date("2026-06-15T15:00:00Z") };
}

/** Prefetch trace the way routePlaces.prefetchWindows writes it: covered tiles → "N place(s), cached"; others → failed (not cached). */
function traceFor(windows: Array<{ minKm: number; maxKm: number }>, isCovered: (tileMinKm: number) => boolean, candidates: StopCandidate[] = []): PrefetchResult {
  const tiles = new Map<number, { minKm: number; maxKm: number }>();
  for (const w of windows) for (const t of tilesFor(route, w)) tiles.set(t.minKm, t);
  const trace = [...tiles.values()].map((t) => {
    const n = candidates.filter((c) => c.distanceAlongRouteKm >= t.minKm && c.distanceAlongRouteKm < t.maxKm).length;
    return isCovered(t.minKm) ? `prefetch km ${t.minKm}–${t.maxKm.toFixed(0)}: ${n} place(s), cached` : `prefetch km ${t.minKm}–${t.maxKm.toFixed(0)}: failed — not cached`;
  });
  const keep = candidates.filter((c) => [...tiles.values()].some((t) => isCovered(t.minKm) && c.distanceAlongRouteKm >= t.minKm && c.distanceAlongRouteKm < t.maxKm));
  return { trace, candidates: keep };
}

const NO_SERVICES = /no (food|restroom|services)|0 suitable place|with few services|few food\/restroom/i;

beforeEach(() => {
  clearStrategicCache();
  resetMuseStructured();
  prefetchMock.mockClear();
  vi.unstubAllEnvs();
  vi.stubEnv("AI_PROVIDER", "mock");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ 1. place coverage */
describe("strategic place coverage: unfetched stretches are unknown, not empty", () => {
  it("coveredTiles keeps only tiles that returned data (live/cached), never failed / not-cached ones", () => {
    const tiles = coveredTiles([
      "prefetch km 0–30: 4 place(s), live",
      "prefetch km 30–60: 0 place(s), cached",
      "prefetch km 60–90: failed — not cached",
      "prefetch km 90–120: failed — Overpass unavailable: timeout",
      "[initial] km 120–150 tile km 120–150: not cached (skipped in fast path)"
    ]);
    expect(tiles).toEqual([
      { minKm: 0, maxKm: 30 },
      { minKm: 30, maxKm: 60 }
    ]);
  });

  it("all tiles not cached → counts unknown, provenance unavailable, no gaps, nothing searched", async () => {
    prefetchImpl = (ws) => traceFor(ws, () => false);
    const ctx = toolCtx();
    expect(ctx.windows.length).toBeGreaterThan(0);
    const res = await DEFAULT_TOOLS.placesInWindows(ctx);
    const data = res.data as PlacesData;
    expect(res.provenance).toBe("unavailable");
    expect(res.summary).toMatch(/counts unknown/);
    expect(res.summary).toMatch(/do NOT assume there are no services/);
    expect(data.searched).toEqual([]);
    expect(data.gaps).toEqual([]);
    // the fast path is cache-only (no fetchImpl in ctx)
    expect((prefetchMock.mock.calls[0][2] as { cacheOnly?: boolean }).cacheOnly).toBe(true);
  });

  it("all tiles not cached → fallback plan has no limited_service_stretch and never claims 'no services'", async () => {
    prefetchImpl = (ws) => traceFor(ws, () => false);
    const res = await runStrategicPlanner(baseInput(), deps());
    expect(res.meta.status).toBe("fallback");
    expect(res.plan.opportunities.some((o) => o.kind === "limited_service_stretch")).toBe(false);
    const windowOpps = res.plan.opportunities.filter((o) => o.id.startsWith("fb-w"));
    expect(windowOpps.length).toBeGreaterThan(0);
    for (const o of windowOpps) {
      expect(o.reason).toMatch(/place lookup unavailable/);
      expect(o.reason).not.toMatch(NO_SERVICES);
    }
    expect(res.plan.summary).not.toMatch(NO_SERVICES);
  });

  it("only the first window covered → later windows reported as counts unknown, gaps only inside searched tiles", async () => {
    const ctx = toolCtx();
    expect(ctx.windows.length).toBeGreaterThan(1);
    const w1 = ctx.windows[0];
    const firstTiles = new Set(tilesFor(route, { minKm: w1.fromKm, maxKm: w1.toKm }).map((t) => t.minKm));
    const lastCoveredKm = Math.max(...tilesFor(route, { minKm: w1.fromKm, maxKm: w1.toKm }).map((t) => t.maxKm));
    // later windows must lie (mostly) beyond the covered tiles for this test to be meaningful
    const uncovered = ctx.windows.filter((w) => w.fromKm >= lastCoveredKm);
    expect(uncovered.length).toBeGreaterThan(0);
    prefetchImpl = (ws) => traceFor(ws, (k) => firstTiles.has(k));
    const res = await DEFAULT_TOOLS.placesInWindows(ctx);
    const data = res.data as PlacesData;
    expect(res.provenance).toBe("cached");
    for (const w of uncovered) expect(res.summary).toMatch(new RegExp(`${w.id} km \\d+–\\d+: counts unknown`));
    for (const g of data.gaps) expect(g.toKm).toBeLessThanOrEqual(lastCoveredKm);
    for (const s of data.searched) expect(s.maxKm).toBeLessThanOrEqual(lastCoveredKm);
  });

  // buildFallbackPlan decides the place note per *window* coverage: when one window was searched
  // (provenance "cached") but another was not fetched at all, the un-fetched window must not claim
  // "0 suitable place(s) found".
  it("only the first window covered → the un-fetched window's fallback reason does not claim '0 suitable place(s) found'", async () => {
    const ctx = toolCtx();
    const w1 = ctx.windows[0];
    const firstTiles = new Set(tilesFor(route, { minKm: w1.fromKm, maxKm: w1.toKm }).map((t) => t.minKm));
    const lastCoveredKm = Math.max(...tilesFor(route, { minKm: w1.fromKm, maxKm: w1.toKm }).map((t) => t.maxKm));
    prefetchImpl = (ws) => traceFor(ws, (k) => firstTiles.has(k));
    const res = await runStrategicPlanner(baseInput(), deps());
    const later = res.plan.opportunities.filter((o) => o.id.startsWith("fb-w") && o.fromKm >= lastCoveredKm);
    expect(later.length).toBeGreaterThan(0);
    for (const o of later) expect(o.reason).not.toMatch(NO_SERVICES);
  });
});

/* ------------------------------------------------------------------ 2. border */
describe("border tool coverage", () => {
  const B = 150;
  const before = [cand("b-120", 120, ["meal"], true), cand("b-140", 140, ["meal", "restroom"], true)];

  it("only the near side of the crossing covered → provenance unavailable and counts unknown", async () => {
    prefetchImpl = (ws) => traceFor(ws, (k) => k < B, before);
    const res = await DEFAULT_TOOLS.borderCrossing(toolCtx());
    const data = res.data as BorderData;
    expect(res.provenance).toBe("unavailable");
    expect(res.summary).toMatch(/counts unknown/);
    expect(res.summary).not.toMatch(/\d+ food\/restroom place\(s\) within/);
    expect(data.crossings.map((c) => c.km)).toEqual([B]);
  });

  it("only the far side covered → also unavailable", async () => {
    prefetchImpl = (ws) => traceFor(ws, (k) => k >= B, [cand("a-170", 170, ["meal"], true)]);
    const res = await DEFAULT_TOOLS.borderCrossing(toolCtx());
    expect(res.provenance).toBe("unavailable");
    expect(res.summary).toMatch(/counts unknown/);
  });

  it("both sides covered → counted (control)", async () => {
    prefetchImpl = (ws) => traceFor(ws, () => true, [...before, cand("a-170", 170, ["meal"], true)]);
    const res = await DEFAULT_TOOLS.borderCrossing(toolCtx());
    expect(res.provenance).toBe("cached");
    expect(res.summary).toMatch(/2 food\/restroom place\(s\) within 40 km before vs 1 after/);
  });

  it("one side covered → fallback route_choice says counts unavailable and recommends no specific stop", async () => {
    prefetchImpl = (ws) => traceFor(ws, (k) => k < B, before);
    const res = await runStrategicPlanner(baseInput(), deps());
    const rc = res.plan.opportunities.find((o) => o.kind === "route_choice")!;
    expect(rc).toBeTruthy();
    expect(rc.reason).toMatch(/counts unavailable/);
    expect(rc.reason).not.toMatch(/\d+ food\/restroom place\(s\) within 40 km before/);
    expect(rc.candidateIds).toEqual([]);
    expect(rc.priority).not.toBe("high");
  });
});

/* ------------------------------------------------------------------ 3. overpass cacheOnly */
describe("overpass cacheOnly vs in-flight live query", () => {
  beforeEach(() => {
    clearOverpassCache();
    resetBudgets();
  });

  it("cacheOnly does not wait on an in-flight live query; after the live query lands, cacheOnly is served from memory", async () => {
    expect(process.env.UNCONGEST_DISK_CACHE).toBe("0");
    let resolveLive!: (r: Response) => void;
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          resolveLive = resolve;
          init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        })
    );
    const key = "req-test:inflight";
    const live = overpassQuery("[out:json];node(1);out;", { cacheKey: key, fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10_000, sessionId: "req-ovp" });
    // let the live call get past its (disabled) disk read and register as in-flight
    for (let i = 0; i < 50 && fetchImpl.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const t0 = Date.now();
    const settled = await Promise.race([
      overpassQuery("[out:json];node(1);out;", { cacheKey: key, cacheOnly: true, sessionId: "req-ovp" }).then(
        () => "resolved",
        (e: Error) => `rejected: ${e.message}`
      ),
      new Promise<string>((r) => setTimeout(() => r("hung"), 1000))
    ]);
    const ms = Date.now() - t0;
    expect(settled).toBe("rejected: not cached");
    expect(ms).toBeLessThan(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the cacheOnly call never fetched

    resolveLive(new Response(JSON.stringify({ elements: [{ type: "node", id: 1, lat: 44, lon: -78 }] }), { status: 200 }));
    const liveRes = await live;
    expect(liveRes.provenance).toBe("live");

    const hit = await overpassQuery("[out:json];node(1);out;", { cacheKey: key, cacheOnly: true, sessionId: "req-ovp" });
    expect(hit.provenance).toBe("cached");
    expect(hit.elements.map((e) => e.id)).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a non-cacheOnly caller still de-duplicates onto the in-flight query (control)", async () => {
    let resolveLive!: (r: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => (resolveLive = resolve)));
    const key = "req-test:dedupe";
    const a = overpassQuery("q", { cacheKey: key, fetchImpl: fetchImpl as unknown as typeof fetch, sessionId: "req-ovp" });
    for (let i = 0; i < 50 && fetchImpl.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    const b = overpassQuery("q", { cacheKey: key, fetchImpl: fetchImpl as unknown as typeof fetch, sessionId: "req-ovp" });
    resolveLive(new Response(JSON.stringify({ elements: [] }), { status: 200 }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.provenance).toBe("live");
    expect(rb.provenance).toBe("live");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ 4. tactical route */
describe("POST /api/recommend-stops — tactical workflow (demo fixtures, mock AI)", () => {
  function car(over: Partial<CarState> = {}): CarState {
    return { id: "car_a", label: "Car A", role: "lead", progressKm: 100, speedKph: 100, passengers: 4, kids: true, ev: false, positionUpdatedMinutesAgo: 0, needs: [], ...over };
  }
  function body(leadKm: number, over: Partial<RecommendStopsRequest["collectiveIntent"]> = {}, contextVersion = "ctx-v-42") {
    return {
      trip: { destination: "Montréal", direction: "toward destination", highway: "401", elapsedMinutes: 120, localTime: "12:15", minutesSinceLastStop: 120, lastMealMinutesAgo: null, localDate: "2026-11-03" },
      config: { avoidRegion: null, noOptionalStopsFirstMinutes: 30, maximumDetourMinutesPerCar: 12, maximumRegroupWaitMinutes: 20, advanceNoticeMinutes: 10, requiredDiet: [], groceriesCompleted: true, passengerLed: true },
      cars: [car({ progressKm: leadKm, needs: ["restroom"] })],
      collectiveIntent: { need: ["restroom"], hungerLevel: 0, dietary: [], maxDetourMinutes: 12, kids: true, restroomUrgent: true, notHungry: false, ...over },
      environment: { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300 },
      options: { weatherMode: "simulated", excludeStopIds: [] },
      context: {
        route: {
          id: "toronto-montreal-401",
          origin: { label: "Toronto", lat: 43.65, lng: -79.38, type: "home" },
          destination: { label: "Montréal", lat: 45.5, lng: -73.57, type: "hotel" }
        },
        sessionId: "req-tactical",
        dataMode: "demo",
        workflow: "tactical",
        contextVersion
      }
    };
  }
  const post = (b: unknown) => recommendPOST(new Request("http://x/api/recommend-stops", { method: "POST", body: JSON.stringify(b) }));

  it("urgent need but nothing reachable near the route end → 200, tactical fallback, SEARCH_FARTHER, contextVersion echoed", async () => {
    const res = await post(body(540));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.dataMode).toBe("demo");
    expect(json.tactical).toBeTruthy();
    expect(json.tactical.status).toBe("fallback");
    expect(typeof json.tactical.totalMs).toBe("number");
    expect(json.tactical.decision).toBe("SEARCH_FARTHER");
    expect(json.tactical.detail).toMatch(/searching farther/);
    expect(json.decidedFor).toEqual({ elapsedMinutes: 120, leadKm: 540, contextVersion: "ctx-v-42" });
    expect(json.recommendations ?? []).toEqual([]);
  });

  it("earlier on the route → 200, tactical meta present (Muse disabled → fallback), contextVersion echoed", async () => {
    const res = await post(body(100, {}, "ctx-v-7"));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Muse is disabled (AI_PROVIDER=mock) → never a "muse" decision; deterministic ranking instead
    expect(["fallback", "disabled"]).toContain(json.tactical.status);
    expect(json.tactical.provider).toMatch(/deterministic/);
    expect(json.tactical.decision).not.toBe("SEARCH_FARTHER");
    expect(json.decidedFor.contextVersion).toBe("ctx-v-7");
    expect(json.toolTrace.some((t: { tool: string }) => t.tool === "agent2.tactical")).toBe(true);
  });

  it("classic workflow (no context) has no tactical block and a null contextVersion", async () => {
    const b = body(100) as Record<string, unknown>;
    delete b.context;
    const res = await post(b);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.tactical).toBeUndefined();
    expect(json.decidedFor.contextVersion).toBeNull();
  });
});

/* ------------------------------------------------------------------ 5. strategic route */
describe("POST /api/strategic — validation", () => {
  const post = (raw: string) => strategicPOST(new Request("http://x/api/strategic", { method: "POST", body: raw }));

  it("schema-invalid body → 422 with Zod issues", async () => {
    const res = await post(JSON.stringify({ routeRef: { id: "x" }, leadKm: "far" }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/schema validation failed/);
    expect(Array.isArray(json.issues)).toBe(true);
    expect(json.issues.length).toBeGreaterThan(0);
  });

  it("non-JSON body → 422", async () => {
    const res = await post("not json {");
    expect(res.status).toBe(422);
  });

  it("invalid time zone → 422", async () => {
    const valid = { ...baseInput() } as Record<string, unknown>;
    const res = await post(JSON.stringify({ ...valid, timeZone: "Mars/Olympus_Mons" }));
    expect(res.status).toBe(422);
  });
});
