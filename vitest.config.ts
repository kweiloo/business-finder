import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "web/src") } },
  test: {
    include: ["tests/**/*.test.ts", "web/src/**/*.test.{ts,tsx}"],
    // Browser end-to-end tests run under Playwright, not Vitest.
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    environment: "node",
    // Many tests run the CLI as a process, and a fixture scrape starts a second
    // one for the website checks; 5 s is too tight on a busy machine.
    testTimeout: 15_000,
  },
});
