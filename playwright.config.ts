import { defineConfig } from "@playwright/test";

// One browser owner and an isolated, keyless server: never inherit a developer's live providers.
const PORT = Number(process.env.E2E_PORT ?? 3124);
export default defineConfig({
  testDir: "e2e",
  workers: 1,
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
    command: `npx next dev -p ${PORT}`,
    env: {
      UNCONGEST_MODE: "demo",
      AI_PROVIDER: "mock",
      MODEL_API_KEY: "",
      MUSE_API_KEY: "",
      META_API_KEY: "",
      META_MODEL_API_KEY: "",
      MISTRAL_API_KEY: "",
      TOMTOM_API_KEY: "",
      TOMTOM_LIVE: "0",
      OSRM_LIVE: "0",
      OVERPASS_LIVE: "0",
      NOMINATIM_LIVE: "0",
      OPEN_METEO_LIVE: "0",
      OPEN_METEO_WINDOW_LIMIT: "0",
      NEXT_DIST_DIR: ".next-e2e"
    },
    url: `http://localhost:${PORT}/simulate`,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
