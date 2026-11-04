import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Agent 2 Strategic/Tactical + progressive startup, in the real browser against the real app.
 * External data is replaced with deterministic routes where noted so CI never depends on OSRM/Overpass.
 */

const SHORT_ROUTE = (id: string, pending = false) => {
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= 60; i++) coords.push([-79.6435 + (i / 60) * 0.8, 43.5795 - (i / 60) * 0.35]);
  return {
    id,
    origin: { label: "Home (simulated)", lat: 43.5795, lng: -79.6435, type: "home", source: "preset" },
    destination: { label: "Somewhere", lat: 43.2295, lng: -78.8435, type: "other", source: "preset" },
    coordinates: coords,
    exits: pending ? [] : [{ id: "e1", ref: "57", name: null, exitTo: null, lat: 43.4, lng: -79.2, km: 40 }],
    exitsStatus: pending ? "pending" : "ready",
    borderCrossings: [],
    alternatives: [],
    distanceKm: 75,
    durationMinutes: 50,
    source: "cache",
    timezone: "America/Toronto",
    fetchedAt: new Date().toISOString(),
    attribution: "test route"
  };
};

async function openAndPick(page: Page, preset: RegExp) {
  await page.goto("/trip");
  await page.getByRole("button", { name: preset }).click();
}

test("progressive startup: map + baseline ETA render before exits/places/strategic finish", async ({ page }) => {
  let exitsRequested = 0;
  await page.route("**/api/route", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHORT_ROUTE("t-progressive", true)) }));
  await page.route("**/api/route/exits", async (r: Route) => {
    exitsRequested++;
    await new Promise((res) => setTimeout(res, 12_000)); // slow Overpass
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHORT_ROUTE("t-progressive")) });
  });
  await page.route("**/api/places/prefetch", async (r) => {
    await new Promise((res) => setTimeout(res, 10_000));
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trace: [], candidates: [], usage: [] }) });
  });
  await page.route("**/api/strategic", () => new Promise(() => undefined)); // never answers
  await openAndPick(page, /Relaxed road trip/i);
  const t0 = Date.now();
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("dest-eta")).toContainText("ETA");
  const shownMs = Date.now() - t0;
  expect(shownMs).toBeLessThan(5_000);
  await expect(page.getByTestId("exits-loading")).toBeVisible();
  // playback is usable while enrichment is still pending
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(page.getByTestId("strategic-status")).toContainText(/running/);
  expect(exitsRequested).toBe(1);
  await expect(page.getByTestId("exits-loading")).toBeHidden({ timeout: 20_000 });
  console.log(`[perf] map + ETA visible ${shownMs} ms after click (exits took 12 s)`);
});

test("no excessive API calls during accelerated playback", async ({ page }) => {
  const counts: Record<string, number> = {};
  page.on("request", (r) => {
    const m = /\/api\/([a-z-/]+)/.exec(r.url());
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  });
  await page.route("**/api/route", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHORT_ROUTE("t-calls")) }));
  await page.route("**/api/places/prefetch", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trace: [], candidates: [], usage: [] }) }));
  await page.route("**/api/strategic", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "disabled in test" }) }));
  await openAndPick(page, /Short trip/i);
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible();
  await page.getByLabel("Simulation speed").selectOption("300");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("urgency")).toContainText("arrived at destination", { timeout: 30_000 });
  console.log("[calls during playback]", JSON.stringify(counts));
  expect(counts["recommend-stops"] ?? 0).toBe(0);
  expect(counts["strategic"] ?? 0).toBeLessThanOrEqual(2);
  expect(counts["weather"] ?? 0).toBeLessThanOrEqual(8);
  expect(counts["places/prefetch"] ?? 0).toBeLessThanOrEqual(2);
});

test("Strategic: a plan for the current versions is shown; an old-version plan is rejected as stale", async ({ page }) => {
  let mode: "current" | "stale" = "stale";
  await page.route("**/api/route", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHORT_ROUTE("t-strat")) }));
  await page.route("**/api/places/prefetch", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trace: [], candidates: [], usage: [] }) }));
  await page.route("**/api/strategic", async (r) => {
    const body = r.request().postDataJSON();
    const plan = {
      routeVersion: body.routeVersion,
      contextVersion: mode === "current" ? body.contextVersion : "an-older-context",
      createdAtElapsed: 0,
      summary: "Lunch window falls before the long rural stretch.",
      opportunities: [{ id: "o1", kind: "meal", title: "Lunch before the gap", fromKm: 30, toKm: 50, candidateIds: [], reason: "Few food options after km 50.", evidenceRefs: ["e1"], priority: "high", confidence: 0.7 }],
      routeDecisions: [],
      evidence: [{ id: "e1", tool: "placesInWindows", summary: "2 meal places km 30–50, 0 after", provenance: "cached" }],
      replanTriggers: ["meal completed", "route changes"]
    };
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan, meta: { status: "completed", provider: "muse (test)", ms: 900, toolTrace: [{ tool: "placesInWindows", input: "", output: "2 places", provenance: "cached", ms: 12 }] } }) });
  });
  await openAndPick(page, /Relaxed road trip/i);
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.getByTestId("strategic-status")).toContainText("stale", { timeout: 15_000 });
  await expect(page.getByTestId("trip-log").getByText(/Strategic result discarded/)).toBeVisible();
  await expect(page.getByTestId("strategic-opportunity")).toHaveCount(0);

  mode = "current";
  await page.getByRole("button", { name: "😋 Hungry now" }).click(); // context change → re-plan
  await expect(page.getByTestId("strategic-status")).toContainText("completed", { timeout: 20_000 });
  await expect(page.getByTestId("strategic-opportunity").first()).toContainText("Lunch before the gap");
  await page.getByRole("tab", { name: "Strategic" }).click();
  await expect(page.getByTestId("inspector")).toContainText("placesInWindows");
});

