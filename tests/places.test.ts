import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRouteModel, type RouteData, type RouteExit, type RouteModel } from "@/lib/route/model";
import { clearOverpassCache, type OverpassElement } from "@/lib/providers/overpass";
import { resetBudgets } from "@/lib/providers/budget";
import {
  MAX_CANDIDATES,
  classifyTags,
  discoverOsmPlaces,
  elementToCandidate,
  parseOpeningHours,
  vegOptionsFromTags,
  chargersFromTags,
  accessMinutesFor
} from "@/lib/providers/osmPlaces";
import { clearTomTomCache, searchAlongRouteTomTom, verifyWithTomTom } from "@/lib/providers/tomtom";
import { getBudget } from "@/lib/providers/budget";
import { RoutePlaceProvider, prefetchWindows, windowsForDecision } from "@/lib/providers/routePlaces";
import { evaluateCandidates } from "@/lib/domain/engine";
import type { CarState, CollectiveIntent, Environment, StopCandidate, TripConfig, TripContext } from "@/lib/domain/types";

// ---- synthetic straight route: lat 44, eastward ~80 km, exits at km 10/30/50/70 ----
const LAT = 44;
const KM_PER_DEG_LNG = 111.32 * Math.cos((LAT * Math.PI) / 180);
const lngAt = (km: number) => -78 + km / KM_PER_DEG_LNG;
const coords: Array<[number, number]> = [];
for (let k = 0; k <= 80; k += 1) coords.push([lngAt(k), LAT]);
const exitAt = (km: number, ref: string): RouteExit => ({ id: `ex-${ref}`, ref, name: null, exitTo: `Town ${ref}`, lat: LAT, lng: lngAt(km), km });
const EXITS = [exitAt(10, "10"), exitAt(30, "30"), exitAt(50, "50"), exitAt(70, "70")];
const routeData: RouteData = { id: "test-route", source: "test", attribution: "test", origin: "A", destination: "B", coordinates: coords, exits: EXITS };
const route: RouteModel = createRouteModel(routeData);
const noExitRoute: RouteModel = createRouteModel({ ...routeData, id: "test-noexit", exits: [] });

let nextId = 1;
/** Element near route km `km`, `northKm` off the road. */
function el(tags: Record<string, string>, km = 30, northKm = 0.5, type: "node" | "way" = "node"): OverpassElement {
  const lat = LAT + northKm / 110.57;
  const base = { type, id: nextId++, tags };
  return type === "node" ? { ...base, lat, lon: lngAt(km) } : { ...base, center: { lat, lon: lngAt(km) } };
}
const meta = { provenance: "live" as const, fetchedAt: "2026-11-03T12:00:00.000Z" };

