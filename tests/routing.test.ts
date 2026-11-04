import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBudgets } from "@/lib/providers/budget";
import { clearOverpassCache, OVERPASS_ENDPOINTS } from "@/lib/providers/overpass";
import { clearGeocodeCache, reverseGeocode, searchPlaces } from "@/lib/providers/geocode";
import {
  clearRoutingCache,
  douglasPeucker,
  getStoredRoute,
  resolveRoute,
  routeModelFor,
  RouteUnavailableError,
  simplifyRoute,
  exitsFromJunctions,
  recordRoute,
  routeCacheDir,
  recordedRoutesDir,
  resolveExits
} from "@/lib/providers/routing";
import { tripRouteSchema, type PlaceRef } from "@/lib/trip/types";

type LngLat = [number, number];

const place = (label: string, lat: number, lng: number): PlaceRef => ({ label, lat, lng, type: "other", source: "search" });

// Synthetic gently curving eastbound road, ~80 km, 2000 vertices.
const LINE: LngLat[] = Array.from({ length: 2000 }, (_, i) => {
  const lng = -80 + i * 0.0005;
  return [lng, 43 + 0.02 * Math.sin(i / 150)];
});
const at = (i: number) => ({ lng: LINE[i][0], lat: LINE[i][1] });

const ORIGIN = place("Start", LINE[0][1], LINE[0][0]);
const DEST = place("End", LINE[LINE.length - 1][1], LINE[LINE.length - 1][0]);

function osrmOk() {
  return {
    code: "Ok",
    routes: [
      {
        distance: 80000,
        duration: 3600,
        geometry: { type: "LineString", coordinates: LINE },
        legs: [
          {
            steps: [
              { name: "", maneuver: { type: "depart", location: LINE[0] } },
              { name: "Main St", exits: "12A;12B", destinations: "Main St, Springfield", maneuver: { type: "off ramp", location: LINE[400] } },
              { name: "", exits: "12B", maneuver: { type: "off ramp", location: LINE[402] } }, // A/B dedupe
              { name: "Second Ave", maneuver: { type: "turn", location: LINE[600] } }, // not an exit
              { name: "Hwy 9", exits: "30", maneuver: { type: "fork", location: LINE[1500] } },
              { name: "", maneuver: { type: "arrive", location: LINE[1999] } }
            ]
          }
        ]
      }
    ]
  };
}

