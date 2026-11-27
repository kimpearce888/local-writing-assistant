/**
 * STORE LISTING SHOTS — captures the 4 Chrome Web Store screenshots from
 * docs/STORE-LISTING.md.
 *
 * GEOMETRY NOTE: the menu flow runs in the CALIBRATED harness geometry
 * (Xvfb 1280x1024, browser window 1280x1000 — identical to sessions A/B,
 * whose full edit menu + submenu is ~610px tall and only anchors correctly
 * in a >=1000px window). Root captures are 1280x1024 and are CROPPED to
 * the CWS-required 1280x800 afterwards (top-anchored; the context-menu
 * shot is bottom-anchored so the menu + submenu stay in frame).
 *
 * Real extension + real native host + REAL AI (LM Studio-compatible shim
 * on 127.0.0.1:1234). Run in ONE foreground shell so Xvfb and the shim
 * stay alive:
 *
 *   Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
 *   bun /home/z/my-project/mini-services/lmstudio-shim/index.ts &
 *   DISPLAY=:99 node test-lab/store-shots.cjs
 *
 * Output: test-evidence/store/*.png  (each exactly 1280x800 after crop)
 */

process.env.DISPLAY = process.env.DISPLAY || ":99";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  EVID,
  EXTENSION_ID,
  launchSession,
  xinput,
  clientToScreen,
  Runner,
  humanType,
  openExtensionSubmenuAndPick,
  screenShot,
} = require("./lib.cjs");

const OUT = path.join(EVID, "store");
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PYBIN = path.join(path.dirname(__dirname), "test-lab", ".venv", "bin", "python");

/** Crop a 1280x1024 root capture to the CWS-required 1280x800.
 *  anchor "top" keeps the window top; "bottom" keeps the menu area. */
function cropTo800(file, anchor = "top") {
  const y = anchor === "bottom" ? 224 : 0;
  execFileSync(
    PYBIN,
    [
      "-c",
      "import sys; from PIL import Image; im = Image.open(sys.argv[2]); " +
        "im.crop((0, int(sys.argv[1]), 1280, int(sys.argv[1]) + 800)).save(sys.argv[2]) " +
        "if im.size == (1280, 1024) else None",
      String(y),
      file,
    ],
    { encoding: "utf8" },
  );
}

