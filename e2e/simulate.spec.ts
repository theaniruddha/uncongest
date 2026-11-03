import { expect, test, type Page } from "@playwright/test";

/**
 * Browser tests against the real app + real API handlers (mock AI provider, see playwright.config.ts).
 * Scenario defaults: Car A departs Toronto 09:30 at km 20, 100 km/h, kids aboard, vegetarian, meal history unknown.
 */

async function open(page: Page, path = "/simulate") {
  await page.goto(path);
  await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible();
}

async function scrubTo(page: Page, minute: number) {
  await page.getByLabel("Scrub simulation time").fill(String(minute));
}

const log = (page: Page) => page.locator("aside").filter({ has: page.getByRole("heading", { name: "Event log" }) });

test("real map renders the route, exits and a car that can be placed and dragged", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/real road geometry and real eastbound exits/)).toBeVisible();
  const carA = page.locator('[title="Car A — drag to reposition"]');
  await expect(carA).toBeVisible();

  // click-to-place (snaps to nearest point on the highway)
  await page.getByRole("button", { name: "Place on map" }).first().click();
  await expect(page.getByText(/Click on the route to place Car A/)).toBeVisible();
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await expect(log(page).getByText(/Car A placed at km \d+/)).toBeVisible();
  const firstKm = await page.getByText(/^km \d+ \/ 5\d\d/).first().textContent();

  // drag the marker somewhere else
  const m = (await carA.boundingBox())!;
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  await page.mouse.down();
  await page.mouse.move(m.x + 160, m.y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(log(page).getByText(/Car A placed at km \d+/)).toHaveCount(2);
  const secondKm = await page.getByText(/^km \d+ \/ 5\d\d/).first().textContent();
  expect(secondKm).not.toEqual(firstKm);
});

test("milestone: one car → ambient watcher → proactive lunch recommendation with notice and weather", async ({ page }) => {
  await open(page);
  await page.getByLabel("Weather source").selectOption("simulated");
  // 11:46, lunch passing, meal history unknown → low-urgency reminder; next suitable exit ~25 min ahead
  await scrubTo(page, 136);
  await expect(log(page).getByText(/Watcher → call Agent 2: .*suitable exit \d+ min ahead/)).toBeVisible();
  const card = page.locator("h3", { hasText: "Harvest Table" });
  await expect(card).toBeVisible();
  await expect(page.getByText(/lead reaches exit in ~\d+ min/).first()).toBeVisible();
  await expect(page.getByText(/Weather at arrival/).first()).toBeVisible();
  await expect(page.getByText(/group: low/)).toBeVisible();

  // no duplicate notification while the situation hasn't changed
  await scrubTo(page, 138);
  await scrubTo(page, 140);
  await expect(log(page).getByText(/Agent 2 \(mock\) → PROPOSE_STOP/)).toHaveCount(1);

  // inspector shows the bounded exploration trace
  await expect(page.locator("li", { hasText: /urgency low: horizon farther ahead/ })).toBeVisible();

  // skip → excluded and re-planned; approve → watcher quiet
  await page.getByRole("button", { name: "Skip this stop" }).first().click();
  await expect(page.getByText(/Skipped: harvest_table_demo/)).toBeVisible();
  await expect(log(page).getByText(/Agent 2 \(mock\) → PROPOSE_STOP/)).toHaveCount(2); // re-planned once
  await expect(page.locator("h3", { hasText: "Harvest Table" })).toHaveCount(0);
  await expect(page.locator("h3", { hasText: "Big-Box Mart" })).toBeVisible();
  await page.getByRole("button", { name: "Lead approve" }).first().click();
  await expect(page.getByRole("button", { name: "Approved ✓" })).toBeVisible();
  await expect(page.getByText(/stop confirmed; quiet until reached/)).toBeVisible();
});

