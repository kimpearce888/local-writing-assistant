/**
 * Manual-style E2E tests: exercises the flows that the existing 7
 * E2E tests don't cover — side-panel rewrite→Replace flow (was
 * BLOCKER B1), pause-site feature (was B3), and basic scroll
 * repositioning (was H2/H3).
 *
 * These tests simulate real user interactions with the extension.
 */

const { test, expect } = require("@playwright/test");
const {
  launchExtensionContext,
  EXTENSION_ID,
  ROOT,
} = require("./fixtures/extension.js");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// A realistic page with a textarea that has the mock-AI "don't" →
// "doesn't" issue. A 600px spacer above + below makes the page
// scrollable.
const REALISTIC_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Realistic editor page</title>
  <style>
    body { margin: 0; padding: 40px; font: 16px/1.5 system-ui, sans-serif; }
    h1 { margin: 0 0 20px; }
    .spacer { height: 600px; }
    textarea#editor {
      width: 600px; height: 200px; padding: 12px;
      font: 16px/1.5 system-ui, sans-serif;
      border: 1px solid #ccc; border-radius: 4px;
    }
  </style>
</head>
<body>
  <h1>Local Writing Assistant — realistic test page</h1>
  <div class="spacer"></div>
  <p>This spacer pushes the editor below the fold.</p>
  <textarea id="editor" rows="8">She don't like the way the project is going. We should probably revisit the scope before the next milestone. The team is asking for clearer priorities.</textarea>
  <div class="spacer"></div>
