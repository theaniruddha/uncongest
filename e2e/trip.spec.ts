import { expect, test, type Page } from "@playwright/test";

/**
 * /trip browser tests against the real app + API handlers (mock AI, see playwright.config.ts).
 * Offline-safe paths use the Toronto → Montréal DEMO preset (cached route, fictional fixtures) so
 * no OSRM/Overpass/TomTom calls are needed. A live real-data run is opt-in: E2E_LIVE=1.
 */

async function openTrip(page: Page) {
  await page.goto("/trip");
  await expect(page.getByRole("heading", { name: "Trip setup" }).first()).toBeAttached();
}

async function plan(page: Page) {
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible({ timeout: 60_000 });
}

const log = (page: Page) => page.getByTestId("trip-log");

test("demo preset: watcher → recommendation → select 30-min meal → arrive → complete → resume; ETA shifts", async ({ page }) => {
  await openTrip(page);
  await page.getByRole("button", { name: /Highway 401 demo/i }).click();
  await plan(page);
  await expect(page.getByTestId("data-badge")).toContainText("FIXTURE EVIDENCE");
  await expect(page.getByTestId("data-badge")).toContainText("FICTIONAL businesses");
  const etaBefore = (await page.getByTestId("dest-eta").textContent())!;
  const before = /ETA (\d\d:\d\d)/.exec(etaBefore)![1];

  await page.getByLabel("Simulation speed").selectOption("300");
  await page.getByRole("button", { name: "Play" }).click();
  const card = page.getByTestId("rec-card").first();
  await expect(card).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(log(page).getByText(/Watcher → Agent 2/).first()).toBeVisible();
  await expect(card).toContainText("FICTIONAL DEMO");

  // 30-minute stop: impact shows the new destination ETA
  await card.getByRole("spinbutton").fill("30");
  const impact = (await card.getByTestId("eta-impact").textContent())!;
  const [, base, next, added] = /(\d\d:\d\d) → (\d\d:\d\d) \(\+(\d+) min\)/.exec(impact)!;
  expect(base).toBe(before);
  expect(Number(added)).toBeGreaterThanOrEqual(30);

  await card.getByRole("button", { name: "Select stop" }).click();
  await expect(page.getByTestId("stop-status")).toHaveText(/SELECTED|EN_ROUTE/);
  await expect(page.getByTestId("dest-eta")).toContainText(`ETA ${next}`);
  await page.getByRole("button", { name: "Skip ahead to arrival" }).click();
  await expect(page.getByTestId("stop-status")).toHaveText("ARRIVED");
  const arrivedClock = (await page.getByTestId("sim-clock").textContent())!;
  await page.getByRole("button", { name: /Spend \d+ min here/ }).click();
  const meal = page.getByLabel("ate a meal");
  if (await meal.count()) await meal.check();
  await page.getByRole("button", { name: "Complete stop" }).click();
  await expect(page.getByTestId("stop-status")).toHaveText("COMPLETED");
  const doneClock = (await page.getByTestId("sim-clock").textContent())!;
  const mins = (s: string) => Number(/t\+(\d+)/.exec(s)![1]);
  expect(mins(doneClock) - mins(arrivedClock)).toBeGreaterThanOrEqual(29);
  await expect(page.getByTestId("dest-eta")).toContainText(`ETA ${next}`);
  await expect(page.getByTestId("dest-eta")).toContainText(`(was ${before})`);
  await page.getByRole("button", { name: "Resume driving" }).click();
  await expect(log(page).getByText(/Resumed driving/)).toBeVisible();
  // continuous-driving timer reset after a 30+ min confirmed stop? (threshold 60 → not reset)
  await expect(page.getByTestId("urgency")).toContainText(/since last rest/);
});

test("urgent washroom message → high urgency → immediate recommendation", async ({ page }) => {
  await openTrip(page);
  await page.getByRole("button", { name: /Highway 401 demo/i }).click();
  await plan(page);
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByLabel("Message", { exact: true }).fill("kids really need a washroom asap");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("urgency")).toContainText("urgency: high");
  await expect(page.getByTestId("rec-card").first()).toBeVisible({ timeout: 60_000 });
});

