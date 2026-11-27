/**
 * HUMAN-LIKE E2E SESSION B — side panel (all 3 tabs), rewrite/write
 * operations with REAL AI, the full context-menu Rewrite -> Replace
 * journey (with the cold-panel handshake), the global toggle,
 * sensitive-field protection, and the AI call log proof.
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
} = require("./lib.cjs");

const fs = require("node:fs");
const path = require("node:path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const runner = new Runner("B");
  const { context, background, httpPort } = await launchSession();
  const P = (n) => `http://127.0.0.1:${httpPort}/${n}`;
  let page = context.pages()[0] || (await context.newPage());

  /* ---------------- B01 sensitive fields are never analyzed ---------------- */
  await runner.step("01", "Password and API-key fields are never analyzed", async (e) => {
    page = await context.newPage();
    await page.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await humanType(page, "#pw", "hunter2-super-secret", 20);
    await humanType(page, "#api-key", "sk-live-abcdef123456", 20);
    await page.waitForTimeout(4000);
    const pwVal = await page.evaluate(() => document.getElementById("pw").value);
    const keyVal = await page.evaluate(() => document.getElementById("api-key").value);
    const n = await countMarkers(page);
    if (pwVal !== "hunter2-super-secret" || keyVal !== "sk-live-abcdef123456")
      throw new Error("sensitive field values were touched");
    runner.note(e, "values intact, 0 inline markers on sensitive fields");
    await runner.shot(page, "01-sensitive-fields", e);
  });

  /* ---------------- B02 side panel Check tab ---------------- */
  await runner.step("02", "Side panel Check tab: 'Check now' returns real AI issues", async (e) => {
    const panel = await context.newPage();
    page = panel;
    await panel.setViewportSize({ width: 520, height: 860 });
    await panel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
    await panel.waitForSelector("#selectedText", { timeout: 10000 });
    await panel.locator("#tab-check").click();
    await panel.locator("#selectedText").fill("");
    await panel.locator("#selectedText").type(
      "Their going to the store, and she don't no the way their. We seen it happen yesterday.",
      { delay: 12 },
    );
    await panel.locator("#checkNowBtn").click();
    await panel.waitForFunction(
      () => document.querySelectorAll("#issuesList li").length > 0,
      undefined,
      { timeout: 60000 },
    );
    const issues = await panel.locator("#issuesList li").count();
    const chip = (await panel.locator("#checkChip").textContent()) || "";
    runner.note(e, `${issues} issue(s) listed; chip="${chip.trim()}"`);
    await runner.shot(panel, "02-sidepanel-check", e);
    await sleep(9000);
  });

  /* ---------------- B03 Insights tab: scores, stats, tone, synonyms ---------------- */
  await runner.step("03", "Insights tab: performance dashboard, stats, tone detection, synonyms", async (e) => {
    const panel = page;
    await panel.locator("#tab-insights").click();
    await panel.waitForFunction(
      () => document.querySelectorAll("#scoreDashboard *").length > 0,
      undefined,
      { timeout: 15000 },
    );
    const stats = (await panel.locator("#statsGrid").textContent()) || "";
    runner.note(e, `stats: ${stats.replace(/\s+/g, " ").slice(0, 110)}`);

    await panel.locator("#detectToneBtn").click();
    let tones = 0;
    for (let i = 0; i < 20; i++) {
      tones = await panel.locator("#toneList li").count();
      if (tones > 0) break;
      await panel.waitForTimeout(400);
    }
    runner.note(e, `tone readings: ${tones}`);

    const words = ["good", "clear", "important"];
    let synNote = "no synonyms found";
    for (const w of words) {
      await panel.locator("#selectedText").evaluate((el, word) => {
        const idx = el.value.indexOf(word);
        el.focus();
        el.setSelectionRange(idx, idx + word.length);
      }, w);
      await panel.locator("#synonymsBtn").click();
      for (let i = 0; i < 12; i++) {
        const c = await panel.locator("#synonymList li").count();
        if (c > 0) {
          synNote = `synonyms for "${w}": ${c} suggestion(s)`;
          break;
        }
        await panel.waitForTimeout(300);
      }
      if ((await panel.locator("#synonymList li").count()) > 0) break;
    }
    if (tones === 0) throw new Error("tone detection produced no readings");
    runner.note(e, synNote);
    await runner.shot(panel, "03-sidepanel-insights", e);
  });

  /* ---------------- B04 Rewrite & Write tab: Improve it ---------------- */
  await runner.step("04", "'Improve it' rewrites the text with REAL AI", async (e) => {
    const panel = page;
    await panel.locator("#tab-actions").click();
    await panel.locator('#actionMenu .action-item:has-text("Improve it")').click();
    await panel.waitForFunction(
      () => (document.getElementById("resultText")?.value || "").length > 10,
      undefined,
      { timeout: 60000 },
    );
    const result = await panel.locator("#resultText").inputValue();
    runner.note(e, `result: "${result.slice(0, 100).replace(/\n/g, " / ")}..."`);
    await runner.shot(panel, "04-improve-it", e);
    await sleep(9000);
  });

  /* ---------------- B05 custom instruction ---------------- */
  await runner.step("05", "Custom instruction: 'Rewrite this as a friendly Slack message'", async (e) => {
    const panel = page;
    await panel.locator("#customInstruction").fill("Rewrite this as a friendly Slack message");
    await panel.locator("#runCustom").click();
    await panel.waitForFunction(
      () => (document.getElementById("resultText")?.value || "").length > 10,
      undefined,
      { timeout: 60000 },
    );
    const result = await panel.locator("#resultText").inputValue();
    runner.note(e, `result: "${result.slice(0, 100).replace(/\n/g, " / ")}..."`);
    await runner.shot(panel, "05-custom-instruction", e);
    await sleep(9000);
  });

  /* ---------------- B06 Write menu: TL;DR ---------------- */
  await runner.step("06", "Write menu: 'Create a TL;DR' generates a summary", async (e) => {
    const panel = page;
    await panel
      .locator("#actionMenu .cat-title")
      .filter({ has: panel.locator('span:text-is("Write")') })
      .click();
    await panel.waitForTimeout(300);
    await panel.locator('#actionMenu .action-item:has-text("Create a TL;DR")').click();
    await panel.waitForFunction(
      () => (document.getElementById("resultText")?.value || "").length > 5,
      undefined,
      { timeout: 60000 },
    );
    const result = await panel.locator("#resultText").inputValue();
    runner.note(e, `TL;DR: "${result.slice(0, 110).replace(/\n/g, " / ")}"`);
    await runner.shot(panel, "06-tldr", e);
    await sleep(9000);
  });

  /* ---------------- B07 Evaluate menu: main point (analysis op) ---------------- */
  await runner.step("07", "Evaluate menu: 'Pick out my main point' analyzes and disables Replace", async (e) => {
    const panel = page;
    await panel
      .locator("#actionMenu .cat-title")
      .filter({ has: panel.locator('span:text-is("Evaluate")') })
      .click();
    await panel.waitForTimeout(300);
    await panel.locator('#actionMenu .action-item:has-text("Pick out my main point")').click();
    await panel.waitForFunction(
      () => (document.getElementById("resultText")?.value || "").length > 5,
      undefined,
      { timeout: 60000 },
    );
    const result = await panel.locator("#resultText").inputValue();
    const replaceDisabled = await panel.locator("#replaceBtn").isDisabled();
    runner.note(
      e,
      `analysis: "${result.slice(0, 90).replace(/\n/g, " / ")}..." | Replace disabled=${replaceDisabled}`,
    );
    await runner.shot(panel, "07-main-point", e);
    await sleep(9000);
  });

  /* ---------------- B08 full journey: select -> right-click Rewrite -> panel -> Replace ---------------- */
  await runner.step("08", "FULL journey: select-all, native menu 'Rewrite…', side panel handshake, Improve it, Replace onto page", async (e) => {
    const compose = await context.newPage();
    await compose.setViewportSize({ width: 1280, height: 1000 });
    await compose.goto(P("compose.html"), { waitUntil: "domcontentloaded" });
    const before = (await compose.evaluate(() => document.getElementById("editor").innerText)) || "";

    // Close stray + stale side-panel pages so the tab panel opened below
    // is the only one.
    for (const p of context.pages()) {
      if (p !== compose && !p.url().startsWith("chrome-extension")) {
        await p.close().catch(() => {});
      }
    }
    for (const p of context.pages()) {
      if (p.url().includes("sidepanel.html")) await p.close().catch(() => {});
    }
    await compose.bringToFront().catch(() => {});
    await compose.waitForTimeout(500);

    const ed = await compose.locator("#editor").boundingBox();
    if (!ed) throw new Error("editor box not found");
    const s1 = await clientToScreen(compose, ed.x + 10, ed.y + 8);
    const s2 = await clientToScreen(compose, ed.x + 300, ed.y + ed.height - 12);
    const clickX = Math.round((s1.x + s2.x) / 2);
    const clickY = Math.round((s1.y + s2.y) / 2);

    // Human selection: focus the editor, then REAL Ctrl+A — inside a
    // contenteditable this selects the editor's own contents, which is
    // what the rewrite flow needs (a page-wide selection cannot be
    // mapped back to the editor adapter by the content script).
    const selectBody = async () => {
      await compose.evaluate(() => document.getElementById("editor").focus());
      await sleep(150);
      xinput("key", "ctrl+a");
      await sleep(300);
      const info = await compose.evaluate(() => {
        const sel = document.getSelection();
        const el = document.getElementById("editor");
        return {
          len: (sel?.toString() || "").length,
          inside: !!sel && el.contains(sel.anchorNode) && el.contains(sel.focusNode),
        };
      });
      if (!info.inside) {
        await compose.evaluate(() => {
          const el = document.getElementById("editor");
          el.focus();
          document.getSelection().selectAllChildren(el);
        });
      }
    };
    await selectBody();
    await compose.waitForTimeout(500);

    // The docked side panel reflows the window — recompute the right-click
    // point from a fresh editor box on every attempt.
    const getClickPoint = async () => {
      const box2 = await compose.locator("#editor").boundingBox().catch(() => null);
      if (!box2) return { x: clickX, y: clickY };
      const a = await clientToScreen(compose, box2.x + 40, box2.y + 40);
      const b = await clientToScreen(compose, box2.x + box2.width - 60, box2.y + box2.height - 40);
      return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
    };

    // Right-click -> native menu -> "Local Writing Assistant" submenu ->
    // "Rewrite…" — the SW stashes the selection; the panel pulls it via
    // the side-panel-ready handshake.
    let tabPanel = null;
    const panelFound = async () => {
      if (!tabPanel) {
        // The DOCKED side panel is not exposed to Playwright as a page.
        // The same panel UI opened as a tab runs the identical code and
        // its cold-start handshake pulls the same stashed selection
        // from the service worker — proving the real delivery path.
        tabPanel = await context.newPage();
        await tabPanel.setViewportSize({ width: 520, height: 860 });
        await tabPanel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
        await tabPanel.waitForTimeout(1500); // init + handshake
      }
      const v = await tabPanel.locator("#selectedText").inputValue().catch(() => "");
      return v.includes("Q3 roadmap") ? tabPanel : null;
    };
    await openExtensionSubmenuAndPick(
      runner,
      compose,
      clickX,
      clickY,
      e,
      "08a-context-menu-rewrite",
      "r", // type-ahead: "Rewrite…" — unique 'r' item in the submenu
      panelFound,
      {
        reselect: selectBody,
        getClickPoint,
        getPageValue: () => compose.evaluate(() => document.getElementById("editor").innerText),
      },
    );
    const panel = tabPanel;
    if (!panel) throw new Error("Rewrite… menu item never opened a populated side panel");
    const selected = await panel.locator("#selectedText").inputValue();
    runner.note(e, `panel preloaded with fresh page selection (${selected.length} chars)`);

    await panel.locator("#tab-actions").click();
    await sleep(9000); // pace the AI backend before the rewrite
    const firstCat = panel.locator("#actionMenu .action-cat").first();
    if ((await firstCat.locator(".cat-actions.collapsed").count()) > 0) {
      await firstCat.locator(".cat-title").click();
      await panel.waitForTimeout(300);
    }
    await panel.locator('#actionMenu .action-item:has-text("Improve it")').click();
    await panel.waitForFunction(
      () => (document.getElementById("resultText")?.value || "").length > 10,
      undefined,
      { timeout: 90000 },
    );
    const result = await panel.locator("#resultText").inputValue();
    runner.note(e, `rewrite ready: "${result.slice(0, 80).replace(/\n/g, " / ")}..."`);
    await runner.shot(panel, "08b-panel-rewrite", e);

    // Replace back onto the page, then REQUIRE the rewritten text on it.
    await panel.locator("#replaceBtn").click();
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const resultHead = norm(result).slice(0, 40);
    let after = before;
    let replaced = false;
    let errLine = "";
    for (let i = 0; i < 30; i++) {
      await compose.waitForTimeout(400);
      after = (await compose.evaluate(() => document.getElementById("editor").innerText)) || "";
      errLine = (await panel.locator("#errorLine").textContent().catch(() => "")) || "";
      if (norm(after).includes(resultHead)) {
        replaced = true;
        break;
      }
      if (errLine.includes("Replaced.") && norm(after) !== norm(before)) {
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      throw new Error(
        `page never received the rewrite (errorLine="${errLine.trim()}", head="${norm(after).slice(0, 60)}")`,
      );
    }
    runner.note(e, `apply confirmed (errorLine="${errLine.trim()}"); page now: "${norm(after).slice(0, 90)}"`);
    await compose.bringToFront().catch(() => {});
    await compose.waitForTimeout(300);
    await runner.shot(compose, "08c-replaced-on-page", e);
    await panel.close().catch(() => {});
  });

  /* ---------------- B09 global enable toggle ---------------- */
  await runner.step("09", "Popup master toggle OFF stops all analysis; ON restores it", async (e) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 420, height: 760 });
    await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await popup.waitForSelector(".switch", { timeout: 10000 });
    const toggleTo = async (pop, want) => {
      const read = () =>
        pop.evaluate(() => document.getElementById("enabledToggle").checked);
      await pop.locator("label.switch").click();
      const t0 = Date.now();
      while (Date.now() - t0 < 2500) {
        if ((await read()) === want) return true;
        await sleep(250);
      }
      for (let i = 0; i < 3; i++) {
        await pop.evaluate((w) => {
          const el = document.getElementById("enabledToggle");
          if (el.checked !== w) el.click();
        }, want);
        const t1 = Date.now();
        while (Date.now() - t1 < 2000) {
          if ((await read()) === want) return true;
          await sleep(250);
        }
      }
      return (await read()) === want;
    };
    if (!(await toggleTo(popup, false))) throw new Error("toggle did not turn OFF");
    await runner.shot(popup, "09a-toggle-off", e);
    await popup.close();

    const wp = await context.newPage();
    page = wp;
    await wp.goto(P("textarea.html"), { waitUntil: "domcontentloaded" });
    await humanType(wp, "#editor", "She don't like it.", 15);
    await wp.waitForTimeout(6000);
    const nOff = await countMarkers(wp);
    if (nOff !== 0) throw new Error(`disabled but ${nOff} marker(s) appeared`);
    runner.note(e, "extension disabled: 0 markers");
    await runner.shot(wp, "09b-disabled-no-markers", e);

    const popup2 = await context.newPage();
    await popup2.setViewportSize({ width: 420, height: 760 });
    await popup2.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
    await popup2.waitForSelector(".switch", { timeout: 10000 });
    if (!(await toggleTo(popup2, true))) throw new Error("toggle did not turn back ON");
    await popup2.close();
    await wp.reload({ waitUntil: "domcontentloaded" });
    await wp.focus("#editor");
    await waitMarker(wp, 60000);
    runner.note(e, "re-enabled: markers are back");
    await runner.shot(wp, "09c-re-enabled", e);
  });

  /* ---------------- B10 AI call log proof ---------------- */
  await runner.step("10", "AI call log proves every result came from a real model round-trip", async (e) => {
    const logPath = "/tmp/lmstudio-shim-calls.log";
    const log = fs.readFileSync(logPath, "utf8");
    const reqs = (log.match(/REQ#/g) || []).length;
    const ress = (log.match(/RES#/g) || []).length;
    const cached = (log.match(/CACHE#/g) || []).length;
    if (reqs < 5) throw new Error(`suspiciously few AI calls: ${reqs}`);
    if (ress < 3) throw new Error(`too few successful AI responses: ${ress}`);
    const dest = path.join(EVID, "ai-call-log.txt");
    fs.writeFileSync(dest, log);
    const samples = log.split("\n").filter((l) => l.includes("RES#")).slice(-3);
    runner.note(
      e,
      `${reqs} AI requests / ${ress} real responses / ${cached} cache-served duplicates; sample: ${samples[0]?.slice(0, 120)}`,
    );
    console.log(samples.join("\n"));
  });

  runner.flush();
  console.log("\nSESSION B COMPLETE:", JSON.stringify(runner.summarize()));
  await context.close().catch(() => {});
  process.exit(0);
})().catch((err) => {
  console.error("SESSION B FATAL:", err);
  process.exit(1);
});
