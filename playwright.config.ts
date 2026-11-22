import { defineConfig, devices } from "@playwright/test";

// The E2E servers run on E2E_PORT to E2E_PORT + 4 (see scripts/e2e-serve.ts),
// next to `dev:serve` on 18080 and outside the port ranges Windows reserves
// (see web/devPort.ts).
export const E2E_PORT = 18_799;
const PORT = E2E_PORT;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run build:web && bun scripts/e2e-serve.ts ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
