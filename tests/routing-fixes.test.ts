import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBudgets } from "@/lib/providers/budget";
import { clearGeocodeCache } from "@/lib/providers/geocode";
import { clearOverpassCache, overpassQuery } from "@/lib/providers/overpass";
import { clearRouteModelCache, routeModelForRef, type RouteRef } from "@/lib/providers/routeRef";
import { clearRoutingCache, getStoredRoute, resolveExits, resolveRoute, routeCacheDir } from "@/lib/providers/routing";
import type { PlaceRef } from "@/lib/trip/types";

type LngLat = [number, number];
const place = (label: string, lat: number, lng: number): PlaceRef => ({ label, lat, lng, type: "other", source: "search" });

// ~80 km eastbound synthetic road.
const LINE: LngLat[] = Array.from({ length: 2000 }, (_, i) => [-80 + i * 0.0005, 43 + 0.02 * Math.sin(i / 150)]);
const at = (i: number) => ({ lng: LINE[i][0], lat: LINE[i][1] });
const ORIGIN = place("Start", LINE[0][1], LINE[0][0]);
const DEST = place("End", LINE[LINE.length - 1][1], LINE[LINE.length - 1][0]);
const REF: RouteRef = {
  id: "client-id",
  origin: { label: ORIGIN.label, lat: ORIGIN.lat, lng: ORIGIN.lng, type: "other" },
  destination: { label: DEST.label, lat: DEST.lat, lng: DEST.lng, type: "other" }
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const osrmOk = () => ({
  code: "Ok",
  routes: [{ distance: 80000, duration: 3600, geometry: { type: "LineString", coordinates: LINE }, legs: [{ steps: [] }] }]
});
const overpassOk = () => ({
  elements: [
    { type: "node", id: 1, lat: at(300).lat, lon: at(300).lng, tags: { highway: "motorway_junction", ref: "10A" } },
    { type: "node", id: 3, lat: at(1200).lat, lon: at(1200).lng, tags: { highway: "motorway_junction", ref: "25" } }
  ]
});

/** Rejects when aborted, otherwise never settles. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));

function mockFetch(h: { overpass?: (init?: RequestInit) => Response | Promise<Response>; nominatim?: () => Response } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("router.project-osrm.org")) return json(osrmOk());
    if (url.includes("interpreter")) return h.overpass ? h.overpass(init) : json(overpassOk());
    if (url.includes("open-meteo")) return json({ timezone: "America/New_York" });
    if (url.includes("nominatim")) return h.nominatim ? h.nominatim() : json({ address: { country_code: "ca" } });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const callsTo = (f: ReturnType<typeof vi.fn>, host: string) => f.mock.calls.filter(([u]) => String(u).includes(host)).length;

let tmpRoot = "";
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "uncongest-routing-fixes-"));
  process.env.UNCONGEST_CACHE_DIR = path.join(tmpRoot, "cache");
  process.env.UNCONGEST_RECORDED_DIR = path.join(tmpRoot, "recorded");
  resetBudgets();
  clearOverpassCache();
  clearRoutingCache();
  clearRouteModelCache();
  clearGeocodeCache();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.UNCONGEST_CACHE_DIR;
  delete process.env.UNCONGEST_RECORDED_DIR;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("routeModelForRef", () => {
  it("does not keep the exit-less pending model once exits arrive", async () => {
    const f = mockFetch();
    const pending = await resolveRoute(ORIGIN, DEST, { fetchImpl: f, exits: "defer" });
    expect(pending.exitsStatus).toBe("pending");
    const ref = { ...REF, id: pending.id };
    const before = await routeModelForRef(ref);
    expect(before.exits()).toHaveLength(0);
    await resolveExits(pending.id, { fetchImpl: f });
    const after = await routeModelForRef(ref);
    expect(after.exits().map((e) => e.ref)).toEqual(["10A", "25"]);
    // ready model is memoised (same instance while the exit state is unchanged)
    expect(await routeModelForRef(ref)).toBe(after);
  });

  it("a store miss returns geometry without waiting for a hanging Overpass, and caches nothing pending", async () => {
    const f = mockFetch({ overpass: (init) => hang(init) });
    vi.stubGlobal("fetch", f);
    const t0 = Date.now();
    const model = await routeModelForRef(REF);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(model.totalKm).toBeGreaterThan(70);
    expect(model.exits()).toHaveLength(0);
    // a later call re-checks the store instead of returning a memoised pending model
    const id = getStoredRoute(model.id)?.id ?? model.id;
    expect(getStoredRoute(id)?.exitsStatus).toBe("pending");
    expect(await routeModelForRef(REF)).not.toBe(model);
    clearOverpassCache();
  });

  it("exitsWaitMs uses the exits when they arrive within the wait", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const model = await routeModelForRef(REF, undefined, { exitsWaitMs: 2000 });
    expect(model.exits().map((e) => e.ref)).toEqual(["10A", "25"]);
  });
});

describe("overpassQuery in-flight dedup", () => {
  it("two identical queries in the same tick → one live request", async () => {
    const f = vi.fn(async () => json({ elements: [] })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const [a, b] = await Promise.all([
      overpassQuery("q", { cacheKey: "dedup-k", fetchImpl: f }),
      overpassQuery("q", { cacheKey: "dedup-k", fetchImpl: f })
    ]);
    expect(f).toHaveBeenCalledTimes(1);
    expect(a.provenance).toBe("live");
    expect(b).toBe(a);
  });
});

describe("route disk persistence", () => {
  // Runs before the mocked-clock test below: the process-wide Nominatim throttle remembers the
  // (mocked, future) time of its last request.
  it("a successful border lookup (same country) is persisted", async () => {
    vi.stubEnv("BORDER_LOOKUP", "1");
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch() });
    expect(existsSync(path.join(routeCacheDir(), `${r.id}.json`))).toBe(true);
  }, 15_000);

  it("a failed border lookup is not persisted to disk (and is retried, not served for 24 h)", async () => {
    vi.stubEnv("BORDER_LOOKUP", "1");
    const t0 = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(t0);
    const f = mockFetch({ nominatim: () => json({}, 429) });
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(r.exitsStatus).toBe("ready");
    expect(r.borderCrossings).toEqual([]);
    expect(existsSync(path.join(routeCacheDir(), `${r.id}.json`))).toBe(false);
    // memory entry uses the short TTL: after 11 min the exits/borders are recomputed (no new OSRM)
    clock.mockReturnValue(t0 + 11 * 60 * 1000);
    const g = mockFetch();
    await resolveRoute(ORIGIN, DEST, { fetchImpl: g });
    expect(callsTo(g, "nominatim")).toBeGreaterThan(0);
    expect(callsTo(g, "router.project-osrm.org")).toBe(0);
    expect(existsSync(path.join(routeCacheDir(), `${r.id}.json`))).toBe(true);
  }, 15_000);

  it("a runtime disk file older than the TTL is not served", async () => {
    const r = await resolveRoute(ORIGIN, DEST, { fetchImpl: mockFetch() });
    const file = path.join(routeCacheDir(), `${r.id}.json`);
    expect(existsSync(file)).toBe(true);
    const stale = { ...getStoredRoute(r.id)!, source: "osrm", fetchedAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() };
    mkdirSync(routeCacheDir(), { recursive: true });
    writeFileSync(file, JSON.stringify(stale));
    clearRoutingCache();
    const f = mockFetch();
    const again = await resolveRoute(ORIGIN, DEST, { fetchImpl: f });
    expect(again.source).toBe("osrm");
    expect(callsTo(f, "router.project-osrm.org")).toBe(1);
  });
});

describe("routeCache bound", () => {
  it("evicts the oldest routes beyond 50 entries", async () => {
    const f = mockFetch();
    const first = await resolveRoute(ORIGIN, place("D0", DEST.lat, DEST.lng), { fetchImpl: f, exits: "defer" });
    for (let i = 1; i <= 50; i++) {
      resetBudgets();
      await resolveRoute(ORIGIN, place(`D${i}`, DEST.lat + i * 0.01, DEST.lng), { fetchImpl: f, exits: "defer" });
    }
    const osrmBefore = callsTo(f, "router.project-osrm.org");
    resetBudgets();
    const again = await resolveRoute(ORIGIN, place("D0", DEST.lat, DEST.lng), { fetchImpl: f, exits: "defer" });
    expect(again.id).toBe(first.id);
    expect(callsTo(f, "router.project-osrm.org")).toBe(osrmBefore + 1); // evicted → fetched again
  });
});