test("Tactical: a late result for an old context is discarded, never shown as current", async ({ page }) => {
  await page.route("**/api/recommend-stops", async (r) => {
    const res = await r.fetch();
    const json = await res.json();
    json.decidedFor = { ...(json.decidedFor ?? {}), contextVersion: "an-older-context" };
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  await openAndPick(page, /Highway 401 demo/i);
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByRole("button", { name: "Replan now" }).click();
  await expect(page.getByTestId("tactical-status")).toContainText("discarded as stale", { timeout: 30_000 });
  await expect(page.getByTestId("rec-card")).toHaveCount(0);
});

test("Tactical status is shown for real decisions (deterministic fallback under mock AI)", async ({ page }) => {
  await openAndPick(page, /Highway 401 demo/i);
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible({ timeout: 60_000 });
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByRole("button", { name: "🚻 Urgent washroom" }).click();
  await expect(page.getByTestId("rec-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("tactical-status")).toContainText(/deterministic ranking|Muse decision/);
  await page.getByRole("tab", { name: "Performance" }).click();
  await expect(page.getByTestId("perf")).toContainText("Tactical (5 s)");
  await expect(page.getByTestId("perf")).toContainText("Map + route + baseline ETA");
});

test("route alternatives: shown, compared on lunch options, suggested on evidence, and chosen only by the user", async ({ page }) => {
  const routeBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/route", async (r) => {
    const body = r.request().postDataJSON();
    routeBodies.push(body);
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHORT_ROUTE(body.via ? "t-alt-via" : "t-alt-main")) });
  });
  const altCoords: Array<[number, number]> = [];
  for (let i = 0; i <= 40; i++) altCoords.push([-79.6435 + (i / 40) * 0.8, 43.5795 - (i / 40) * 0.35 + Math.sin((i / 40) * Math.PI) * 0.15]);
  await page.route("**/api/route/alternatives", (r) =>
    r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "t-alt-main",
        alternatives: [{ id: "t-alt-main-via1", distanceKm: 82, durationMinutes: 62, summary: "QEW, I-90", coordinates: altCoords, via: [{ lat: 43.45, lng: -79.2 }] }]
      })
    })
  );
  const place = (id: string, km: number) => ({ id, name: id, type: "restaurant", categories: ["meal"], region: "", exitId: "e1", distanceAlongRouteKm: km, lat: 43.4, lng: -79.2, isMock: false, source: "osm", vegetarianVerified: null, restroomsVerified: null, parkingVerified: null, qualityScoreMock: 0.6, open24h: false, accessMinutes: 4 });
  await page.route("**/api/places/prefetch", async (r) => {
    const body = r.request().postDataJSON();
    const onAlt = String(body.route.id).includes("via1");
    const cands = onAlt ? [place("a1", 40), place("a2", 45), place("a3", 50), place("a4", 55)] : [];
    const trace = body.windows.map((w: { minKm: number; maxKm: number }) => `prefetch km ${Math.floor(w.minKm)}–${Math.ceil(w.maxKm)}: ${cands.length} place(s), cached`);
    await r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trace, candidates: cands, usage: [] }) });
  });
  await page.route("**/api/strategic", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "off in test" }) }));
  await page.goto("/trip");
  await page.getByRole("button", { name: /3-minute demo/ }).click();
  await page.getByLabel("Departure time").fill("11:40"); // the short test route then falls inside the lunch window
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.getByTestId("route-options")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("route-alt")).toHaveCount(1);
  await expect(page.getByTestId("route-alt")).toContainText("QEW, I-90");
  await expect(page.getByTestId("route-alt")).toContainText("+12 min");
  // current route has 0 food places in the lunch window → alternative auto-checked → evidence-based suggestion
  await expect(page.getByTestId("route-alt")).toContainText("4 food place(s)", { timeout: 15_000 });
  await expect(page.getByTestId("route-suggestion")).toContainText(/thin on the current route.*QEW, I-90 has 4/);
  expect(routeBodies).toHaveLength(1); // nothing rerouted automatically
  await page.getByRole("button", { name: "Use this route" }).click();
  await expect.poll(() => routeBodies.length).toBe(2);
  expect(routeBodies[1].via).toEqual([{ lat: 43.45, lng: -79.2 }]);
  await expect(page.getByTestId("trip-log").getByText(/Switched to alternative route: QEW, I-90/)).toBeVisible();
});