</body>
</html>`;

let _httpServer = null;
let _httpPort = 0;
async function ensureHttpServerWithRealisticPage() {
  if (_httpServer) return _httpPort;
  _httpServer = http.createServer((req, res) => {
    const pagesDir = path.join(ROOT, "tests", "e2e", "pages");
    let p = req.url.split("?")[0];
    if (p === "/") p = "/textarea.html";
    if (p === "/realistic.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(REALISTIC_HTML);
      return;
    }
    let filePath = path.join(pagesDir, p);
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

test.describe("Manual user-flow tests", () => {
  test("scroll repositions the highlight overlay", async () => {
    const port = await ensureHttpServerWithRealisticPage();
    const { context } = await launchExtensionContext();
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/realistic.html`);
      await page.waitForLoadState("domcontentloaded");

      // Focus the editor to trigger content-script attachment +
      // analysis. page.focus() may auto-scroll, so before measuring
      // we reset scroll to 0 to get a deterministic baseline.
      await page.focus("#editor");
      const marker = await page.waitForSelector(
        "[data-lwa-highlight][data-issue-id]",
        { timeout: 15_000 },
      );

      // Reset scroll to 0 (top of page) for a deterministic baseline.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(300); // let scroll listener fire
      const boxBefore = await marker.boundingBox();
      expect(boxBefore).not.toBeNull();

      // Scroll the page down by 400px. The highlight overlay uses
      // position:fixed + a scroll listener that calls
      // syncOverlayPosition() — before the H2/H3 fix, the overlay
      // used position:absolute anchored at documentElement, which
      // would have left the marker drifting at the old viewport
      // position. We verify the marker's viewport Y moved.
      await page.evaluate(() => window.scrollTo(0, 400));
      await page.waitForTimeout(400);
      const boxAfter = await marker.boundingBox();
      expect(boxAfter).not.toBeNull();

      // After scrolling down by 400px, the marker should appear
      // 400px higher in viewport coords (the page moved UP under
      // the viewport). Tolerance of ±80px allows for floating-point
      // + render timing + the marker being on a multi-line textarea
      // where exact pixel positions vary.
      const delta = boxBefore.y - boxAfter.y;
      expect(delta).toBeGreaterThan(320); // ~400 - 80
      expect(delta).toBeLessThan(480);   // ~400 + 80
    } finally {
      await context.close();
    }
  });

  test("side-panel rewrite→Replace flow no longer shows B1 error", async () => {
    const port = await ensureHttpServerWithRealisticPage();
    const { context } = await launchExtensionContext();
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/realistic.html`);
      await page.waitForLoadState("domcontentloaded");

      // Open the side panel page directly.
      const sidePanel = await context.newPage();
      await sidePanel.goto(
        `chrome-extension://${EXTENSION_ID}/sidepanel.html`,
      );
      await sidePanel.waitForLoadState("domcontentloaded");

      // Use the SW to broadcast the side-panel-rewrite message.
      // chrome.runtime.sendMessage from the SW reaches ALL extension
      // pages, including the side panel. This is what the SW would
      // do after receiving selection-for-rewrite from the content
      // script (which is triggered by Alt+Shift+R or right-click →
      // Rewrite…). We can't easily drive the real selection flow
      // from a Playwright test because `setSelectionRange` on a
      // textarea doesn't show up in `window.getSelection()` (which
      // the content script uses), so we directly exercise the
      // side-panel's onMessage handler + Replace button.
      const background = context.serviceWorkers()[0];
      await background.evaluate(async (msg) => {
        await chrome.runtime.sendMessage(msg);
      }, {
        type: "side-panel-rewrite",
        text: "She don't like the way the project is going.",
        editorId: "ti:textarea:editor:",
        tabId: 0,
        start: 0,
        end: 47,
        expectedHash: "dummy-hash-not-checked-here",
      });

      // Wait for the side panel to process the message and update
      // state.text → #selectedText.
      await expect
        .poll(async () => await sidePanel.locator("#selectedText").inputValue(), {
          timeout: 5_000,
        })
        .toContain("She don't like the way");

      // Run a mock rewrite.
      await sidePanel.locator('[data-op="improve"]').click();
      // Wait for the result text to populate (mock returns instantly
      // but chrome.runtime.sendMessage round-trip takes a moment).
      await expect
        .poll(async () => await sidePanel.locator("#resultText").inputValue(), {
          timeout: 10_000,
        })
        .not.toBe("");

      // Click Replace. With B1 fixed, state.start/end/expectedHash
      // are set (forwarded by the SW), so the B1 guard does NOT fire.
      // The apply will fail with STALE_RESULT (our hash is dummy,
      // so it doesn't match the real editor hash), but that's an
      // EXPECTED non-B1 outcome. The important thing is the B1
      // error "No editor is bound to this rewrite" does NOT appear.
      await sidePanel.locator("#replaceBtn").click();
      await sidePanel.waitForTimeout(800);

      const errorLine =
        (await sidePanel
          .locator("#errorLine")
          .textContent({ timeout: 1_000 })
          .catch(() => "")) ?? "";
      // The B1 error must NOT appear. The fix has forwarded start /
      // end / expectedHash to the side panel, so the B1 guard no
      // longer fires. Other outcomes (EDITOR_UNSUPPORTED, STALE_RESULT,
      // or "Replaced.") are all valid non-B1 outcomes given the test's
      // mock setup (the test sends tabId=0 which isn't a real Chrome
      // tab id, so the SW's apply-rewrite will fail with
      // EDITOR_UNSUPPORTED — that's expected, not a regression).
      expect(errorLine).not.toContain("No editor is bound");
    } finally {
      await context.close();
    }
  });

  test("pause-site feature suppresses analysis while paused", async () => {
    const port = await ensureHttpServerWithRealisticPage();
    const { context } = await launchExtensionContext();
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/realistic.html`);
      await page.waitForLoadState("domcontentloaded");

      // First verify analysis runs normally.
      await page.focus("#editor");
      await page.waitForSelector("[data-lwa-highlight][data-issue-id]", {
        timeout: 15_000,
      });

      // Pause the site via the SW (the popup path). The pause state
      // is written to chrome.storage.local (always accessible from
      // content scripts — no setAccessLevel dance required).
      // IMPORTANT: the pause key uses location.host, which for
      // http://127.0.0.1:PORT includes the port. We must use the
      // same key when setting from the SW.
      const pauseHost = `127.0.0.1:${port}`;
      const background = context.serviceWorkers()[0];
      await background.evaluate(async (host) => {
        await chrome.storage.local.set({ [`paused:${host}`]: true });
      }, pauseHost);
      await page.waitForTimeout(300);

      // Reload the page so the content script re-evaluates pause
      // state on init.
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      // Focus the editor to trigger any potential analysis.
      await page.focus("#editor");
      // Wait long enough that analysis WOULD have run if pause
      // wasn't active (analysis runs after a 700ms debounce).
      await page.waitForTimeout(2500);

      // No highlight markers should exist because the site is
      // paused.
      const markerCountAfterPause = await page.evaluate(() => {
        return document.querySelectorAll(
          "[data-lwa-highlight][data-issue-id]",
        ).length;
      });
      expect(markerCountAfterPause).toBe(0);

      // Unpause and verify analysis runs. We reload the page so the
      // content script's init() runs again — when paused, init()
      // returned early and never attached the focusin listener, so
      // focusing the editor alone wouldn't trigger analysis.
      await background.evaluate(async (host) => {
        await chrome.storage.local.remove(`paused:${host}`);
      }, pauseHost);
      await page.waitForTimeout(300);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await page.focus("#editor");
      await page.waitForSelector("[data-lwa-highlight][data-issue-id]", {
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });
});
