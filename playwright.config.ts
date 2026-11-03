import { defineConfig } from "@playwright/test";

// Browser tests against the running app. Uses the system Chrome (channel "chrome").
// Start the app first (`npm run dev`), or let Playwright start it via webServer.
const PORT = Number(process.env.E2E_PORT ?? 3124);
export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.E2E_CHANNEL ?? "chrome",
    headless: true,
    screenshot: "only-on-failure",
    viewport: { width: 1400, height: 1000 }
  },
  outputDir: "test-results",
  webServer: {
    // Deterministic + free: mock AI and its own build dir, so it can run beside your normal dev server.
    command: `AI_PROVIDER=mock NEXT_DIST_DIR=.next-e2e npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/simulate`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
