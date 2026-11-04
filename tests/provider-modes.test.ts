import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allUsage, getBudget, resetBudgets } from "@/lib/providers/budget";
import { getWeatherProvider, OpenMeteoWeatherProvider } from "@/lib/providers/weather";
import { resolveRoute, generateAlternatives, clearRoutingCache } from "@/lib/providers/routing";
import { RoutePlaceProvider } from "@/lib/providers/routePlaces";
import { routeModelFor } from "@/lib/providers/routing";
import { TORONTO, MONTREAL } from "@/lib/trip/presets";

beforeEach(() => {
  vi.stubEnv("UNCONGEST_MODE", "demo");
  vi.stubEnv("TOMTOM_LIVE", "1");
  vi.stubEnv("TOMTOM_API_KEY", "mock-test-key");
  vi.stubEnv("UNCONGEST_CACHE_DIR", "/tmp/uncongest-readiness-no-cache");
  resetBudgets();
  clearRoutingCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetBudgets();
  clearRoutingCache();
});

describe("submission provider isolation", () => {
  it.each(["demo", "live-muse"])("%s never calls external evidence providers even with configured keys", async (mode) => {
    vi.stubEnv("UNCONGEST_MODE", mode);
    const network = vi.fn(() => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", network);
    for (const provider of ["tomtom", "overpass", "osrm", "nominatim", "open-meteo"] as const) {
      expect(getBudget(provider).take()).toMatch(/disabled/);
    }
    const route = await resolveRoute(TORONTO, MONTREAL);
    expect(route.source).toBe("fixture");
    expect(route.exits.length).toBeGreaterThan(50);
    const places = new RoutePlaceProvider(routeModelFor(route), { tomtomVerifyTop: 5 });
    await places.getCandidates("initial", { minKm: 0, maxKm: 60, needs: ["coffee"] });
    expect(await generateAlternatives(route.id)).toEqual([]);
    const readings = await getWeatherProvider("live").getReadings([
      { id: "here", lat: 43.65, lng: -79.38, localDateTime: "2027-01-01T12:00" }
    ], "rain");
    expect(readings[0]).toMatchObject({ source: "simulated", condition: "rain", fetchedAt: "2026-11-04T12:00:00Z" });
    expect(readings[0].note).toMatch(/mock weather snapshot.*not a forecast/);
    expect(network).not.toHaveBeenCalled();
    expect(allUsage().every((u) => u.usedInWindow === 0)).toBe(true);
  });

  it("requires both Full Live and TomTom's independent opt-in", () => {
    vi.stubEnv("UNCONGEST_MODE", "full-live");
    vi.stubEnv("TOMTOM_LIVE", "0");
    resetBudgets();
    expect(getBudget("tomtom").take()).toMatch(/disabled/);
    expect(getBudget("osrm").enabled).toBe(true);
    vi.stubEnv("TOMTOM_LIVE", "1");
    resetBudgets();
    expect(getBudget("tomtom").enabled).toBe(true);
    // Inspect policy only: never make a live TomTom request in tests.
  });
});


describe("weather reuse", () => {
  it("coalesces simultaneous forecasts for the same cells", async () => {
    vi.stubEnv("UNCONGEST_MODE", "full-live");
    resetBudgets();
    let complete!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const provider = new OpenMeteoWeatherProvider(fetchMock as typeof fetch);
    const points = [{ id: "cell", lat: 41.234, lng: -81.345, localDateTime: "2026-11-04T12:00" }];
    const first = provider.getReadings(points, "rain");
    const second = provider.getReadings(points, "rain");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    complete(new Response(JSON.stringify({ hourly: { time: ["2026-11-04T12:00"], temperature_2m: [15], precipitation_probability: [0], weather_code: [0] } })));
    const results = await Promise.all([first, second]);
    expect(results.every((r) => r[0].source === "open-meteo")).toBe(true);
    expect(getBudget("open-meteo").usage().usedInWindow).toBe(1);
  });
});
