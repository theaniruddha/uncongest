import { expect, test, type Page } from "@playwright/test";

async function startDemo(page: Page) {
  await page.goto("/trip");
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible();
}

test("keyless default, weather scenarios and console stay healthy", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await startDemo(page);
  const connections = page.getByTestId("connections");
  await connections.locator("summary").click();
  await expect(connections).toContainText("Demo Mode");
  await expect(connections).toContainText("external data providers disabled");
  await page.getByLabel("ambient watcher").uncheck();
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByRole("button", { name: /Hungry now/ }).click();
  await expect(page.getByTestId("trip-log")).toContainText("Agent 1 (Mock");
  await page.getByRole("button", { name: "Replan now" }).click();
  await expect(page.getByTestId("rec-card").first()).toBeVisible();
  await expect(page.getByTestId("tactical-status")).toContainText("Recorded/Mock");
  const weather = page.waitForResponse(async (response) => response.url().endsWith("/api/weather") && response.request().postDataJSON().fallback === "rain");
  await page.getByRole("button", { name: /Make it rain/ }).click();
  const snapshot = await (await weather).json();
  expect(snapshot.readings.every((reading: { source: string; condition: string; note: string }) => reading.source === "simulated" && reading.condition === "rain" && reading.note.includes("2026-11-04"))).toBe(true);
  await page.screenshot({ path: "test-results/submission-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("missing-key status and intent provider failure explain Mock fallback", async ({ page }) => {
  await page.route("**/api/connections", (route) => route.fulfill({ json: { mode: "live-muse", museEnabled: true, museKeyConfigured: false, externalProvidersEnabled: false, tomtomEnabled: false } }));
  await page.route("**/api/intent", (route) => route.fulfill({ status: 502, json: { error: "Model provider unavailable" } }));
  await startDemo(page);
  await page.getByTestId("connections").locator("summary").click();
  await expect(page.getByTestId("connections")).toContainText("Live Muse unavailable");
  await page.getByLabel("ambient watcher").uncheck();
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByRole("button", { name: /Urgent washroom/ }).click();
  await expect(page.getByTestId("trip-log")).toContainText("Mock · client fallback");
  await expect(page.getByTestId("urgency")).toContainText("urgency: high");
  await page.getByRole("button", { name: "Replan now" }).click();
  await expect(page.getByTestId("rec-card").first()).toBeVisible();
});

test("pending intent cannot update a reset trip", async ({ page }) => {
  let release!: () => void;
  let received!: () => void;
  const pending = new Promise<void>((resolve) => { received = resolve; });
  await page.route("**/api/intent", async (route) => {
    received();
    await new Promise<void>((resolve) => { release = resolve; });
    await route.fulfill({ json: { updates: [{ carId: "car_a", addNeeds: ["restroom"], restroomUrgent: true }], understood: ["urgent washroom"], correction: false, provider: "test-model", isMock: false } });
  });
  await startDemo(page);
  await page.getByLabel("ambient watcher").uncheck();
  await page.getByRole("button", { name: /Urgent washroom/ }).click();
  await pending;
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  release();
  await expect(page.getByTestId("trip-log")).toContainText("Agent 1 response discarded");
  await expect(page.getByTestId("urgency")).not.toContainText("urgency: high");
  await expect(page.getByTestId("trip-log")).not.toContainText("Agent 1 (Live");
});

test("retracting a need clears displayed recommendations", async ({ page }) => {
  await startDemo(page);
  await page.getByLabel("ambient watcher").uncheck();
  await page.getByLabel("Scrub simulation time").fill("100");
  await page.getByRole("button", { name: /Hungry now/ }).click();
  await expect(page.getByTestId("trip-log")).toContainText("Agent 1 (Mock");
  await page.getByRole("button", { name: "Replan now" }).click();
  await expect(page.getByTestId("rec-card").first()).toBeVisible();
  await page.getByLabel("Message", { exact: true }).fill("we already ate, no meal needed");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByTestId("trip-log")).toContainText("we already ate");
  await expect(page.getByTestId("rec-card")).toHaveCount(0);
});

test("route provider failure recovers using the cached demo", async ({ page }) => {
  await page.route("**/api/route", (route) => route.fulfill({ status: 503, json: { error: "Routing service unavailable", suggestion: "Try the Toronto → Montréal demo preset" } }));
  await page.goto("/trip");
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Routing service unavailable" })).toBeVisible();
  await page.unroute("**/api/route");
  await page.getByRole("button", { name: /3-minute demo/ }).click();
  await page.getByRole("button", { name: "Plan route & start simulation" }).click();
  await expect(page.locator(".leaflet-overlay-pane path").first()).toBeVisible();
  await expect(page.getByTestId("data-badge")).toContainText("FIXTURE EVIDENCE");
});
