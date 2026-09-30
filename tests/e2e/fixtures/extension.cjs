/**
 * Test fixture: launches Chrome with the extension loaded, the mock
 * native host registered, and LOCAL_MOCK_AI=true so tests don't need
 * a real LM Studio running.
 *
 * The fixture:
 *   1. Builds the native host (Linux for the test box) if not already built
 *   2. Creates a per-test temp user-data-dir
 *   3. Generates a native-messaging host manifest in the user-data-dir
 *      pointing at the built binary, with allowed_origins matching the
 *      extension ID baked into the manifest
 *   4. Sets the env var for the native-messaging host registration
 *   5. Launches Chrome via Playwright's persistent context with --load-extension
 *   6. Yields the context + a pinned extension background page
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { execSync } = require("node:child_process");
const { chromium } = require("@playwright/test");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXTENSION_ID = "lclfegmpnhibpkijgmlpjaoemnjpabcp";

// In-process HTTP server that serves the test HTML pages. Using HTTP
// instead of file:// sidesteps the "Allow access to file URLs"
// extension setting, which is finicky to enable programmatically.
let _httpServer = null;
let _httpPort = 0;
async function ensureHttpServer() {
  if (_httpServer) return _httpPort;
  _httpServer = http.createServer((req, res) => {
    const pagesDir = path.join(ROOT, "tests", "e2e", "pages");
    let p = req.url.split("?")[0];
    if (p === "/") p = "/textarea.html";
    const filePath = path.join(pagesDir, p);
    if (!filePath.startsWith(pagesDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const html = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((resolve) => {
    _httpServer.listen(0, "127.0.0.1", () => {
      _httpPort = _httpServer.address().port;
      resolve();
    });
  });
  return _httpPort;
}

function ensureNativeHostBuilt() {
  const bin = path.join(ROOT, "native-host", "build", "LocalWritingAssistantHost");
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  execSync("go build -o build/LocalWritingAssistantHost ./cmd/localwritingassistanthost", {
    cwd: path.join(ROOT, "native-host"),
    stdio: "inherit",
  });
  return bin;
}

function makeUserDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lwa-e2e-"));
}

function writeNativeMessagingManifest(userDataDir, hostBinaryPath) {
  const dir = path.join(userDataDir, "NativeMessagingHosts");
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, "com.localwritingassistant.host.json");
  const manifest = {
    name: "com.localwritingassistant.host",
    description: "Local Writing Assistant native messaging host",
    path: hostBinaryPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

async function launchExtensionContext() {
  const port = await ensureHttpServer();
  const extPath = path.join(ROOT, "extension", "dist");
  if (!fs.existsSync(path.join(extPath, "manifest.json"))) {
    throw new Error(
      `Extension is not built. Run \`cd extension && npm run build\` first.`,
    );
  }
  const hostBin = ensureNativeHostBuilt();
  const userDataDir = makeUserDataDir();
  writeNativeMessagingManifest(userDataDir, hostBin);

  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env.HOME || "", ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome"),
    path.join(process.env.HOME || "", ".cache/ms-playwright/chromium-1200/chrome-linux64/chrome"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  let chromePath = null;
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      chromePath = c;
      break;
    }
  }
  if (!chromePath) {
    throw new Error(
      "No Chrome binary found that supports extension loading. " +
        "Set CHROME_PATH or install Chromium via `npx playwright install chromium`.",
    );
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: chromePath,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
    ],
    env: {
      ...process.env,
      LOCAL_MOCK_AI: "true",
    },
  });

  // Wait for the service worker to register.
  let background = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (context.serviceWorkers().length > 0) {
      background = context.serviceWorkers()[0];
      break;
    }
    background = await context
      .waitForEvent("serviceworker", { timeout: 2_000 })
      .catch(() => null);
    if (background) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!background) {
    throw new Error("Could not find extension service worker");
  }

  return { context, background, userDataDir, httpPort: port };
}

module.exports = {
  launchExtensionContext,
  EXTENSION_ID,
  ROOT,
  ensureHttpServer,
};
