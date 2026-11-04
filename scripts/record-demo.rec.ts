import { test } from "vitest";
import { getScenarioPreset } from "@/lib/trip/presets";
import { recordRoute, resolveRoute, routeModelFor } from "@/lib/providers/routing";
import { prefetchWindows } from "@/lib/providers/routePlaces";

/** Records the 3-minute demo route (with border crossings + alternatives) and its key place tiles. */
test("record demo", async () => {
  const s = getScenarioPreset("demo-3min")!.setup(new Date().toISOString().slice(0, 10));
  const route = await resolveRoute(s.origin, s.destination, { sessionId: "recorder" });
  console.log("route", route.id, route.exitsStatus, route.exits.length, "exits", route.borderCrossings.length, "borders", route.alternatives.length, "alts");
  if (route.exitsStatus === "ready") console.log("recorded", await recordRoute(route));
  const m = routeModelFor(route);
  for (const w of [{ minKm: 90, maxKm: 150 }, { minKm: 150, maxKm: 210 }, { minKm: 30, maxKm: 90 }]) {
    const r = await prefetchWindows(m, [w], { sessionId: "recorder" });
    console.log(`km ${w.minKm}-${w.maxKm}`, r.trace.join(" | "));
  }
});
