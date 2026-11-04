import { defineConfig } from "vitest/config";
import path from "path";

// Explicitly opted-in real Muse smoke tests; the regular unit suite excludes this file.
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/verify-muse.live.ts"],
    testTimeout: 60_000
  },
  resolve: { alias: { "@": path.resolve(__dirname, "..") } }
});