function pngSize(file) {
  const b = fs.readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

async function main() {
  const failures = [];
  const { context, httpPort } = await launchSession({});
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(`http://localhost:${httpPort}/textarea.html`);
  await sleep(800);

  /* Shot 2 — inline underline suggestions (offline fast-check + AI merge). */
  if (!process.env.LWA_SHOTS_SKIP_BASIC) {
  console.log("== shot 2: inline underlines ==");
  await humanType(
    page,
    "#editor",
    "I definately beleive that teh draft was recieve late. Its missing a space,and it has double  spaces.",
    22,
  );  let highlighted = false;
  for (let i = 0; i < 60 && !highlighted; i++) {
    highlighted = await page.evaluate(
      () => document.querySelectorAll("[data-lwa-highlight]").length > 0,
    );
    if (!highlighted) await sleep(500);
  }
  await sleep(1200); // let popups/highlights settle
  const shot2 = path.join(OUT, "store-2-inline-underlines.png");
  await screenShot(shot2);
  cropTo800(shot2);
  if (!highlighted) failures.push("shot 2: no [data-lwa-highlight] appeared within 30s");
  }

  /* Shot 4 + Shot 1 — compose page (contenteditable), driven EXACTLY like
   * session-B via the calibrated lib helper (pixel-gated menu, type-ahead,
   * leak probes). Two menu picks: #1 warms the docked side panel (a cold
   * panel's handshake would consume the stash before the tab driver), #2
   * re-stashes the selection and a tab instance of the panel pulls it via
   * the side-panel-ready handshake, runs the REAL AI rewrite, and replaces
   * the text back onto the page. */
  console.log("== shots 4 + 1: context menu -> rewrite -> replace ==");
  await page.goto(`http://localhost:${httpPort}/compose.html`);
  await sleep(800);
  const pageText = () =>
    page.evaluate(() => document.getElementById("editor")?.innerText || "");
  const originalText = await pageText();
  const restoreText = (v) =>
    page.evaluate((t) => {
      document.getElementById("editor").innerText = t;
    }, v);
  const selectBody = async () => {
    // A REAL X click into the editor first: the browser's widget-level
    // focus must sit on the page content for keyboard shortcuts (ctrl+a)
    // to reach it — evaluate() focus() alone does NOT (measured: selection
    // len 0 vs 304 with the real click).
    const b0 = await page.locator("#editor").boundingBox().catch(() => null);
    if (b0) {
      const p0 = await clientToScreen(
        page,
        b0.x + Math.min(200, b0.width / 2),
        b0.y + 40,
      );
      xinput("click", p0.x, p0.y, 1);
      await sleep(300);
    }
    await page.evaluate(() => document.getElementById("editor").focus());
    await sleep(150);
    xinput("key", "ctrl+a");
    await sleep(300);
    const info = await page.evaluate(() => {
      const sel = document.getSelection();
      const el = document.getElementById("editor");
      return {
        len: (sel?.toString() || "").length,
        inside: !!sel && el.contains(sel.anchorNode) && el.contains(sel.focusNode),
      };
    });
    if (!info.inside || !info.len) {
      await page.evaluate(() => {
        const el = document.getElementById("editor");
        el.focus();
        document.getSelection().selectAllChildren(el);
      });
    }
  };
  const getClickPoint = async () => {
    const b = await page.locator("#editor").boundingBox().catch(() => null);
    if (!b) return null;
    return clientToScreen(
      page,
      b.x + b.width / 2,
      b.y + Math.min(60, b.height / 2),
    );
  };
  const runner = new Runner("STORE");
  const mkEntry = (id, name) => ({
    id,
    name,
    status: "PASS",
    detail: "",
    shots: [],
    error: "",
    ms: 0,
  });

  // Pick #1 — warm the docked panel (consumes stash #1 with the selection).
  await openExtensionSubmenuAndPick(
    runner, page, 0, 0, mkEntry("S4a", "menu pick: rewrite (warm-up)"), "store4-warmup", "r",
    async () => true,
    { reselect: selectBody, getClickPoint, menuChar: "l" },
  );
  await sleep(2500); // docked panel opens + pulls stash #1 via handshake

  // Pick #2 — stash #2; the TAB panel driver pulls it and runs the rewrite.
  let tabPanel = null;
  const panelFound = async () => {
    if (!tabPanel) {
      tabPanel = await context.newPage();
      await tabPanel.setViewportSize({ width: 520, height: 860 });
      await tabPanel.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
      await tabPanel.waitForTimeout(1500); // init + handshake
    }
    const v = await tabPanel.locator("#selectedText").inputValue().catch(() => "");
    return v.trim() ? tabPanel : null;
  };
  const picked = await openExtensionSubmenuAndPick(
    runner, page, 0, 0, mkEntry("S4b", "menu pick: rewrite"), "store-4-context-menu", "r",
    panelFound,
    {
      reselect: selectBody,
      getClickPoint,
      getPageValue: () => pageText(),
      restorePageValue: (v0) => restoreText(v0),
      menuChar: "l",
    },
  );
  if (!picked || !tabPanel) {
    failures.push("shots 4/1: Rewrite… menu pick never produced a populated panel");
  } else {
    // Keep the successful attempt's menu+submenu frame as the store shot.
    const frames = fs
      .readdirSync(EVID)
      .filter((f) => f.startsWith("STORE-store-4-context-menu-") && f.endsWith(".png"))
      .sort();
    const frame = frames[frames.length - 1];
    if (frame) {
      const dest = path.join(OUT, "store-4-context-menu.png");
      fs.copyFileSync(path.join(EVID, frame), dest);
      cropTo800(dest, "bottom"); // menu + submenu live near the frame bottom
      console.log(`  menu frame: ${frame}`);
    }
  }

  /* Shot 1 — REAL AI rewrite applied onto the page, docked panel beside it. */
  if (tabPanel) {
    console.log("== shot 1: real AI rewrite applied to the page ==");
    await tabPanel.locator("#tab-actions").click();
    await sleep(1500);
    const firstCat = tabPanel.locator("#actionMenu .action-cat").first();
    if ((await firstCat.locator(".cat-actions.collapsed").count()) > 0) {
      await firstCat.locator(".cat-title").click();
      await tabPanel.waitForTimeout(300);
    }
    await tabPanel.locator('#actionMenu .action-item:has-text("Improve it")').click();
    let rewritten = false;
    try {
      await tabPanel.waitForFunction(
        () => (document.getElementById("resultText")?.value || "").length > 10,
        undefined,
        { timeout: 90000 },
      );
      rewritten = true;
    } catch {
      failures.push("shot 1: AI rewrite never produced a result within 90s");
    }
    if (rewritten) {
      try {
        await tabPanel.locator("#replaceBtn").click({ timeout: 8000 });
      } catch (e) {
        failures.push(`shot 1: replace button not clickable (${e.message.split("\n")[0]})`);
      }
    }
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const result = await tabPanel.locator("#resultText").inputValue().catch(() => "");
    const head = norm(result).slice(0, 40);
    let replaced = false;
    for (let i = 0; i < 30 && head; i++) {
      await page.waitForTimeout(400);
      const after = norm(await pageText());
      if (after.includes(head)) {
        replaced = true;
        break;
      }
    }
    if (!replaced) failures.push("shot 1: rewritten text not confirmed on the page");
    await page.bringToFront();
    await sleep(1200);
    const shot1 = path.join(OUT, "store-1-sidepanel-rewrite.png");
    await screenShot(shot1);
    cropTo800(shot1);
    console.log(`  rewrite ready: ${rewritten}, replaced: ${replaced}`);
  }

  /* Shot 3 — options page (endpoint config + snippets manager). */
  if (!process.env.LWA_SHOTS_SKIP_BASIC) {
  console.log("== shot 3: options page ==");
  await page.goto(`chrome-extension://${EXTENSION_ID}/options.html`);
  await page.waitForLoadState("load");
  await sleep(1200);
  const shot3 = path.join(OUT, "store-3-options-page.png");
  await screenShot(shot3);
  cropTo800(shot3);
  }

  /* Validate every shot is exactly 1280x800. */
  console.log("\n== validation ==");
  const expected = [
    "store-1-sidepanel-rewrite.png",
    "store-2-inline-underlines.png",
    "store-3-options-page.png",
    "store-4-context-menu.png",
  ];
  for (const f of expected) {
    const p = path.join(OUT, f);
    if (process.env.LWA_SHOTS_SKIP_BASIC && (f.includes("options") || f.includes("underlines"))) continue;
    if (!fs.existsSync(p)) {
      failures.push(`${f}: missing`);
      continue;
    }
    const { w, h } = pngSize(p);
    if (w !== 1280 || h !== 800) failures.push(`${f}: ${w}x${h}, want 1280x800`);
    console.log(`  ${f}: ${w}x${h}`);
  }

  await context.close().catch(() => {});
  if (failures.length) {
    console.error("\nSTORE SHOTS FAILED:\n  " + failures.join("\n  "));
    process.exit(1);
  }
  console.log("\nSTORE SHOTS OK — 4/4 at 1280x800");
}

main().catch((e) => {
  console.error("STORE SHOTS ERROR:", e.message);
  process.exit(1);
});
