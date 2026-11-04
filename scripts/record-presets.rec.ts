import { test } from "vitest";
import { SCENARIO_PRESETS } from "@/lib/trip/presets";
import { recordRoute, resolveRoute, routeModelFor } from "@/lib/providers/routing";
import { prefetchWindows } from "@/lib/providers/routePlaces";
import { opportunityWindows } from "@/lib/trip/opportunityWindows";

/**
 * Records real data for the scenario presets so a hosted copy works when Overpass is slow:
 * the OSRM route (with OSM exits) and OSM place tiles for each preset's likely stop windows
 * plus the first/last 60 km. Never the whole journey for long routes.
 */
test("record presets", async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const p of SCENARIO_PRESETS) {
    const s = p.setup(today);
    if (s.dataMode === "demo") continue;
    try {
      const route = await resolveRoute(s.origin, s.destination, { sessionId: "recorder" });
      if (route.source === "osrm" || route.source === "cache") {
        if (!route.attribution.includes("OSRM ramp steps")) console.log("recorded route", await recordRoute(route));
        else console.log(`route ${route.id} degraded (no OSM junctions) — not recorded`);
      }
      const m = routeModelFor(route);
      const ws = opportunityWindows({ routeKm: m.totalKm, speedKph: s.cars[0].speedKph, departureLocal: s.departure.time, mood: s.mood, mealPreference: s.mealPreference, mealHistory: s.mealHistory });
      const windows = [{ minKm: 0, maxKm: Math.min(60, m.totalKm) }, ...ws, { minKm: Math.max(0, m.totalKm - 60), maxKm: m.totalKm }];
      for (const w of windows) {
        const r = await prefetchWindows(m, [w], { sessionId: "recorder" });
        console.log(p.id, `km ${Math.round(w.minKm)}–${Math.round(w.maxKm)}`, r.trace.join(" | "));
      }
    } catch (e) {
      console.log(p.id, "failed:", (e as Error).message);
    }
  }
});