function overpassFetch(elements: OverpassElement[]) {
  const bodies: string[] = [];
  const fn = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(decodeURIComponent(String(init?.body ?? "").replace(/^data=/, "").replace(/\+/g, " ")));
    return new Response(JSON.stringify({ elements }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, mock: fn, bodies };
}

const savedEnv = { live: process.env.TOMTOM_LIVE, key: process.env.TOMTOM_API_KEY, sess: process.env.TOMTOM_SESSION_LIMIT, ov: process.env.OVERPASS_LIVE };
function restoreEnv() {
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set("TOMTOM_LIVE", savedEnv.live);
  set("TOMTOM_API_KEY", savedEnv.key);
  set("TOMTOM_SESSION_LIMIT", savedEnv.sess);
  set("OVERPASS_LIVE", savedEnv.ov);
}

beforeEach(() => {
  delete process.env.TOMTOM_LIVE;
  delete process.env.TOMTOM_API_KEY;
  delete process.env.OVERPASS_LIVE;
  clearOverpassCache();
  clearTomTomCache();
  resetBudgets();
});
afterEach(() => {
  restoreEnv();
  resetBudgets();
});

describe("OSM tag mapping", () => {
  it("Tim Hortons: cafe with brand", () => {
    const c = elementToCandidate(el({ amenity: "cafe", name: "Tim Hortons", brand: "Tim Hortons", cuisine: "coffee_shop;donut" }), route, meta)!;
    expect(c.categories).toEqual(["coffee"]);
    expect(c.brand).toBe("Tim Hortons");
    expect(c.type).toBe("cafe");
    expect(c.isMock).toBe(false);
    expect(c.source).toBe("osm");
    expect(c.osmId).toMatch(/^node\/\d+$/);
    expect(c.restroomsVerified).toBeNull();
    expect(c.reviewCountMock).toBeUndefined();
    expect(c.qualityScoreMock).toBe(0.6);
    expect(c.exitLabel).toBe("Exit 30 (Town 30)");
    expect(c.distanceAlongRouteKm).toBe(30);
  });

  it("Subway: fast_food sandwich -> meal, vegOptions some", () => {
    const c = elementToCandidate(el({ amenity: "fast_food", name: "Subway", brand: "Subway", cuisine: "sandwich" }), route, meta)!;
    expect(c.categories).toEqual(["meal"]);
    expect(c.vegOptions).toBe("some");
    expect(c.dietaryVerified).toBeUndefined();
  });

  it("steakhouse -> vegOptions poor; explicit diet tags -> verified", () => {
    expect(vegOptionsFromTags({ amenity: "restaurant", cuisine: "steak_house" })?.level).toBe("poor");
    expect(vegOptionsFromTags({ amenity: "restaurant", cuisine: "indian" })?.level).toBe("good");
    expect(vegOptionsFromTags({ amenity: "restaurant", "diet:vegetarian": "only" })?.level).toBe("dedicated");
    const c = elementToCandidate(el({ amenity: "restaurant", name: "Veg Place", "diet:vegan": "yes", "diet:halal": "no" }), route, meta)!;
    expect(c.dietaryVerified).toEqual(["vegan"]);
    expect(c.vegetarianVerified).toBe(true);
  });

  it("highway=services plaza -> meal+coffee+restroom, restroomsVerified", () => {
    const c = elementToCandidate(el({ highway: "services", name: "ONroute Napanee" }, 30, 0.3, "way"), route, meta)!;
    expect(c.categories.sort()).toEqual(["coffee", "meal", "restroom"]);
    expect(c.restroomsVerified).toBe(true);
    expect(c.type).toBe("highway-plaza");
    expect(c.qualityScoreMock).toBe(0.65);
    expect(c.osmId).toMatch(/^way\//);
  });

  it("fuel with toilets=yes vs without", () => {
    const withT = classifyTags({ amenity: "fuel", name: "Esso", toilets: "yes" })!;
    expect(withT.categories).toEqual(["restroom"]);
    expect(withT.restroomsVerified).toBe(true);
    expect(withT.qualityScoreMock).toBe(0.55);
    const without = classifyTags({ amenity: "fuel", name: "Esso" })!;
    expect(without.categories).toEqual([]);
    expect(without.restroomsVerified).toBeNull();
  });

  it("unnamed restaurant skipped; unnamed toilets/rest area labelled; private toilets dropped", () => {
    expect(elementToCandidate(el({ amenity: "restaurant" }), route, meta)).toBeNull();
    expect(elementToCandidate(el({ amenity: "toilets" }), route, meta)?.name).toBe("Public washroom");
    expect(elementToCandidate(el({ highway: "rest_area" }), route, meta)?.name).toBe("Rest area");
    expect(elementToCandidate(el({ amenity: "toilets", access: "private" }), route, meta)).toBeNull();
  });

  it("charger sockets -> ChargerSpec", () => {
    expect(chargersFromTags({ "socket:tesla_supercharger": "8", "socket:tesla_supercharger:output": "250 kW", "socket:type1_combo": "2" })).toEqual([
      { connector: "NACS", powerKw: 250, count: 8 },
      { connector: "CCS1", powerKw: 0, count: 2 }
    ]);
  });

  it("accessMinutes from off-route distance", () => {
    expect(accessMinutesFor(0)).toBe(2);
    expect(accessMinutesFor(1)).toBeCloseTo(6.2, 1); // 1*1.4/40*60*2 + 2
  });

  it("uses synthetic exit label when route has no exits", () => {
    const c = elementToCandidate(el({ amenity: "cafe", name: "X" }, 42), noExitRoute, meta)!;
    expect(c.exitId).toBe("km-42");
    expect(c.exitLabel).toBe("Near km 42");
  });
});

describe("opening_hours parsing", () => {
  it("24/7", () => {
    expect(parseOpeningHours("24/7")).toMatchObject({ open24h: true, hoursVerified: true });
  });
  it("uniform daily range", () => {
    expect(parseOpeningHours("Mo-Su 06:00-22:00")).toMatchObject({ open24h: false, opensLocal: "06:00", closesLocal: "22:00", hoursVerified: true });
    expect(parseOpeningHours("6:00-23:00")).toMatchObject({ opensLocal: "06:00", closesLocal: "23:00", hoursVerified: true });
  });
  it("complex rules stay unverified with raw kept", () => {
    const p = parseOpeningHours("Mo-Fr 07:00-19:00; Sa 08:00-17:00");
    expect(p).toEqual({ open24h: false, hoursVerified: false, openingHoursRaw: "Mo-Fr 07:00-19:00; Sa 08:00-17:00" });
    expect(parseOpeningHours("06:00-02:00").hoursVerified).toBe(false);
    expect(parseOpeningHours(undefined)).toEqual({ open24h: false, hoursVerified: false });
  });
});

describe("discoverOsmPlaces", () => {
  it("queries only around exits inside the window, one query", async () => {
    const f = overpassFetch([el({ amenity: "fast_food", name: "Subway", cuisine: "sandwich" }, 30)]);
    const res = await discoverOsmPlaces(route, { minKm: 25, maxKm: 55 }, ["meal", "restroom"], { fetchImpl: f.fn });
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(res.query.startsWith("[out:json][timeout:25];")).toBe(true);
    expect(res.query).toContain("out center tags;");
    const arounds = [...res.query.matchAll(/around:(\d+),([-\d.]+),([-\d.]+)/g)];
    const lngs = new Set(arounds.map((m) => Number(m[3]).toFixed(4)));
    expect(lngs).toEqual(new Set([lngAt(30).toFixed(4), lngAt(50).toFixed(4)]));
    expect(arounds.every((m) => m[1] === "2500")).toBe(true);
    expect(f.bodies[0]).toContain("around:2500");
    expect(res.provenance).toBe("live");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].provenance).toBe("live");

    // second identical call: cached, no fetch
    const again = await discoverOsmPlaces(route, { minKm: 25, maxKm: 55 }, ["restroom", "meal"], { fetchImpl: f.fn });
    expect(f.mock).toHaveBeenCalledTimes(1);
    expect(again.provenance).toBe("cached");
  });

  it("exit-less window samples the route with a 1.5 km radius", async () => {
    const f = overpassFetch([]);
    const res = await discoverOsmPlaces(noExitRoute, { minKm: 0, maxKm: 40 }, ["coffee"], { fetchImpl: f.fn });
    const arounds = [...res.query.matchAll(/around:(\d+),/g)];
    expect(arounds.length).toBeGreaterThan(0);
    expect(arounds.every((m) => m[1] === "1500")).toBe(true);
    expect(res.query).toContain("cafe");
    expect(res.query).not.toContain("toilets");
  });

  it("filters to requested needs and caps at 25, ranked by relevance", async () => {
    const elements: OverpassElement[] = [];
    for (let i = 0; i < 40; i++) elements.push(el({ amenity: "restaurant", name: `R${i}` }, 30, 0.2 + i * 0.05));
    elements.push(el({ highway: "services", name: "Plaza" }, 50, 1.5));
    elements.push(el({ shop: "supermarket", name: "Walmart" }, 30)); // grocery not requested
    const f = overpassFetch(elements);
    const res = await discoverOsmPlaces(route, { minKm: 25, maxKm: 55 }, ["meal", "restroom"], { fetchImpl: f.fn });
    expect(res.candidates).toHaveLength(MAX_CANDIDATES);
    expect(res.candidates[0].name).toBe("Plaza"); // serves meal + restroom
    expect(res.candidates.some((c) => c.name === "Walmart")).toBe(false);
    expect(res.candidates[1].name).toBe("R0"); // closest restaurant next
  });

  it("real candidates feed evaluateCandidates; unverified hours are not rejected for hours", async () => {
    const f = overpassFetch([
      el({ amenity: "fast_food", name: "Subway", cuisine: "sandwich", opening_hours: "Mo-Fr 07:00-19:00; Sa 08:00-17:00" }, 30),
      el({ highway: "services", name: "Plaza", opening_hours: "24/7" }, 50),
      el({ amenity: "restaurant", name: "Steer House", cuisine: "steak_house", opening_hours: "Mo-Su 11:00-22:00" }, 50)
    ]);
    const provider = new RoutePlaceProvider(route, { fetchImpl: f.fn });
    const stops = await provider.getCandidates("initial", { minKm: 25, maxKm: 55, needs: ["meal"] });
    expect(stops).toHaveLength(3);
    expect(provider.name).toBe("osm-places");
    expect(provider.trace.join("\n")).toMatch(/tile km \d+–\d+: \d+ place\(s\), live/);

    const cars: CarState[] = [
      { id: "a", label: "A", role: "lead", progressKm: 0, speedKph: 100, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: ["meal"] },
      { id: "b", label: "B", role: "passenger", progressKm: -1, speedKph: 100, passengers: 2, kids: false, ev: false, positionUpdatedMinutesAgo: 0, needs: [] }
    ];
    const intent: CollectiveIntent = { need: ["meal"], hungerLevel: 2, dietary: ["vegetarian"], maxDetourMinutes: 15, kids: false };
    const config: TripConfig = {
      avoidRegion: null,
      noOptionalStopsFirstMinutes: 0,
      maximumDetourMinutesPerCar: 15,
      maximumRegroupWaitMinutes: 15,
      advanceNoticeMinutes: 10,
      requiredDiet: ["vegetarian"],
      groceriesCompleted: false,
      passengerLed: true
    };
    const trip: TripContext = { destination: "B", direction: "east", highway: "T", elapsedMinutes: 120, localTime: "05:30" };
    const env: Environment = { weather: "sunny", trafficDelayMinutes: 0, daylightMinutes: 300 };
    const { eligible, rejected } = evaluateCandidates(stops, cars, intent, config, trip, env);
    const ids = (name: string) => stops.find((s: StopCandidate) => s.name === name)!.id;
    expect(eligible.map((e) => e.stop.id)).toContain(ids("Subway")); // 05:30 ETA, hours unverified → not rejected
    expect(eligible.map((e) => e.stop.id)).toContain(ids("Plaza"));
    const steer = rejected.find((r) => r.stopId === ids("Steer House"))!;
    expect(steer.reasons.join(" ")).toMatch(/veg-friendly/);
    expect(steer.reasons.join(" ")).toMatch(/opens 11:00/); // verified hours do apply
  });

  it("Overpass failure → [] with trace, never fabricated", async () => {
    const fail = vi.fn(async () => new Response("busy", { status: 504 })) as unknown as typeof fetch;
    const provider = new RoutePlaceProvider(route, { fetchImpl: fail });
    const stops = await provider.getCandidates("nextExits", { minKm: 25, maxKm: 55, needs: ["meal"] });
    expect(stops).toEqual([]);
    expect(provider.trace.join("\n")).toMatch(/OSM lookup failed/);
  });
});

