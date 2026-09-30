/**
 * Screenshot capture for the README.
 *
 * Uses the same E2E fixture as the test suite (launchExtensionContext)
 * so the screenshots reflect the real extension running in a real
 * Chromium, with mock-AI returning realistic canned responses.
 *
 * Captures 5 shots:
 *   1. compose-with-marker.png — the email compose page with a
 *      highlight marker under "don't" (the mock AI's signature issue).
 *   2. suggestion-popup.png — same page, but the suggestion popup is
 *      open showing Replace / Ignore / Add to dictionary buttons.
 *   3. popup-connected.png — the extension popup showing
 *      "● Connected" status + model loaded.
 *   4. side-panel-rewrite.png — the side panel showing the selected
 *      text + the UPPERCASE result after clicking "Improve writing".
 *   5. options-page.png — the options page with all settings visible.
 *
 * All shots saved to docs/screenshots/ as PNGs at 2x resolution.
 *
 * Usage: DISPLAY=:99 LOCAL_MOCK_AI=true node scripts/capture-screenshots.cjs
 */

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const {
  launchExtensionContext,
  EXTENSION_ID,
  ROOT,
} = require("../tests/e2e/fixtures/extension.cjs");

const SHOT_DIR = path.join(ROOT, "docs", "screenshots");
const COMPOSE_HTML_PATH = path.join(
  ROOT,
  "tests",
  "e2e",
  "pages",
  "compose.html",
);

// In-process HTTP server serving the compose page so the content
// script actually attaches (file:// pages would need the "Allow
// access to file URLs" extension flag).
let _server = null;
let _port = 0;
function ensureHttpServer() {
  if (_server) return _port;
  _server = http.createServer((req, res) => {
    let p = req.url.split("?")[0];
    if (p === "/") p = "/compose.html";
    let filePath = path.join(path.dirname(COMPOSE_HTML_PATH), p);
    if (!filePath.startsWith(path.dirname(COMPOSE_HTML_PATH)) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const html = fs.readFileSync(filePath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  });
  return new Promise((resolve) => {
    _server.listen(0, "127.0.0.1", () => {
      _port = _server.address().port;
      resolve(_port);
    });
  });
}

async function capture() {
  if (!fs.existsSync(SHOT_DIR)) {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
  }

  const port = await ensureHttpServer();
  const { context } = await launchExtensionContext();

  try {
    // ============================================================
    // Shot 1: compose page with highlight marker
    // ============================================================
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/compose.html`);
    await page.waitForLoadState("domcontentloaded");
    // Focus the editor to trigger analysis.
    await page.focus("#editor");
    // Wait for the mock AI to add a marker.
    const marker = await page.waitForSelector(
      "[data-lwa-highlight][data-issue-id]",
      { timeout: 15_000 },
    );
    // Wait for the marker to settle in position.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOT_DIR, "compose-with-marker.png"),
      fullPage: false,
    });
    console.log("✓ compose-with-marker.png");

    // ============================================================
    // Shot 2: suggestion popup open
    // ============================================================
    await marker.click();
    // Wait for the popup to render with Replace/Ignore buttons.
    await page.waitForSelector(
      "[data-lwa-popup] button, [data-lwa-suggestion-popup] button, .lwa-popup button",
      { timeout: 5_000 },
    ).catch(() => {
      // Fallback: wait for any visible button near the marker.
    });
    // The popup is rendered by SuggestionPopup — find it via its role.
    // Looking at suggestion-popup.ts, it doesn't have a data attribute
    // we can query, so let's wait for a popup-like element to appear
    // near the marker.
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SHOT_DIR, "suggestion-popup.png"),
      fullPage: false,
    });
    console.log("✓ suggestion-popup.png");

    // Close the popup by pressing Escape (the popup handles this).
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ============================================================
    // Shot 3: popup connected status
    // ============================================================
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 480 });
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await popup.waitForLoadState("domcontentloaded");
    // The popup sends a popup-status-query message and waits for the
    // mock AI to respond. Wait for #connStatus to show "Connected".
    await popup.waitForSelector("#connStatus", { timeout: 10_000 });
    await popup.waitForFunction(
      () => {
        const el = document.getElementById("connStatus");
        return el && el.textContent.includes("Connected");
      },
      { timeout: 15_000 },
    );
    // Small delay so the model name + suggestion count render too.
    await popup.waitForTimeout(500);
    await popup.screenshot({
      path: path.join(SHOT_DIR, "popup-connected.png"),
      fullPage: false,
    });
    console.log("✓ popup-connected.png");

    // ============================================================
    // Shot 4: side panel rewrite flow
    // ============================================================
    const sidePanel = await context.newPage();
    await sidePanel.setViewportSize({ width: 480, height: 720 });
    await sidePanel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
    await sidePanel.waitForLoadState("domcontentloaded");

    // Send a side-panel-rewrite message via the SW (broadcasts to all
    // extension pages, including this side panel page).
    const background = context.serviceWorkers()[0];
    await background.evaluate(async (msg) => {
      await chrome.runtime.sendMessage(msg);
    }, {
      type: "side-panel-rewrite",
      text: "I wanted to follow up on the Q3 roadmap we discussed last week. The team don't have a clear sense of priorities yet, and I think we should revisit the scope before the next milestone.",
      editorId: "ti:textarea:editor:",
      tabId: 0,
      start: 0,
      end: 240,
      expectedHash: "dummy-hash-not-checked-here",
    });
    // Wait for the selectedText textarea to populate.
    await sidePanel.waitForFunction(
      () => {
        const el = document.getElementById("selectedText");
        return el && el.value.length > 0;
      },
      { timeout: 5_000 },
    );

    // Click "Improve writing" to trigger a mock rewrite.
    await sidePanel.locator('[data-op="improve"]').click();
    // Wait for the result text to populate (mock returns UPPERCASE).
    await sidePanel.waitForFunction(
      () => {
        const el = document.getElementById("resultText");
        return el && el.value.length > 0;
      },
      { timeout: 10_000 },
    );
    await sidePanel.waitForTimeout(500);
    await sidePanel.screenshot({
      path: path.join(SHOT_DIR, "side-panel-rewrite.png"),
      fullPage: false,
    });
    console.log("✓ side-panel-rewrite.png");

    // ============================================================
    // Shot 5: options page
    // ============================================================
    const options = await context.newPage();
    await options.setViewportSize({ width: 900, height: 900 });
    await options.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await options.waitForLoadState("domcontentloaded");
    // Wait for the settings form to render.
    await options.waitForSelector("input, select", { timeout: 5_000 });
    await options.waitForTimeout(800);
    await options.screenshot({
      path: path.join(SHOT_DIR, "options-page.png"),
      fullPage: true,
    });
    console.log("✓ options-page.png");

    console.log("");
    console.log(`All screenshots saved to: ${SHOT_DIR}`);
  } finally {
    await context.close();
  }
}

capture().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
