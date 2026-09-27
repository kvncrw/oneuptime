import { defineConfig, devices } from "@playwright/test";

/*
 * CI watch acceptance suite. Runs inside the Discord fixture's runner with
 * the GitHub and LLM fixtures layered on (CiWatch/Fixture/local-stack.sh).
 * Serial, one worker: the fixtures hold global scenario state.
 */
export default defineConfig({
  testDir: "./CiWatch",
  testMatch: "**/*.spec.ts",
  // Burns the first-signup Master Admin seat; see Discord/Fixture/global-setup.ts.
  globalSetup: "./Discord/Fixture/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150000,
  globalTimeout: 60 * 60 * 1000,
  expect: { timeout: 15000 },
  reporter: [["list"], ["html", { open: "never" }], ["json"]],
  outputDir:
    process.env["CI_WATCH_E2E_OUTPUT"] ||
    "../../output/playwright/ci-watch/test-results",
  use: {
    baseURL: `http://${process.env["HOST"] || "oneuptime.test:7849"}`,
    trace: "on",
    screenshot: "on",
    locale: "en-US",
    timezoneId: "UTC",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
