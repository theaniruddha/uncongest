import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBudgets } from "@/lib/providers/budget";
import { clearOverpassCache } from "@/lib/providers/overpass";
import { clearGeocodeCache, reverseGeocode, searchPlaces } from "@/lib/providers/geocode";
import {
  clearRoutingCache,
  douglasPeucker,
  getStoredRoute,
  resolveRoute,
  routeModelFor,
  RouteUnavailableError,
  simplifyRoute,
  exitsFromJunctions
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

beforeEach(() => {
  resetBudgets();
  clearOverpassCache();
  clearRoutingCache();
  clearGeocodeCache();
});

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

  it("falls back to OSRM off-ramp maneuvers when Overpass fails", async () => {
    const f = mockFetch({ overpass: () => json({ error: "busy" }, 504) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exits.map((e) => e.ref)).toEqual(["12A", "30"]);
    expect(r.exits[0].exitTo).toBe("Main St, Springfield");
    expect(r.attribution).toContain("OSRM off-ramp");
  });

  it("falls back to OSRM maneuvers when Overpass returns nothing", async () => {
    const f = mockFetch({ overpass: () => json({ elements: [] }) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exits).toHaveLength(2);
    expect(r.attribution).toContain("no junctions");
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