function overpassOk() {
  const a = at(300);
  const b = at(306); // ~250 m later, same base ref → collapsed
  const c = at(1200);
  const off = at(800);
  return {
    elements: [
      { type: "node", id: 1, lat: a.lat, lon: a.lng, tags: { highway: "motorway_junction", ref: "10A", exit_to: "Foo Rd" } },
      { type: "node", id: 2, lat: b.lat, lon: b.lng, tags: { highway: "motorway_junction", ref: "10B" } },
      { type: "node", id: 3, lat: c.lat, lon: c.lng, tags: { highway: "motorway_junction", ref: "25", name: "Bar Interchange" } },
      { type: "node", id: 4, lat: off.lat + 0.005, lon: off.lng, tags: { highway: "motorway_junction", ref: "99" } } // ~550 m off route
    ]
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function mockFetch(handlers: { osrm?: () => Response; overpass?: () => Response; meteo?: () => Response; nominatim?: (url: string) => Response }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("router.project-osrm.org")) return handlers.osrm ? handlers.osrm() : json(osrmOk());
    if (url.includes("interpreter")) return handlers.overpass ? handlers.overpass() : json(overpassOk());
    if (url.includes("open-meteo")) return handlers.meteo ? handlers.meteo() : json({ timezone: "America/New_York" });
    if (url.includes("nominatim")) return handlers.nominatim ? handlers.nominatim(url) : json([]);
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "uncongest-routing-"));
  process.env.UNCONGEST_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.UNCONGEST_RECORDED_DIR = path.join(tmpRoot, "recorded");
  resetBudgets();
  clearOverpassCache();
  clearRoutingCache();
  clearGeocodeCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.UNCONGEST_CACHE_DIR;
  delete process.env.UNCONGEST_RECORDED_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const noNetwork = vi.fn(async () => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

describe("resolveRoute", () => {
  it("short-circuits Toronto → Montréal to the offline fixture", async () => {
    const f = mockFetch({});
    const r = await resolveRoute(place("Toronto", 43.65, -79.38), place("Montréal", 45.5, -73.57), { fetchImpl: f });
    expect(r.source).toBe("fixture");
    expect(r.timezone).toBe("America/Toronto");
    expect(r.exits.length).toBeGreaterThan(50);
    expect(r.distanceKm).toBeGreaterThan(500);
    expect(f).not.toHaveBeenCalled();
    expect(getStoredRoute(r.id)?.id).toBe(r.id);
  });

  it("builds a validated TripRoute from OSRM with Overpass exits projected and deduped", async () => {
    const f = mockFetch({});
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(() => tripRouteSchema.parse(r)).not.toThrow();
    expect(r.source).toBe("osrm");
    expect(r.id).toMatch(/^osrm-/);
    expect(r.timezone).toBe("America/New_York");
    expect(r.durationMinutes).toBe(60);
    expect(r.distanceKm).toBeGreaterThan(75);
    expect(r.distanceKm).toBeLessThan(90);
    expect(r.coordinates.length).toBeLessThan(LINE.length);
    expect(r.coordinates[0]).toEqual([+LINE[0][0].toFixed(5), +LINE[0][1].toFixed(5)]);
    expect(r.exits.map((e) => e.ref)).toEqual(["10A", "25"]);
    expect(r.exits[0].exitTo).toBe("Foo Rd");
    expect(r.exits[0].km).toBeLessThan(r.exits[1].km);
    expect(r.attribution).toContain("Overpass");
    // Overpass query is one union of ≤ 6 corridor bboxes
    const overpassCalls = f.mock.calls.filter(([u]) => String(u).includes("interpreter"));
    expect(overpassCalls).toHaveLength(1);
    const body = decodeURIComponent(String((overpassCalls[0][1] as RequestInit).body).replace(/\+/g, " "));
    const boxes = body.match(/motorway_junction"\]\(/g) ?? [];
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.length).toBeLessThanOrEqual(6);
    // model + store
    const model = routeModelFor(r);
    expect(model.totalKm).toBeCloseTo(r.distanceKm, 1);
    expect(getStoredRoute(r.id)).toBeDefined();
  });

  it("retries Overpass once, then falls back to OSRM ramp steps", async () => {
    const f = mockFetch({ overpass: () => json({ error: "busy" }, 504) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exits.map((e) => e.ref)).toEqual(["12A", "30"]);
    expect(r.exits[0].exitTo).toBe("Main St, Springfield");
    expect(r.attribution).toContain("OSRM ramp steps (OSM junctions unavailable)");
    // 2 attempts × (primary + mirrors)
    expect(f.mock.calls.filter(([u]) => String(u).includes("interpreter"))).toHaveLength(2 * OVERPASS_ENDPOINTS.length);
    // degraded routes are never persisted to disk
    expect(existsSync(path.join(routeCacheDir(), `${r.id}.json`))).toBe(false);
  });

  it("falls back to OSRM maneuvers when Overpass returns nothing", async () => {
    const f = mockFetch({ overpass: () => json({ elements: [] }) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exits).toHaveLength(2);
    expect(r.attribution).toContain("OSRM ramp steps (no OSM junctions found)");
  });

  it("projects junctions against the full geometry (kept near a curve the simplified line cuts)", async () => {
    // Straight road with a 25 m bump (below the 30 m DP tolerance, so simplification flattens it).
    const BUMP = 25 / 110570;
    const line: LngLat[] = Array.from({ length: 500 }, (_, i) => [-80 + i * 0.001, 43 + Math.max(0, 1 - Math.abs(i - 250) / 3) * BUMP]);
    // Junction 10 m beyond the bump apex: 10 m from the full line, ~35 m from the simplified one.
    const junction = { type: "node" as const, id: 77, lat: 43 + BUMP + 10 / 110570, lon: line[250][0], tags: { ref: "5" } };
    const osrm = osrmOk();
    osrm.routes[0].geometry.coordinates = line;
    const f = mockFetch({ osrm: () => json(osrm), overpass: () => json({ elements: [junction] }) });
    const r = await resolveRoute(place("A", 43, -80), place("B", 43, line[499][0]), { fetchImpl: f });
    expect(r.coordinates.length).toBeLessThan(10);
    // Simplified-line projection alone would drop it…
    expect(exitsFromJunctions(r.coordinates, [junction])).toHaveLength(0);
    // …but the full-line projection keeps it, with km rescaled onto the simplified line.
    expect(r.exits.map((e) => e.ref)).toEqual(["5"]);
    expect(r.exits[0].km).toBeCloseTo(r.distanceKm / 2, 1);
    expect(r.exits[0].km).toBeLessThanOrEqual(r.distanceKm);
  });

  it("succeeds on the Overpass retry after one failed attempt", async () => {
    let n = 0;
    const f = mockFetch({ overpass: () => (++n <= 2 ? json({}, 504) : json(overpassOk())) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exits.map((e) => e.ref)).toEqual(["10A", "25"]);
    expect(r.attribution).toContain("Overpass motorway_junction");
  });

  it("caches degraded routes for only 10 minutes, then retries Overpass", async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    const bad = mockFetch({ overpass: () => json({}, 504) });
    const first = await resolveRoute(ORIGIN, DEST, { fetchImpl: bad });
    expect(first.attribution).toContain("OSM junctions unavailable");

    clock.mockReturnValue(t0 + 9 * 60 * 1000);
    const cached = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork });
    expect(cached.source).toBe("cache");

    clock.mockReturnValue(t0 + 11 * 60 * 1000);
    const good = mockFetch({});
    const fresh = await resolveRoute(ORIGIN, DEST, { fetchImpl: good });
    expect(fresh.source).toBe("osrm");
    expect(fresh.exits.map((e) => e.ref)).toEqual(["10A", "25"]);

    // healthy routes keep the 24 h TTL
    clock.mockReturnValue(t0 + 11 * 60 * 1000 + 23 * 60 * 60 * 1000);
    expect((await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork })).source).toBe("cache");
  });

  it("persists healthy routes to the disk cache and reads them on a memory miss", async () => {
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch({}) });
    const file = path.join(routeCacheDir(), `${r.id}.json`);
    expect(existsSync(file)).toBe(true);
    clearRoutingCache(); // memory only
    const again = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork });
    expect(again.source).toBe("cache");
    expect(again.id).toBe(r.id);
    expect(again.exits).toEqual(r.exits);
    expect(getStoredRoute(r.id)).toBeDefined();
  });

  it("reads committed recordings (never writes them) with a recorded suffix", async () => {
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch({}) });
    const recFile = await recordRoute(r);
    expect(recFile).toBe(path.join(recordedRoutesDir(), `${r.id}.json`));
    unlinkSync(path.join(routeCacheDir(), `${r.id}.json`));
    clearRoutingCache();
    const rec = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork });
    expect(rec.source).toBe("cache");
    expect(rec.attribution).toContain(` · recorded ${r.fetchedAt.slice(0, 10)}`);
    expect(existsSync(path.join(routeCacheDir(), `${r.id}.json`))).toBe(false);
  });

  it("tolerates an unwritable / unreadable cache dir", async () => {
    const blocker = path.join(tmpRoot, "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.UNCONGEST_CACHE_DIR = blocker; // mkdir/read under a file → ENOTDIR
    process.env.UNCONGEST_RECORDED_DIR = path.join(blocker, "recorded");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch({}) });
    expect(r.source).toBe("osrm");
    expect(r.exits).toHaveLength(2);
  });

  it("throws RouteUnavailableError on OSRM NoRoute", async () => {
    const f = mockFetch({ osrm: () => json({ code: "NoRoute", message: "Impossible route between points" }, 400) });
    await expect(resolveRoute(ORIGIN, place("Island", 30, -40), { fetchImpl: f })).rejects.toBeInstanceOf(RouteUnavailableError);
  });

  it("falls back to America/Toronto when Open-Meteo fails", async () => {
    const f = mockFetch({ meteo: () => json({}, 500) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.timezone).toBe("America/Toronto");
  });

  it("serves the second identical request from cache without fetching", async () => {
    const f = mockFetch({});
    const first = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    const calls = f.mock.calls.length;
    const second = await resolveRoute({ ...ORIGIN, label: "Start again" }, DEST, { fetchImpl: f });
    expect(f.mock.calls.length).toBe(calls);
    expect(second.source).toBe("cache");
    expect(second.id).toBe(first.id);
    expect(second.origin.label).toBe("Start again");
  });
});

