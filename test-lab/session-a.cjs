/**
 * HUMAN-LIKE E2E SESSION A — Local Writing Assistant (v1.10.1)
 *
 * Real Chromium + real extension + real native host + REAL AI
 * (LM Studio-compatible shim on 127.0.0.1:1234 backed by z-ai-web-dev-sdk).
 * OS-level X11 input where Chrome UI is involved (native context menus).
 */

process.env.DISPLAY = process.env.DISPLAY || ":99";
const {
  EVID,
  EXTENSION_ID,
  launchSession,
  xinput,
  clientToScreen,
  Runner,
  waitMarker,
  countMarkers,
  humanType,
  openExtensionSubmenuAndPick,
  deepHasText,
} = require("./lib.cjs");

(async () => {
  const runner = new Runner("A");
  const { context, background, httpPort } = await launchSession();
  const P = (n) => `http://127.0.0.1:${httpPort}/${n}`;

  let page = context.pages()[0] || (await context.newPage());

  /* ---------------- A01 extension installed & enabled ---------------- */
  await runner.step("01", "Extension is installed and enabled in chrome://extensions", async (e) => {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const found = await deepHasText(page, "Local Writing Assistant");
    if (!found) throw new Error("extension name not found on chrome://extensions");
    const errBtn = await deepHasText(page, "Errors");
    runner.note(e, `name visible; errors button present=${errBtn}`);
    await runner.shot(page, "01-extensions-page", e);
  });

  /* ---------------- A02 popup: real connection status ---------------- */
  await runner.step("02", "Popup shows REAL Connected status (native host -> shim -> model list + AI ping)", async (e) => {
    page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 760 });
    await page.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await page.waitForSelector("#connStatus", { timeout: 10000 });
    await page.waitForFunction(
      () => (document.getElementById("connStatus")?.textContent || "").includes("Connected"),
      undefined,
      { timeout: 45000 },
    );
    const model = (await page.locator("#modelValue").textContent()) || "";
    const sugg = (await page.locator("#suggestionsValue").textContent()) || "";
    runner.note(e, `model="${model.trim()}" suggestions=${sugg.trim()}`);
    await runner.shot(page, "02-popup-connected", e);
  });

  /* ---------------- A03 popup: Test LM Studio Connection ---------------- */
  await runner.step("03", "Popup 'Test LM Studio Connection' round-trip", async (e) => {
    await page.locator("#testBtn").click();
    await page.waitForFunction(
      () => {
        const el = document.getElementById("diagLine");
        const t = (el?.textContent || "").trim();
        return t.includes("passed") || t.includes("failed");
      },
      undefined,
      { timeout: 60000 },
    );
    const txt = ((await page.locator("#diagLine").textContent()) || "").trim();
    if (txt.includes("failed")) throw new Error(`connection test failed: ${txt}`);
    runner.note(e, `diag: ${txt}`);
    await runner.shot(page, "03-popup-connection-test", e);
  });

  /* ---------------- A04 realtime check while typing (textarea) ---------------- */
  await runner.step("04", "Real-time grammar check appears WHILE typing (real AI, per-keystroke)", async (e) => {
    page = await context.newPage();
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await humanType(page, "#editor", "She don't like it.", 22);
    await waitMarker(page, 60000);
    const n = await countMarkers(page);
    runner.note(e, `${n} inline marker(s) after ~4s typing + debounce + AI round-trip`);
    await page.waitForTimeout(400);
    await runner.shot(page, "04-realtime-markers", e);
  });

  /* ---------------- A05 hover opens suggestion card ---------------- */
  await runner.step("05", "Hovering an underlined issue opens the suggestion card", async (e) => {
    const marker = await waitMarker(page, 20000);
    await marker.hover();
    await page.waitForSelector("[data-lwa-popup]", { timeout: 8000 });
    runner.note(e, "suggestion card rendered on hover");
    await runner.shot(page, "05-hover-card", e);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  });

  /* ---------------- A06 click -> popup -> Replace applies fix ---------------- */
  await runner.step("06", "Suggestion popup Replace button applies the AI fix", async (e) => {
    const marker = await waitMarker(page, 20000);
    await marker.click();
    const popup = await page.waitForSelector("[data-lwa-popup]", { timeout: 8000 });
    const ptxt = (await popup.evaluate((el) => el.textContent)) || "";
    runner.note(e, `popup content: ${ptxt.slice(0, 120)}`);
    await runner.shot(page, "06a-suggestion-popup", e);
    await page.locator("[data-lwa-popup] button", { hasText: "Replace" }).click();
    await page.waitForFunction(
      () => window.__getEditorValue() !== "She don't like it.",
      undefined,
      { timeout: 10000 },
    );
    const after = await page.evaluate(() => window.__getEditorValue());
    runner.note(e, `editor now: "${after}"`);
    await runner.shot(page, "06b-after-replace", e);
  });

  /* ---------------- A07 offline fast-check (local rules, no AI) ---------------- */
  await runner.step("07", "Offline fast-check underlines local-rule errors instantly (v1.10.0)", async (e) => {
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    const t0 = Date.now();
    await humanType(page, "#editor", "teh report is recieved", 22);
    let n = 0;
    for (let i = 0; i < 40; i++) {
      n = await countMarkers(page);
      if (n >= 2) break;
      await page.waitForTimeout(400);
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    if (n < 2) throw new Error(`only ${n} marker(s) from local rules`);
    runner.note(e, `${n} markers in ${dt}s (local rules: teh + recieved)`);
    await runner.shot(page, "07-offline-fastcheck", e);
  });

  /* ---------------- A08 floating widget ---------------- */
  await runner.step("08", "Floating assistant widget docks to the editor", async (e) => {
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await page.focus("#editor");
    await page.type(
      "#editor",
      "Hi Sarah, I wanted to follow up on the Q3 roadmap we discussed last week. The team don't have a clear sense of priorities yet, and we should revisit the scope before the next milestone. Could we set up a short call on Thursday to align?",
      { delay: 10 },
    );
    await page.evaluate(() => document.getElementById("editor").blur());
    await page.waitForTimeout(300);
    await page.focus("#editor");
    let vis = { found: false };
    for (let i = 0; i < 10; i++) {
      vis = await page.evaluate(() => {
        const find = (root) => {
          const direct = root.querySelector('[data-lwa-widget="true"]');
          if (direct) {
            const r = direct.getBoundingClientRect();
            return { found: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          }
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) {
              const inner = find(el.shadowRoot);
              if (inner.found) return inner;
            }
          }
          return { found: false };
        };
        return find(document);
      });
      if (vis.found) break;
      await page.waitForTimeout(400);
    }
    if (!vis.found) throw new Error("no [data-lwa-widget] element (deep query)");
    runner.note(e, `widget rect ${JSON.stringify(vis)}`);
    await runner.shot(page, "08-floating-widget", e);
  });

  /* ---------------- A09 contenteditable (compose page) ---------------- */
  await runner.step("09", "Content-rich email compose page gets inline checks (contenteditable)", async (e) => {
    page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto(P("compose.html"), { waitUntil: "domcontentloaded" });
    await page.focus("#editor");
    await waitMarker(page, 60000);
    const n = await countMarkers(page);
    runner.note(e, `${n} marker(s) on the email draft`);
    await page.waitForTimeout(400);
    await runner.shot(page, "09-compose-page", e);
  });

  /* ---------------- A10 options: create a snippet via the form ---------------- */
  await runner.step("10", "Options page: create snippet 'sig' via the form", async (e) => {
    page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await page.waitForSelector("#newSnippetShortcut", { timeout: 10000 });
    await page.fill("#newSnippetShortcut", "sig");
    await page.fill("#newSnippetLabel", "Email signature");
    await page.fill("#newSnippetContent", "Best regards,\nAlex Kim\nFounder, Example Corp");
    await runner.shot(page, "10a-options-snippet-form", e);
    await page.locator("#addSnippet").click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#snippetList li")].some((li) =>
          li.textContent.includes("sig"),
        ),
      undefined,
      { timeout: 8000 },
    );
    const count = await page.locator("#snippetList li").count();
    runner.note(e, `snippet list now has ${count} item(s)`);
    await page.locator("#snippetList").scrollIntoViewIfNeeded();
    await runner.shot(page, "10b-snippet-saved", e);
    await page.close();
    page = (await context.pages()[0]) || page;
  });

  /* ---------------- A11 real right-click -> Save selection as snippet ---------------- */
  await runner.step("11", "Native context menu: 'Save selection as snippet' (real X11 right-click)", async (e) => {
    for (const p of context.pages()) {
      if (!p.url().includes("textarea.html") && !p.url().startsWith("chrome-extension")) {
        await p.close().catch(() => {});
      }
    }
    page = await context.newPage();
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(400);
    const input = page.locator("#plain-input");
    const selectInput = async () => {
      // Click into the input, then REAL Ctrl+A — drag-select proved
      // flaky on the input's padding; select-all is what a human does.
      await page.locator("#plain-input").click();
      xinput("key", "ctrl+a");
      await page.waitForTimeout(250);
      const len = await page.evaluate(() => {
        const el = document.getElementById("plain-input");
        return el.selectionEnd - el.selectionStart;
      });
      if (len < 5) {
        await page.evaluate(() => {
          const el = document.getElementById("plain-input");
          el.focus();
          el.select();
        });
      }
      const box = await input.boundingBox();
      if (!box) throw new Error("plain-input box not found");
      const a = await clientToScreen(page, box.x + 8, box.y + box.height / 2);
      const b = await clientToScreen(page, box.x + box.width - 20, box.y + box.height / 2);
      return Math.round((a.x + b.x) / 2);
    };
    const clickX = await selectInput();
    await page.waitForTimeout(400);

    const checkOptions = async () => {
      // A wrong type-ahead hit can open a Google search tab — close it
      // so the real pointer stays on our page for the next attempt.
      for (const p of context.pages()) {
        if (p.url().includes("google.")) await p.close().catch(() => {});
      }
      const opts = context.pages().filter((p) => p.url().includes("options.html"));
      for (const op of opts) {
        const v = await op
          .locator("#newSnippetContent")
          .inputValue()
          .catch(() => "");
        // Must be the FRESH selection from this page, not a stale stash.
        if (v.includes("He go to school")) return op;
      }
      return null;
    };

    const opened = await openExtensionSubmenuAndPick(
      runner,
      page,
      clickX,
      (await clientToScreen(page, (await input.boundingBox()).x + 8, (await input.boundingBox()).y + 10)).y,
      e,
      "11a-context-menu",
      "s", // type-ahead: "Save selection as snippet" — unique 's' item in the submenu
      checkOptions,
      {
        reselect: async () => {
          await selectInput();
        },
        getPageValue: () => page.evaluate(() => document.getElementById("plain-input").value),
        restorePageValue: (v) => page.evaluate((val) => { document.getElementById("plain-input").value = val; }, v),
      },
    );
    if (!opened) throw new Error("Save-selection-as-snippet menu item never activated");
    const optionsPage = context.pages().find((p) => p.url().includes("options.html"));
    if (!optionsPage) throw new Error("options page not found after menu activation");
    runner.note(e, "options page opened with the selection pre-filled");

    await optionsPage.locator("#newSnippetShortcut").fill("addr");
    await optionsPage.locator("#newSnippetLabel").fill("From selection");
    await optionsPage.locator("#addSnippet").click();
    await optionsPage.waitForFunction(
      () =>
        [...document.querySelectorAll("#snippetList li")].some((li) =>
          li.textContent.includes("addr"),
        ),
      undefined,
      { timeout: 8000 },
    );
    const content = await optionsPage.locator("#newSnippetContent").inputValue();
    runner.note(e, `saved snippet "addr" from context-menu selection: "${content.slice(0, 60)}"`);
    await optionsPage.locator("#snippetList").scrollIntoViewIfNeeded();
    await runner.shot(optionsPage, "11b-snippet-from-selection", e);
    await optionsPage.close();
  });

  /* ---------------- A12 snippet expansion while typing ---------------- */
  await runner.step("12", "Snippet expansion: typing ';sig' expands to the full signature", async (e) => {
    page = await context.newPage();
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await page.focus("#editor");
    await page.fill("#editor", "");
    await page.type("#editor", "Reach me anytime. ;sig", { delay: 18 });
    let val = "";
    for (let i = 0; i < 25; i++) {
      val = await page.evaluate(() => window.__getEditorValue());
      if (val.includes("Best regards")) break;
      await page.waitForTimeout(300);
    }
    if (!val.includes("Best regards")) throw new Error(`no expansion; value="${val}"`);
    runner.note(e, `expanded (${val.length} chars): "${val.slice(0, 90).replace(/\n/g, " / ")}..."`);
    await runner.shot(page, "12-snippet-expanded", e);
  });

  /* ---------------- A13 settings persistence + models + diagnostics ---------------- */
  await runner.step("13", "Settings persist; Refresh models lists the real model; diagnostics run", async (e) => {
    page = await context.newPage();
    await page.setViewportSize({ width: 1000, height: 900 });
    await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
    await page.waitForSelector("#dialect", { timeout: 10000 });
    await page.selectOption("#dialect", "uk");
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#dialect", { timeout: 10000 });
    const dialect = await page.locator("#dialect").inputValue();
    if (dialect !== "uk") throw new Error(`dialect did not persist (${dialect})`);
    runner.note(e, "dialect=uk persisted across reload");

    await page.locator("#refreshModels").click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("#model option")].some((o) =>
          o.textContent.includes("glm"),
        ),
      undefined,
      { timeout: 30000 },
    );
    await page.selectOption("#model", "glm-4.6");
    const modelOpts = await page.locator("#model option").allTextContents();
    runner.note(e, `models: ${modelOpts.join(", ")}; selected glm-4.6`);
    await runner.shot(page, "13a-options-models", e);

    await page.locator("#runDiag").click();
    await page.waitForFunction(
      () => (document.getElementById("diagOutput")?.textContent || "").trim().length > 20,
      undefined,
      { timeout: 60000 },
    );
    const diag = (await page.locator("#diagOutput").textContent()) || "";
    runner.note(e, `diagnostics: ${diag.replace(/\s+/g, " ").slice(0, 200)}`);
    await runner.shot(page, "13b-options-diagnostics", e, { fullPage: true });
  });

  /* ---------------- A14 pause / resume site ---------------- */
  await runner.step("14", "Pause on this site suppresses analysis; Resume restores it", async (e) => {
    page = await context.newPage();
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    const host = `127.0.0.1:${httpPort}`;
    await background.evaluate(async (h) => {
      await chrome.storage.local.set({ [`paused:${h}`]: true });
    }, host);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.focus("#editor");
    await humanType(page, "#editor", "She don't like it.", 15);
    await page.waitForTimeout(5000);
    const paused = await countMarkers(page);
    if (paused !== 0) throw new Error(`site paused but ${paused} marker(s) appeared`);
    runner.note(e, "paused: 0 markers while typing an error sentence");
    await runner.shot(page, "14a-paused-site", e);

    await background.evaluate(async (h) => {
      await chrome.storage.local.remove(`paused:${h}`);
    }, host);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.focus("#editor");
    await waitMarker(page, 60000);
    runner.note(e, "resumed: markers are back");
    await runner.shot(page, "14b-resumed-site", e);
  });

  runner.flush();
  console.log("\nSESSION A COMPLETE:", JSON.stringify(runner.summarize()));
  await context.close().catch(() => {});
  process.exit(0);
})().catch((err) => {
  console.error("SESSION A FATAL:", err);
  process.exit(1);
});