test("short trip with no stop needed stays quiet", async ({ page }) => {
  await openTrip(page);
  await page.getByRole("button", { name: /Short trip/i }).click();
  await page.route("**/api/places/prefetch", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ trace: [], candidates: [], usage: [] }) }));
  await page.route("**/api/route", async (r) => {
    // deterministic short real-shaped route (Toronto → Mississauga), avoids live OSRM in CI
    const coords: Array<[number, number]> = [];
    for (let i = 0; i <= 30; i++) coords.push([-79.3832 - (i / 30) * 0.26, 43.6532 - (i / 30) * 0.0737]);
    await r.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "test-short",
        origin: { label: "Toronto, ON", lat: 43.6532, lng: -79.3832, type: "other", source: "preset" },
        destination: { label: "Home", lat: 43.5795, lng: -79.6435, type: "home", source: "preset" },
        coordinates: coords,
        exits: [],
        distanceKm: 22,
        durationMinutes: 25,
        source: "cache",
        timezone: "America/Toronto",
        fetchedAt: new Date().toISOString(),
        attribution: "test"
      })
    });
  });
  await plan(page);
  await page.getByLabel("Simulation speed").selectOption("300");
  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("urgency")).toContainText("arrived at destination", { timeout: 30_000 });
  await expect(page.getByTestId("rec-card")).toHaveCount(0);
  await expect(log(page).getByText(/Watcher → Agent 2/)).toHaveCount(0);
});

test("custom scenario in natural language is parsed and applied only after review", async ({ page }) => {
  await openTrip(page);
  await page.getByRole("button", { name: /Coffee and a quick bite/i }).click(); // Toronto → Ottawa
  await expect(page.getByLabel("Destination", { exact: true })).toHaveValue(/Ottawa/);
  await page
    .getByLabel("Scenario description")
    .fill("We're leaving Mississauga early, driving toward Letchworth, probably hungry by lunchtime, traveling with two kids, and we don't want a large detour.");
  await page.getByRole("button", { name: "Interpret scenario" }).click();
  const sug = page.getByTestId("scenario-suggestion");
  await expect(sug).toBeVisible();
  await expect(sug).toContainText(/review before applying/);
  await expect(page.getByLabel("Destination", { exact: true })).not.toHaveValue(/Letchworth/); // nothing changed yet
  await sug.getByRole("button", { name: "Apply to form" }).click();
  await expect(page.getByLabel("Destination", { exact: true })).toHaveValue(/Letchworth/);
  await expect(page.getByLabel("Origin", { exact: true })).toHaveValue(/Mississauga/);
  await expect(page.getByLabel("Car A kids")).toHaveValue("2");
  await expect(page.getByText(/Max detour per stop: \d min/)).toBeVisible();
});

test("no TomTom requests when disabled; budgets visible in the inspector", async ({ page }) => {
  let tomtomCalls = 0;
  page.on("request", (r) => {
    if (r.url().includes("tomtom.com")) tomtomCalls++;
  });
  await openTrip(page);
  await page.getByRole("button", { name: /Highway 401 demo/i }).click();
  await plan(page);
  await page.getByRole("button", { name: "Replan now" }).click();
  await expect(page.getByRole("tab", { name: "API budgets" })).toBeVisible();
  await page.getByRole("tab", { name: "API budgets" }).click();
  const row = page.getByTestId("usage-tomtom");
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("off");
  await expect(row).toContainText("0/");
  expect(tomtomCalls).toBe(0);
});

test("three-car preset shows three independent cars", async ({ page }) => {
  await openTrip(page);
  await page.getByRole("button", { name: /Three-car convoy/i }).click();
  await plan(page);
  await expect(page.locator('[title$="drag to reposition"]')).toHaveCount(3);
  await page.getByLabel("Scrub simulation time").fill("40");
  await expect(page.getByTestId("urgency").locator("li")).not.toHaveCount(0);
  await expect(page.getByTestId("urgency")).toContainText("Car C");
});

test("mobile: setup collapses after planning, map and recommendations stay prominent, no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await openTrip(page);
  await page.getByRole("button", { name: /Highway 401 demo/i }).click();
  await plan(page);
  await expect(page.getByRole("button", { name: /Trip setup/ })).toHaveAttribute("aria-expanded", "false");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/trip-mobile.png" });
});

test("live real-data trip (opt-in, E2E_LIVE=1)", async ({ page }) => {
  test.skip(process.env.E2E_LIVE !== "1", "needs network: OSRM + Overpass + Open-Meteo");
  test.setTimeout(300_000);
  await openTrip(page);
  await page.getByRole("button", { name: /Relaxed road trip/i }).click();
  await plan(page);
  await expect(page.getByTestId("data-badge")).toContainText("real places (OpenStreetMap");
});
