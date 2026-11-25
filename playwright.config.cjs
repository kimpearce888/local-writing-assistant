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
 * Browser choice: we use `launchPersistentContext` with --load-extension
 * because extensions cannot be injected into a plain `chromium.launch()`
 * context. Playwright's bundled Chromium *can* load unpacked extensions
 * (headless=new); the fixture prefers the system Chrome via CHROME_PATH
 * when set, and falls back to the bundled browser otherwise.
 */

// CJS require (not ESM import) so the config also loads under plain Node,
// not just Playwright's esbuild-bundled loader.
const { defineConfig, devices } = require("@playwright/test");

const CHROME_PATH = process.env.CHROME_PATH || "";
const EXTENSION_PATH = process.env.EXTENSION_PATH || "extension/dist";
const NATIVE_HOST_PATH = process.env.NATIVE_HOST_PATH || "native-host/build/LocalWritingAssistantHost";

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false, // extensions share a single user-data-dir per worker
  retries: process.env.CI ? 1 : 0, // extension E2E shares one profile; one retry absorbs CI flake
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
