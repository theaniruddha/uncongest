import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"], env: { UNCONGEST_DISK_CACHE: "0" } },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } }
});