describe("windowsForDecision", () => {
  it("one window for short horizons, two for long, none past the end", () => {
    expect(windowsForDecision(100, 100, 60, 500)).toEqual([{ minKm: 100 + 100 / 6, maxKm: 160 }]);
    const two = windowsForDecision(100, 120, 120, 500);
    expect(two).toHaveLength(2);
    expect(two[0].maxKm).toBe(two[1].minKm);
    expect(two[1].maxKm).toBe(220);
    expect(windowsForDecision(495, 100, 60, 500)).toEqual([]);
  });
});

describe("TomTom verifier", () => {
  const cand = (name: string, osmId: string): StopCandidate =>
    ({ ...elementToCandidate(el({ amenity: "cafe", name }), route, meta)!, osmId });
  const ttResponse = () =>
    new Response(
      JSON.stringify({
        results: [
          {
            dist: 40,
            poi: {
              name: "Tim Hortons",
              brands: [{ name: "Tim Hortons" }],
              openingHours: {
                mode: "nextSevenDays",
                timeRanges: [{ startTime: { date: "2026-11-03", hour: 6, minute: 0 }, endTime: { date: "2026-11-03", hour: 23, minute: 0 } }]
              }
            }
          }
        ]
      }),
      { status: 200 }
    );
  const enable = (sessionLimit: string) => {
    process.env.TOMTOM_LIVE = "1";
    process.env.TOMTOM_API_KEY = "test";
    process.env.TOMTOM_SESSION_LIMIT = sessionLimit;
    resetBudgets();
  };

  it("disabled → skipped, no fetch", async () => {
    const f = vi.fn(async () => ttResponse());
    const r = await verifyWithTomTom(cand("Tim Hortons", "node/1"), { fetchImpl: f as unknown as typeof fetch });
    expect(r.status).toBe("skipped");
    expect(r.reason).toMatch(/disabled/);
    expect(f).not.toHaveBeenCalled();
  });

  it("budget 1: first call fetches, second distinct call skipped; cache hit is free", async () => {
    enable("1");
    const f = vi.fn(async () => ttResponse());
    const fi = f as unknown as typeof fetch;
    const first = await verifyWithTomTom(cand("Tim Hortons", "node/1"), { fetchImpl: fi, sessionId: "s" });
    expect(first.status).toBe("verified");
    expect(first.patch).toMatchObject({ opensLocal: "06:00", closesLocal: "23:00", hoursVerified: true, brand: "Tim Hortons" });
    expect(f).toHaveBeenCalledTimes(1);
    const url = String((f.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("radius=300");
    expect(url).toContain("openingHours=nextSevenDays");

    const second = await verifyWithTomTom(cand("Other Cafe", "node/2"), { fetchImpl: fi, sessionId: "s" });
    expect(second.status).toBe("skipped");
    expect(second.reason).toMatch(/budget exhausted/);
    expect(f).toHaveBeenCalledTimes(1);

    const again = await verifyWithTomTom(cand("Tim Hortons", "node/1"), { fetchImpl: fi, sessionId: "s" });
    expect(again.status).toBe("verified");
    expect(again.cached).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("not_found when TomTom has no POI", async () => {
    enable("5");
    const f = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const r = await verifyWithTomTom(cand("Nowhere", "node/9"), { fetchImpl: f as unknown as typeof fetch });
    expect(r.status).toBe("not_found");
    expect(r.patch).toBeUndefined();
  });
});

describe("TomTom along-route fallback", () => {
  const ttResults = [
    {
      id: "tt-1",
      detourTime: 240,
      position: { lat: LAT + 0.004, lon: lngAt(30) },
      poi: {
        name: "Tim Hortons",
        brands: [{ name: "Tim Hortons" }],
        categorySet: [{ id: 9376002 }],
        categories: ["café", "café/pub"],
        classifications: [{ code: "CAFE_PUB", names: [{ name: "café" }] }],
        openingHours: { mode: "nextSevenDays", timeRanges: [{ startTime: { date: "2026-11-03", hour: 5, minute: 0 }, endTime: { date: "2026-11-03", hour: 23, minute: 0 } }] }
      }
    },
    {
      id: "tt-2",
      detourTime: 420,
      position: { lat: LAT + 0.01, lon: lngAt(50) },
      poi: { name: "Big Steer", categorySet: [{ id: 7315 }], categories: ["restaurant", "steak house"], classifications: [{ code: "RESTAURANT", names: [{ name: "steak house" }] }] }
    },
    {
      id: "tt-3",
      detourTime: 60,
      position: { lat: LAT + 0.001, lon: lngAt(40) },
      poi: { name: "Rest Area Km 40", categorySet: [{ id: 7395 }], classifications: [{ code: "REST_AREA" }] }
    }
  ];
  /** Overpass always fails (504) or returns `osm`; TomTom returns ttResults. */
  function routerFetch(osm: OverpassElement[] | "fail") {
    const tomtomCalls: Array<{ url: string; init?: RequestInit }> = [];
    const osmCalls: string[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.tomtom.com")) {
        tomtomCalls.push({ url: u, init });
        return new Response(JSON.stringify({ results: ttResults }), { status: 200 });
      }
      osmCalls.push(u);
      if (osm === "fail") return new Response("busy", { status: 504 });
      return new Response(JSON.stringify({ elements: osm }), { status: 200 });
    });
    return { fn: fn as unknown as typeof fetch, tomtomCalls, osmCalls };
  }
  const enable = () => {
    process.env.TOMTOM_LIVE = "1";
    process.env.TOMTOM_API_KEY = "test";
    resetBudgets();
  };

  it("disabled (default): no TomTom fetch, trace says skipped", async () => {
    const f = routerFetch("fail");
    const provider = new RoutePlaceProvider(route, { fetchImpl: f.fn });
    const stops = await provider.getCandidates("initial", { minKm: 25, maxKm: 55, needs: ["meal"] });
    expect(stops).toEqual([]);
    expect(f.osmCalls.length).toBeGreaterThan(0);
    expect(f.tomtomCalls).toHaveLength(0);
    expect(provider.trace.join("\n")).toMatch(/tomtom along-route fallback skipped: disabled/);
    const direct = await searchAlongRouteTomTom(route, { minKm: 25, maxKm: 55 }, ["meal"], { fetchImpl: f.fn });
    expect(direct.status).toBe("skipped");
    expect(f.tomtomCalls).toHaveLength(0);
  });

  it("enabled: one POST with route points, maps results, cache hit spends nothing", async () => {
    enable();
    const f = routerFetch([]);
    const res = await searchAlongRouteTomTom(route, { minKm: 25, maxKm: 55 }, ["meal", "coffee", "restroom"], { fetchImpl: f.fn, sessionId: "s" });
    expect(res.status).toBe("ok");
    expect(f.tomtomCalls).toHaveLength(1);
    const call = f.tomtomCalls[0];
    expect(call.init?.method).toBe("POST");
    expect(call.url).toContain("/search/2/searchAlongRoute/");
    expect(call.url).toContain("maxDetourTime=600");
    expect(call.url).toContain("limit=20");
    expect(call.url).toMatch(/categorySet=[\d,]+/);
    const body = JSON.parse(String(call.init?.body)) as { route: { points: Array<{ lat: number; lon: number }> } };
    expect(body.route.points.length).toBeGreaterThanOrEqual(2);
    expect(body.route.points.length).toBeLessThanOrEqual(150);
    expect(body.route.points[0].lat).toBe(LAT);
    expect(body.route.points[0].lon).toBeCloseTo(lngAt(25), 2);

    const byName = (n: string) => res.candidates.find((c) => c.name === n)!;
    const tim = byName("Tim Hortons");
    expect(tim).toMatchObject({ source: "tomtom", isMock: false, provenance: "live", categories: ["coffee"], accessMinutes: 4, hoursVerified: true, opensLocal: "05:00", closesLocal: "23:00", restroomsVerified: null, brand: "Tim Hortons", exitLabel: "Exit 30 (Town 30)", distanceAlongRouteKm: 30 });
    const steer = byName("Big Steer");
    expect(steer).toMatchObject({ categories: ["meal"], vegOptions: "poor", accessMinutes: 7, hoursVerified: false, open24h: false });
    const rest = byName("Rest Area Km 40");
    expect(rest).toMatchObject({ categories: ["restroom"], restroomsVerified: null, accessMinutes: 2, type: "rest-area" });
    expect(getBudget("tomtom").usage("s").usedThisSession).toBe(1);

    const again = await searchAlongRouteTomTom(route, { minKm: 25, maxKm: 55 }, ["restroom", "coffee", "meal"], { fetchImpl: f.fn, sessionId: "s" });
    expect(again.provenance).toBe("cached");
    expect(again.candidates).toHaveLength(3);
    expect(f.tomtomCalls).toHaveLength(1);
    expect(getBudget("tomtom").usage("s").usedThisSession).toBe(1);
    expect(getBudget("tomtom").usage("s").cacheHits).toBe(1);
  });

  it("fallback only triggers when every OSM tile failed", async () => {
    enable();
    const ok = routerFetch([]); // OSM works, just 0 places
    const p1 = new RoutePlaceProvider(route, { fetchImpl: ok.fn });
    expect(await p1.getCandidates("initial", { minKm: 25, maxKm: 55, needs: ["meal"] })).toEqual([]);
    expect(ok.tomtomCalls).toHaveLength(0);
    expect(p1.name).toBe("osm-places");

    clearOverpassCache();
    const bad = routerFetch("fail");
    const p2 = new RoutePlaceProvider(route, { fetchImpl: bad.fn });
    const stops = await p2.getCandidates("initial", { minKm: 25, maxKm: 55, needs: ["meal"] });
    expect(bad.tomtomCalls).toHaveLength(1);
    expect(stops.map((s) => s.name)).toEqual(["Big Steer"]); // only meal-relevant
    expect(p2.name).toBe("osm-places+tomtom");
    expect(p2.trace.join("\n")).toMatch(/tomtom along-route fallback: 1 place/);
  });

  it("prefetchWindows falls back per failed window", async () => {
    enable();
    const bad = routerFetch("fail");
    const res = await prefetchWindows(route, [{ minKm: 25, maxKm: 55 }], { fetchImpl: bad.fn });
    expect(bad.tomtomCalls).toHaveLength(1);
    expect(res.candidates.length).toBe(3);
    expect(res.trace.join("\n")).toMatch(/tomtom along-route fallback: 3 place/);
  });
});
