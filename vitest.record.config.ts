import { defineConfig } from "vitest/config";
import path from "path";
// One-off recorder for preset routes + OSM place tiles (real data, committed under data/recorded/).
//   npx vitest run --config vitest.record.config.ts
export default defineConfig({
  test: { environment: "node", include: ["scripts/**/*.rec.ts"], testTimeout: 1_800_000, env: { UNCONGEST_RECORD: "1", OVERPASS_WINDOW_LIMIT: "200", OVERPASS_SESSION_LIMIT: "200" } },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } }
});
