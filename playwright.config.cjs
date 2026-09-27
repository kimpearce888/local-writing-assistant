/**
 * Playwright config for E2E tests of the Local Writing Assistant extension.
 *
 * We use `launchPersistentContext` because Chrome extensions cannot be
 * loaded into the headless test runner's default Chromium — they need
 * a real Chrome user data dir + the --load-extension flag.
 *
 * The tests run against the MOCK native host (LOCAL_MOCK_AI=true), so
 * they don't need a real LM Studio running. The mock native host is
 * built fresh for each test run and registered into the persistent
 * context's user-data-dir via a generated native messaging manifest.
 *
 * Why not the regular `chromium.launch()`: Playwright's bundled
 * Chromium is patched to disallow extension loading by default. We
 * instead point Playwright at the system Chrome (or a separately
 * downloaded chromium) via CHROME_PATH env var.
 */

import { defineConfig, devices } from "@playwright/test";

const CHROME_PATH = process.env.CHROME_PATH || "";
const EXTENSION_PATH = process.env.EXTENSION_PATH || "extension/dist";
const NATIVE_HOST_PATH = process.env.NATIVE_HOST_PATH || "native-host/build/LocalWritingAssistantHost";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false, // extensions share a single user-data-dir per worker
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chrome-extension",
      use: {
        ...devices["Desktop Chrome"],
        // Override the browser to a real Chrome that supports extensions.
        channel: undefined,
        // Playwright will use the persistent context fixture in tests/e2e/fixtures
        // instead of the default browser. This config tells Playwright
        // not to spawn its own browser.
      },
    },
  ],
  // Expose env vars to tests
  metadata: {
    chromePath: CHROME_PATH,
    extensionPath: EXTENSION_PATH,
    nativeHostPath: NATIVE_HOST_PATH,
  },
});