describe("progressive loading (exits: defer)", () => {
  const ALT: LngLat[] = Array.from({ length: 1500 }, (_, i) => [-80 + i * 0.000667, 43 - 0.03 * Math.sin(i / 120)]);
  function osrmWithAlt() {
    const o = osrmOk() as ReturnType<typeof osrmOk> & { routes: Array<Record<string, unknown>> };
    (o.routes[0].legs as Array<Record<string, unknown>>)[0].summary = "Hwy 401, Main St";
    o.routes.push({
      distance: 85000,
      duration: 4200,
      geometry: { type: "LineString", coordinates: ALT },
      legs: [{ summary: "QEW, I-190", steps: [] }]
    });
    return o;
  }
  function overpassWithBorder() {
    const base = overpassOk();
    const b1 = at(1000);
    const b2 = at(1010); // ~0.4 km later → same crossing
    base.elements.push(
      { type: "node", id: 50, lat: b1.lat + 0.001, lon: b1.lng, tags: { barrier: "border_control", name: "Peace Bridge Customs" } } as never,
      { type: "way", id: 51, center: { lat: b2.lat, lon: b2.lng }, tags: { barrier: "border_control" } } as never
    );
    return base;
  }
  const interpreterCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter(([u]) => String(u).includes("interpreter")).length;
  const osrmCalls = (f: ReturnType<typeof mockFetch>) => f.mock.calls.filter(([u]) => String(u).includes("project-osrm")).length;

  it("returns geometry before Overpass is called, then resolveExits fills exits without a second OSRM call", async () => {
    const f = mockFetch({ osrm: () => json(osrmWithAlt()), overpass: () => json(overpassWithBorder()) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    expect(r.exitsStatus).toBe("pending");
    expect(r.exits).toEqual([]);
    expect(r.source).toBe("osrm");
    expect(interpreterCalls(f)).toBe(0);
    expect(String(f.mock.calls.find(([u]) => String(u).includes("project-osrm"))?.[0])).toContain("alternatives=true");
    // pending route is reused (no second OSRM)
    const again = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    expect(again.exitsStatus).toBe("pending");
    expect(osrmCalls(f)).toBe(1);

    const ready = await resolveExits(r.id, { fetchImpl: f });
    expect(osrmCalls(f)).toBe(1);
    expect(interpreterCalls(f)).toBe(1);
    expect(ready.exitsStatus).toBe("ready");
    expect(ready.exits.map((e) => e.ref)).toEqual(["10A", "25"]);
    expect(ready.borderCrossings).toHaveLength(1);
    expect(ready.borderCrossings[0].name).toBe("Peace Bridge Customs");
    expect(ready.borderCrossings[0].km).toBeGreaterThan(35);
    expect(ready.borderCrossings[0].km).toBeLessThan(45);
    expect(() => tripRouteSchema.parse(ready)).not.toThrow();
    const body = decodeURIComponent(String((f.mock.calls.find(([u]) => String(u).includes("interpreter"))![1] as RequestInit).body).replace(/\+/g, " "));
    expect(body).toContain('node["barrier"="border_control"]');
    expect(body).toContain('way["barrier"="border_control"]');
    expect(body).toContain("out center");
    // later lookups get the ready route from memory
    const later = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork, exits: "defer" });
    expect(later.exitsStatus).toBe("ready");
    expect(later.source).toBe("cache");
  });

  it("runs the timezone lookup concurrently with OSRM", async () => {
    let meteoStarted!: () => void;
    const meteoSeen = new Promise<void>((res) => (meteoStarted = res));
    const order: string[] = [];
    const f = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("project-osrm")) {
        order.push("osrm:start");
        await meteoSeen; // would deadlock if the timezone call waited for OSRM
        order.push("osrm:end");
        return json(osrmOk());
      }
      if (url.includes("open-meteo")) {
        order.push("meteo:start");
        meteoStarted();
        return json({ timezone: "America/New_York" });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    expect(r.timezone).toBe("America/New_York");
    expect(order.indexOf("meteo:start")).toBeLessThan(order.indexOf("osrm:end"));
  });

  it("parses OSRM alternatives (≤ 2, simplified to ≤ 300 points, with summary)", async () => {
    const f = mockFetch({ osrm: () => json(osrmWithAlt()) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    expect(r.alternatives).toHaveLength(1);
    const alt = r.alternatives[0];
    expect(alt.id).toBe(`${r.id}-alt1`);
    expect(alt.summary).toBe("QEW, I-190");
    expect(alt.distanceKm).toBe(85);
    expect(alt.durationMinutes).toBe(70);
    expect(alt.coordinates.length).toBeLessThanOrEqual(300);
    expect(alt.coordinates.length).toBeGreaterThanOrEqual(2);
  });

  it("de-duplicates concurrent resolveExits calls (one Overpass request)", async () => {
    const f = mockFetch({ overpass: () => json(overpassWithBorder()) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    const [a, b, c] = await Promise.all([resolveExits(r.id, { fetchImpl: f }), resolveExits(r.id, { fetchImpl: f }), resolveExits(r.id, { fetchImpl: f })]);
    expect(interpreterCalls(f)).toBe(1);
    expect(a.exits).toEqual(b.exits);
    expect(c.exitsStatus).toBe("ready");
  });

  it("marks OSRM-step exits as degraded with the 10-minute TTL", async () => {
    const f = mockFetch({ overpass: () => json({}, 504) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = await resolveExits(r.id, { fetchImpl: f });
    expect(d.exitsStatus).toBe("degraded");
    expect(d.exits.map((e) => e.ref)).toEqual(["12A", "30"]);
    expect(d.borderCrossings).toEqual([]);
  });

  it("returns an already-ready cached route immediately in defer mode", async () => {
    await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch({}) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork, exits: "defer" });
    expect(r.exitsStatus).toBe("ready");
    expect(r.exits).toHaveLength(2);
    // also from disk after a memory wipe
    clearRoutingCache();
    const d = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNetwork, exits: "defer" });
    expect(d.exitsStatus).toBe("ready");
    expect(d.source).toBe("cache");
  });

  it("resolveExits re-resolves geometry from endpoints when the id is unknown", async () => {
    await expect(resolveExits("osrm-unknown", {})).rejects.toBeInstanceOf(RouteUnavailableError);
    const f = mockFetch({});
    const r = await resolveExits("osrm-whatever", { fetchImpl: f, origin: ORIGIN, destination: DEST });
    expect(r.exitsStatus).toBe("ready");
    expect(r.exits.map((e) => e.ref)).toEqual(["10A", "25"]);
  });
});

describe("Douglas–Peucker", () => {
  it("keeps endpoints and reduces points", () => {
    const out = douglasPeucker(LINE, 0.03);
    expect(out[0]).toEqual(LINE[0]);
    expect(out[out.length - 1]).toEqual(LINE[LINE.length - 1]);
    expect(out.length).toBeLessThan(LINE.length / 5);
    const straight: LngLat[] = Array.from({ length: 50 }, (_, i) => [-80 + i * 0.01, 43]);
    expect(douglasPeucker(straight, 0.03)).toEqual([straight[0], straight[49]]);
  });

  it("simplifyRoute caps the point count", () => {
    // winding road: ~100 m wiggles every ~10 m, so a 30 m tolerance alone would keep > 4000 points
    const zig: LngLat[] = Array.from({ length: 30000 }, (_, i) => [-80 + i * 0.0001, 43 + 0.001 * Math.sin(i / 1.5)]);
    expect(douglasPeucker(zig, 0.03).length).toBeGreaterThan(4000);
    const out = simplifyRoute(zig, 0.03, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out[0]).toEqual([-80, 43]);
    expect(out[out.length - 1]).toEqual([+zig[29999][0].toFixed(5), +zig[29999][1].toFixed(5)]);
  });
});

describe("Nominatim geocoding", () => {
  it("throttles to ≤ 1 req/s and caches by normalized query", async () => {
    const times: number[] = [];
    const f = mockFetch({
      nominatim: (url) => {
        times.push(Date.now());
        expect(url).toContain("countrycodes=ca%2Cus");
        expect(url).toContain("format=jsonv2");
        return json([{ display_name: "Kingston, Ontario, Canada", lat: "44.23", lon: "-76.48", type: "city" }]);
      }
    });
    const [a, b] = await Promise.all([searchPlaces("Kingston", { fetchImpl: f }), searchPlaces("Belleville", { fetchImpl: f })]);
    expect(a[0]).toEqual({ label: "Kingston, Ontario, Canada", lat: 44.23, lng: -76.48, kind: "city" });
    expect(b).toHaveLength(1);
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(950);
    // cache hit: normalized query, no new request
    await searchPlaces("  kingston ", { fetchImpl: f });
    expect(times).toHaveLength(2);
    // too short
    expect(await searchPlaces("ab", { fetchImpl: f })).toEqual([]);
    expect(times).toHaveLength(2);
  });

  it("sends a descriptive User-Agent and caches reverse lookups at 3 decimals", async () => {
    const f = mockFetch({ nominatim: () => json({ display_name: "Mississauga, Ontario, Canada" }) });
    const r = await reverseGeocode(43.5891, -79.6441, { fetchImpl: f });
    expect(r.label).toBe("Mississauga, Ontario, Canada");
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["User-Agent"]).toContain("uncongest-sim/0.2");
    await reverseGeocode(43.58912, -79.64408, { fetchImpl: f });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