test("Agent 1: urgent restroom message → high urgency → nearest suitable stop immediately", async ({ page }) => {
  await open(page);
  await page.getByLabel("Weather source").selectOption("simulated");
  const watcherToggle = page.getByText("ambient watcher", { exact: true });
  await watcherToggle.click(); // off while scrubbing, so only the message drives the decision
  await scrubTo(page, 112); // 11:22, km ~187
  await watcherToggle.click(); // back on
  await page.getByLabel("Message", { exact: true }).fill("kids really need a washroom asap");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(log(page).getByText(/Agent 1 \(regex-parser\) car_a 💬 passenger: .* regex parser: needs\+\[restroom\]/)).toBeVisible();
  await expect(page.getByText(/group: high/)).toBeVisible();
  await expect(log(page).getByText(/high urgency .* decide now/)).toBeVisible();
  await expect(page.locator("h3", { hasText: "Vegetarian Cafe" })).toBeVisible();
  await expect(page.getByText(/#1 · /).first()).toBeVisible();

  // correction persists in per-car state: halal added without dropping vegetarian
  await page.getByLabel("Message", { exact: true }).fill("halal food for us");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/diet: vegetarian, halal/)).toBeVisible();
});

test("placing the lead car keeps position, clock and departure consistent", async ({ page }) => {
  await open(page);
  // drop Car A far down the route (east end of the map)
  await page.getByRole("button", { name: "Place on map" }).first().click();
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.3);
  const entry = log(page).getByText(/Car A placed at km [\d.]+.*→ clock (\d\d:\d\d) \(t\+(\d+)\), consistent with departing 09:30 at 100 km\/h/);
  await expect(entry).toBeVisible();
  const text = (await entry.textContent())!;
  const km = Number(/km ([\d.]+)/.exec(text)![1]);
  const t = Number(/t\+(\d+)/.exec(text)![1]);
  expect(Math.abs(t - (km / 100) * 60)).toBeLessThanOrEqual(1); // 100 km/h from 09:30
  // the time slider reflects the same fraction of the trip as the car's route progress
  const slider = page.getByLabel("Scrub simulation time");
  const [value, max] = [Number(await slider.inputValue()), Number(await slider.getAttribute("max"))];
  expect(Math.abs(value / max - km / 547)).toBeLessThan(0.02);
  await expect(page.getByText(/arrive Montréal/)).toBeVisible();

  // a following car can't be placed beyond what it could have driven since 09:30
  await page.getByLabel("Departure time").fill("09:30");
  await scrubTo(page, 30);
  await page.getByRole("button", { name: "+ Add car" }).click();
  await page.getByRole("button", { name: "Place on map" }).nth(1).click();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.3);
  await expect(log(page).getByText(/Car B can't be at km \d+ by 10:00 .* placed at the farthest reachable point, km 49/)).toBeVisible();
});

test("genuine STAY_SILENT and a real error state are shown differently", async ({ page }) => {
  await open(page);
  await page.locator('input[type="time"]').fill("14:30");
  await scrubTo(page, 20);
  await page.getByRole("button", { name: "Ask now" }).click();
  await expect(page.getByText("No stop needed right now — staying quiet.")).toBeVisible();

  await page.route("**/api/recommend-stops", (route) =>
    route.fulfill({ status: 422, contentType: "application/json", body: JSON.stringify({ error: "schema validation failed", issues: [{ path: ["cars", 0, "role"], message: "Required" }] }) })
  );
  await page.getByRole("button", { name: "Ask now" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "Couldn’t get a decision" });
  await expect(alert).toContainText("this is an error, not “no stop needed”");
  await expect(alert).toContainText("cars.0.role");
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});

test("three independent cars, stale GPS, road-ahead weather, reset", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "+ Add car" }).click();
  await page.getByRole("button", { name: "+ Add car" }).click();
  await expect(page.locator('[title$="drag to reposition"]')).toHaveCount(3);
  await expect(page.getByRole("button", { name: "+ Add car" })).toBeDisabled();
  await page.getByText("freeze GPS").nth(1).click();
  await scrubTo(page, 30);
  await expect(page.getByText(/GPS stale \d+ min/)).toBeVisible();
  await expect(page.getByRole("img", { name: /Linear view of the road ahead/ })).toBeVisible();
  await expect(page.locator("svg text", { hasText: /@\d\d:\d\d/ }).first()).toBeVisible();

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.locator('[title$="drag to reposition"]')).toHaveCount(1);
  await expect(page.getByText("Nothing yet.")).toBeVisible();
});

test("mobile width: no horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 860 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "test-results/mobile.png", fullPage: false });
});
