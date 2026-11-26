/**
 * E2E: the two user-reported flows that were broken.
 *
 * 1. "It does not show grammar issues while writing" — real typing
 *    (many input events in quick succession) must still end in an
 *    analysis + highlight marker. This is the E2E-level regression
 *    test for the stale-timer debounce bug: the old code cleared the
 *    pending timer but kept the truthy timer id, so every keystroke
 *    after the first cancelled the pending analysis WITHOUT ever
 *    scheduling a new one, and inline highlights never appeared while
 *    typing.
 *
 * 2. "It should open the sidebar so I can write there" — the side
 *    panel's working area is editable: write text directly into it,
 *    run an action, edit the result, and Replace correctly reports
 *    that panel-written text has no page editor bound (Copy is the
 *    apply path there).
 */

const { test, expect } = require("@playwright/test");
const {
  launchExtensionContext,
  EXTENSION_ID,
  ensureHttpServer,
} = require("./fixtures/extension.cjs");

test.describe("User-reported flows", () => {
  test("typing in a textarea shows inline grammar issues while writing", async () => {
    const { context } = await launchExtensionContext();
    try {
      const port = await ensureHttpServer();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/textarea.html`, {
        waitUntil: "domcontentloaded",
      });

      // Clear the pre-filled editor, then TYPE the trigger sentence the
      // way a user does — per-character key events, all inside the
      // debounce window. The mock AI flags "don't" → "doesn't".
      await page.fill("#editor", "");
      await page.focus("#editor");
      await page.keyboard.type("She don't like it.", { delay: 25 });

      // With the debounce fixed, the marker appears after the user
      // stops typing. With the old bug this times out because every
      // keystroke silently cancelled the pending analysis.
      const marker = await page.waitForSelector(
        "[data-lwa-highlight][data-issue-id]",
        { timeout: 15_000 },
      );
      expect(marker).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  test("side panel: write directly, run an action, edit the result", async () => {
    const { context } = await launchExtensionContext();
    try {
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`, {
        waitUntil: "domcontentloaded",
      });

      // The working area is editable now — write text directly in the
      // panel (the OLD panel had a readonly box here).
      const box = panel.locator("#selectedText");
      await expect(box).toBeEditable();
      await box.fill("");
      await box.type("She don't like the way this is going.");

      // Run a rewrite directly on panel-written text.
      // v1.8.0 moved the action menu into the "Rewrite & Write" tab —
      // switch there first, exactly like a real user would.
      await panel.locator('#tab-actions').click();
      await panel.locator('#actionMenu .action-item:has-text("Improve it")').click();
      await expect
        .poll(async () => await panel.locator("#resultText").inputValue(), {
          timeout: 10_000,
        })
        .not.toBe("");

      // The result is editable — the user's edits must stick.
      const result = panel.locator("#resultText");
      await result.press("End");
      await result.type(" (edited)");
      const edited = await result.inputValue();
      expect(edited.endsWith(" (edited)")).toBe(true);

      // Panel-written text has no page editor: Replace must say so in
      // the NEW wording (not the old misleading B1 message), and Copy
      // stays available as the apply path.
      await panel.locator("#replaceBtn").click();
      const err = (await panel.locator("#errorLine").textContent()) ?? "";
      expect(err).toContain("no page editor bound");
      const copyBtn = panel.locator("#copyBtn");
      expect(await copyBtn.isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });
});
