import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBudgets } from "@/lib/providers/budget";
import { clearOverpassCache } from "@/lib/providers/overpass";
import {
  clearRoutingCache,
  generateAlternatives,
  getStoredRoute,
  resolveRoute,
  routeOverlap,
  viaCandidates
} from "@/lib/providers/routing";
import { tripRouteSchema, type PlaceRef } from "@/lib/trip/types";

type LngLat = [number, number];
const place = (label: string, lat: number, lng: number): PlaceRef => ({ label, lat, lng, type: "other", source: "search" });

// Main road: ~81 km eastbound along 43°N (gentle curve).
const LINE: LngLat[] = Array.from({ length: 2000 }, (_, i) => [-80 + i * 0.0005, 43 + 0.02 * Math.sin(i / 150)]);
const ORIGIN = place("Start", LINE[0][1], LINE[0][0]);
const DEST = place("End", LINE[1999][1], LINE[1999][0]);

/** Polyline through the given corners, densified to ~200 m spacing. */
function path_(...pts: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (let k = 1; k < pts.length; k++) {
    const [a, b] = [pts[k - 1], pts[k]];
    const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.002));
    for (let i = 0; i < n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const START = LINE[0];
const END = LINE[1999];
const SOUTH = path_(START, [-79.8, 42.9], [-79.2, 42.9], END); // diverges ~11 km south
const SOUTH_DUP = SOUTH.map(([x, y]) => [x + 0.001, y + 0.002] as LngLat); // near-duplicate of SOUTH
const NORTH = path_(START, [-79.8, 43.12], [-79.2, 43.12], END); // diverges north

const osrmRoute = (coordinates: LngLat[], durationS: number, summary: string, legs = 1) => ({
  distance: coordinates.reduce((s, c, i) => (i ? s + Math.hypot((c[0] - coordinates[i - 1][0]) * 81.4, (c[1] - coordinates[i - 1][1]) * 111.2) : 0), 0) * 1000,
  duration: durationS,
  geometry: { type: "LineString", coordinates },
  legs: Array.from({ length: legs }, (_, i) => ({ summary: i === 0 ? summary.split(" / ")[0] : summary.split(" / ")[1] ?? "", steps: [] }))
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Opts {
  native?: boolean;
  via?: (v: { lat: number; lng: number }) => unknown;
}
function mockFetch(o: Opts = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("project-osrm")) {
      const coords = decodeURIComponent(url.split("/driving/")[1].split("?")[0]).split(";");
      if (coords.length === 2) {
        const routes = [osrmRoute(LINE, 3600, "QEW")];
        if (o.native) routes.push(osrmRoute(NORTH, 4000, "Hwy 8"));
        return json({ code: "Ok", routes });
      }
      const [lng, lat] = coords[1].split(",").map(Number);
      return json(o.via ? o.via({ lat, lng }) : { code: "NoRoute", routes: [] });
    }
    if (url.includes("open-meteo")) return json({ timezone: "America/Toronto" });
    if (url.includes("interpreter"))
      return json({ elements: [{ type: "node", id: 1, lat: LINE[500][1], lon: LINE[500][0], tags: { highway: "motorway_junction", ref: "7" } }] });
    if (url.includes("nominatim")) return json({ address: { country_code: "ca" } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const viaCalls = (f: ReturnType<typeof mockFetch>) =>
  f.mock.calls.filter(([u]) => String(u).includes("project-osrm") && decodeURIComponent(String(u)).split("/driving/")[1].split("?")[0].split(";").length === 3);

/**
 * Via candidates are tried in order 45 % left, 45 % right, 55 % right, 55 % left. Responses by call order:
 * 1 → copy of the main road (overlap → reject), 2 → diverging south detour (accept),
 * 3 → near-duplicate of #2 (reject), 4 → diverging north but too slow (reject).
 */
function scenario() {
  let n = 0;
  return () => {
    n++;
    if (n === 1) return { code: "Ok", routes: [osrmRoute(LINE, 3700, "QEW")] };
    if (n === 2) return { code: "Ok", routes: [osrmRoute(SOUTH, 4200, "QEW, Hwy 3 / Hwy 3, I-90", 2)] };
    if (n === 3) return { code: "Ok", routes: [osrmRoute(SOUTH_DUP, 4300, "Hwy 3")] };
    return { code: "Ok", routes: [osrmRoute(NORTH, 6000, "Hwy 8")] };
  };
}

let tmpRoot = "";
beforeEach(() => {
  vi.stubEnv("UNCONGEST_MODE", "full-live");
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "uncongest-alts-"));
  process.env.UNCONGEST_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.UNCONGEST_RECORDED_DIR = path.join(tmpRoot, "recorded");
  process.env.BORDER_LOOKUP = "0";
  resetBudgets();
  clearOverpassCache();
  clearRoutingCache();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const k of ["UNCONGEST_CACHE_DIR", "UNCONGEST_RECORDED_DIR", "BORDER_LOOKUP", "OSRM_SESSION_LIMIT"]) delete process.env[k];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("via points in resolveRoute", () => {
  it("adds via to the OSRM URL and the route id; skips the fixture short-circuit", async () => {
    const f = mockFetch({ via: () => ({ code: "Ok", routes: [osrmRoute(SOUTH, 4200, "Hwy 3")] }) });
    const plain = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    const viaRoute = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer", via: [{ lat: 42.9, lng: -79.5 }] });
    expect(viaRoute.id).not.toBe(plain.id);
    const url = String(viaCalls(f)[0][0]);
    expect(url).toContain("-79.50000,42.90000");
    expect(url).not.toContain("alternatives=true");
    expect(tripRouteSchema.parse(viaRoute).exitsStatus).toBe("pending");
    // fixture endpoints + via → real OSRM call, not the fixture
    const fx = await resolveRoute(place("Toronto", 43.6532, -79.3832), place("Montréal", 45.5017, -73.5673), {
      fetchImpl: f,
      exits: "defer",
      via: [{ lat: 44.2, lng: -76.5 }]
    });
    expect(fx.source).toBe("osrm");
  });
});

describe("generateAlternatives", () => {
  it("builds 6 perpendicular candidates at 45 % / 55 % / 70 % with d = clamp(0.12·km, 15, 45)", async () => {
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch(), exits: "defer" });
    const c = viaCandidates(main);
    expect(c).toHaveLength(6);
    expect(c[0].lat).toBeGreaterThan(43.1); // left of eastbound = north, ~15 km
    expect(c[1].lat).toBeLessThan(42.9);
    expect(c[0].lng).toBeLessThan(-79.5);
    expect(c[2].lng).toBeGreaterThan(-79.5);
  });

  it("accepts a diverging detour and rejects overlap, near-duplicate and too-slow candidates", async () => {
    const f = mockFetch({ via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    const alts = await generateAlternatives(main.id, { fetchImpl: f });
    expect(viaCalls(f)).toHaveLength(6);
    expect(alts).toHaveLength(1);
    const a = alts[0];
    expect(a.id).toBe(`${main.id}-via1`);
    expect(a.summary).toBe("QEW, Hwy 3, I-90");
    expect(a.durationMinutes).toBe(70);
    expect(a.via?.[0].lat).toBeLessThan(43);
    expect(a.coordinates.length).toBeLessThanOrEqual(300);
    expect(routeOverlap(a.coordinates as LngLat[], main.coordinates as LngLat[])).toBeLessThan(0.6);
    expect(routeOverlap(SOUTH_DUP, a.coordinates as LngLat[])).toBeGreaterThanOrEqual(0.6);
    // stored on the main route for Strategic's routeAlternatives tool
    expect(getStoredRoute(main.id)?.alternatives.map((x) => x.id)).toEqual([a.id]);
  });

  it("evaluates all candidates once, then keeps at most maxAlternatives (fastest first)", async () => {
    const f = mockFetch({ via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    const alts = await generateAlternatives(main.id, { fetchImpl: f, maxAlternatives: 1 });
    expect(alts).toHaveLength(1);
    expect(viaCalls(f)).toHaveLength(6);
  });

  it("prefers OSRM-native alternatives (no via calls when they suffice)", async () => {
    const f = mockFetch({ native: true, via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    const alts = await generateAlternatives(main.id, { fetchImpl: f, maxAlternatives: 1 });
    expect(viaCalls(f)).toHaveLength(0);
    expect(alts.map((a) => a.id)).toEqual([`${main.id}-alt1`]);
    expect(alts[0].via).toBeUndefined();
    // with room for more, native stays first and the north detour is rejected as a near-duplicate of it
    clearRoutingCache();
    process.env.UNCONGEST_CACHE_DIR = path.join(tmpRoot, "cache2"); // the 1-alternative result is on disk
    const f2 = mockFetch({ native: true, via: scenario() });
    const m2 = await resolveRoute(ORIGIN, DEST, { fetchImpl: f2, exits: "defer" });
    const alts2 = await generateAlternatives(m2.id, { fetchImpl: f2, maxAlternatives: 3 });
    expect(alts2[0].id).toBe(`${m2.id}-alt1`);
    expect(alts2.map((a) => a.summary)).toEqual(["Hwy 8", "QEW, Hwy 3, I-90"]);
  });

  it("serves repeat calls from memory and disk without refetching", async () => {
    const f = mockFetch({ via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f }); // inline → ready → persisted
    const first = await generateAlternatives(main.id, { fetchImpl: f });
    const n = f.mock.calls.length;
    expect(await generateAlternatives(main.id, { fetchImpl: f })).toEqual(first);
    expect(f.mock.calls.length).toBe(n);
    // concurrent calls share one run
    clearRoutingCache();
    const noNet = vi.fn(async () => {
      throw new Error("no network");
    }) as unknown as typeof fetch;
    const again = await resolveRoute(ORIGIN, DEST, { fetchImpl: noNet }); // from disk
    const [x, y] = await Promise.all([generateAlternatives(again.id, { fetchImpl: noNet }), generateAlternatives(again.id, { fetchImpl: noNet })]);
    expect(x).toEqual(first);
    expect(y).toEqual(first);
    expect(getStoredRoute(again.id)?.alternatives).toHaveLength(1);
  });

  it("de-duplicates concurrent calls", async () => {
    const f = mockFetch({ via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    await Promise.all([generateAlternatives(main.id, { fetchImpl: f }), generateAlternatives(main.id, { fetchImpl: f })]);
    expect(viaCalls(f)).toHaveLength(6);
  });

  it("returns what it has when the OSRM budget runs out (and does not cache it for 24 h)", async () => {
    process.env.OSRM_SESSION_LIMIT = "3"; // main + 2 via calls
    const f = mockFetch({ via: scenario() });
    const main = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer", sessionId: "s1" });
    const alts = await generateAlternatives(main.id, { fetchImpl: f, sessionId: "s1" });
    expect(viaCalls(f)).toHaveLength(2);
    expect(alts).toHaveLength(1);
    expect(alts[0].summary).toBe("QEW, Hwy 3, I-90");
    // incomplete → short TTL: after 11 min a new session retries
    const t0 = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(t0 + 11 * 60 * 1000);
    await generateAlternatives(main.id, { fetchImpl: f, sessionId: "s2" });
    expect(viaCalls(f).length).toBeGreaterThan(2);
  });

  it("throws for an unknown route id", async () => {
    await expect(generateAlternatives("osrm-nope")).rejects.toThrow(/Unknown route id/);
  });
});
