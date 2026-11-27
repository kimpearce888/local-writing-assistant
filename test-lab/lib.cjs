/**
 * Shared library for the human-like E2E sessions of the Local Writing
 * Assistant extension.
 *
 * Differences from the unit-test fixture (tests/e2e/fixtures/extension.cjs):
 *   - NO LOCAL_MOCK_AI: the Go native host talks to the REAL-AI shim
 *     listening on 127.0.0.1:1234 (LM Studio-compatible API backed by
 *     z-ai-web-dev-sdk), so every AI result is genuine model output.
 *   - Browser window is pinned to (0,0) 1280x1000 with scale factor 1
 *     so REAL X11 input (xhuman.py, XTEST) can hit exact page pixels —
 *     needed for right-click context menus, which only respond to
 *     genuine OS-level input.
 *   - Every step records a screenshot + assertions into test-evidence/.
 *
 * Native context menu strategy (calibrated on Chromium 159 / Xvfb,
 * see the runs' evidence shots):
 *   - right-click opens the menu (pixel-diff gate: CDP cannot see
 *     browser-drawn UI, but Xvfb frames are pixel-identical when
 *     nothing changes);
 *   - type-ahead "l" jumps to the "Local Writing Assistant" entry
 *     (no browser row starts with "L"), Right opens its submenu;
 *   - the target item is activated by its unique first letter ("s" =
 *     Save selection as snippet, "r" = Rewrite…) + Return;
 *   - a LEAK PROBE guards every keystroke: the page content is read
 *     before/after typing the item letter — if the page changed, the
 *     keys went to the page (submenu did not open) and the attempt
 *     aborts cleanly instead of typing into the document.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { chromium } = require("/home/z/audit-repo/node_modules/@playwright/test");

const ROOT = "/home/z/audit-repo";
const EVID = path.join(ROOT, "test-evidence");
const EXTENSION_ID = "lclfegmpnhibpkijgmlpjaoemnjpabcp";
const XHUMAN = path.join(ROOT, "test-lab", "xhuman.py");
const PYBIN = path.join(ROOT, "test-lab", ".venv", "bin", "python");

fs.mkdirSync(EVID, { recursive: true });

/* ---------------------------------------------------------------- pages */

let _httpServer = null;
let _httpPort = 0;
async function servePages() {
  if (_httpServer) return _httpPort;
  const pagesDir = path.join(ROOT, "tests", "e2e", "pages");
  _httpServer = http.createServer((req, res) => {
    let p = req.url.split("?")[0];
    if (p === "/") p = "/textarea.html";
    const filePath = path.join(pagesDir, p);
    if (!filePath.startsWith(pagesDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(filePath, "utf8"));
  });
  await new Promise((resolve) => {
    _httpServer.listen(0, "127.0.0.1", () => {
      _httpPort = _httpServer.address().port;
      resolve(_httpPort);
    });
  });
  return _httpPort;
}

/* -------------------------------------------------------------- launcher */

function writeNativeMessagingManifest(userDataDir) {
  const dir = path.join(userDataDir, "NativeMessagingHosts");
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    name: "com.localwritingassistant.host",
    description: "Local Writing Assistant native messaging host",
    path: path.join(ROOT, "native-host", "build", "LocalWritingAssistantHost"),
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  fs.writeFileSync(
    path.join(dir, "com.localwritingassistant.host.json"),
    JSON.stringify(manifest, null, 2),
  );
}

async function launchSession({ userDataDir } = {}) {
  const httpPort = await servePages();
  const extPath = path.join(ROOT, "extension", "dist");
  if (!fs.existsSync(path.join(extPath, "manifest.json"))) {
    throw new Error("extension/dist missing — build it first");
  }
  const hostBin = path.join(ROOT, "native-host", "build", "LocalWritingAssistantHost");
  if (!fs.existsSync(hostBin)) throw new Error("native host binary missing");

  const udd =
    userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), "lwa-human-"));
  fs.rmSync(path.join(udd, "SingletonLock"), { force: true });
  fs.rmSync(path.join(udd, "SingletonSocket"), { force: true });
  fs.rmSync(path.join(udd, "SingletonCookie"), { force: true });
  writeNativeMessagingManifest(udd);

  const context = await chromium.launchPersistentContext(udd, {
    headless: false,
    executablePath: "/home/z/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome",
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "--window-position=0,0",
      "--window-size=1280,1000",
      "--force-device-scale-factor=1",
    ],
    viewport: null,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
  });

  let background = null;
  for (let i = 0; i < 30 && !background; i++) {
    if (context.serviceWorkers().length > 0) {
      background = context.serviceWorkers()[0];
      break;
    }
    background = await context
      .waitForEvent("serviceworker", { timeout: 2000 })
      .catch(() => null);
  }
  if (!background) throw new Error("extension service worker not found");
  return { context, background, httpPort, userDataDir: udd };
}

/* ------------------------------------------------------- X11 (human) I/O */

function xinput(...args) {
  return execFileSync(PYBIN, [XHUMAN, ...args], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
    timeout: 20000,
    encoding: "utf8",
  });
}

/** Map client coords (CSS px inside the page) to Xvfb screen coords. */
async function clientToScreen(page, clientX, clientY) {
  return page.evaluate(
    ({ cx, cy }) => {
      const chromeH = window.outerHeight - window.innerHeight;
      const chromeW = (window.outerWidth - window.innerWidth) / 2;
      return {
        x: Math.round(window.screenX + chromeW + cx),
        y: Math.round(window.screenY + chromeH + cy),
      };
    },
    { cx: clientX, cy: clientY },
  );
}

async function screenShot(pathOut) {
  xinput("shot", pathOut);
}

/* ---------------------------------------------------------------- runner */

class Runner {
  constructor(sessionTag) {
    this.tag = sessionTag;
    this.results = [];
    this.t0 = Date.now();
  }

  async step(id, name, fn) {
    const entry = {
      id: `${this.tag}-${id}`,
      name,
      status: "PASS",
      detail: "",
      shots: [],
      error: "",
      ms: 0,
    };
    const started = Date.now();
    console.log(`\n[${entry.id}] ${name}`);
    try {
      await fn(entry);
    } catch (err) {
      entry.status = "FAIL";
      entry.error = String(err && err.message ? err.message : err).slice(0, 500);
      console.log(`  FAIL: ${entry.error}`);
    }
    entry.ms = Date.now() - started;
    console.log(`  -> ${entry.status} (${(entry.ms / 1000).toFixed(1)}s)`);
    this.results.push(entry);
    this.flush();
    return entry;
  }

  shot(page, name, entry, opts = {}) {
    const file = `${this.tag}-${name}.png`;
    const full = path.join(EVID, file);
    return page
      .screenshot({ path: full, ...opts })
      .then(() => {
        entry.shots.push(file);
        console.log(`  shot: ${file}`);
      })
      .catch((e) => console.log(`  shot failed: ${e.message}`));
  }

  xshot(name, entry) {
    const file = `${this.tag}-${name}.png`;
    try {
      screenShot(path.join(EVID, file));
      entry.shots.push(file);
      console.log(`  xshot: ${file}`);
    } catch (e) {
      console.log(`  xshot failed: ${e.message}`);
    }
  }

  note(entry, text) {
    entry.detail += (entry.detail ? " | " : "") + text;
    console.log(`  note: ${text}`);
  }

  flush() {
    fs.writeFileSync(
      path.join(EVID, `RESULTS-${this.tag}.json`),
      JSON.stringify(
        {
          session: this.tag,
          started: new Date(this.t0).toISOString(),
          finished: new Date().toISOString(),
          aiCallLog: "ai-call-log.txt",
          results: this.results,
          summary: this.summarize(),
        },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(EVID, `RESULTS-${this.tag}.md`),
      this.renderMarkdown(),
    );
  }

  summarize() {
    const pass = this.results.filter((r) => r.status === "PASS").length;
    const fail = this.results.filter((r) => r.status === "FAIL").length;
    return { total: this.results.length, pass, fail };
  }

  renderMarkdown() {
    const s = this.summarize();
    const lines = [
      `# E2E session ${this.tag} — ${new Date().toISOString()}`,
      ``,
      `**${s.pass}/${s.total} steps passed, ${s.fail} failed**`,
      ``,
      `| Step | Name | Result | Time | Shots | Detail |`,
      `|---|---|---|---|---|---|`,
    ];
    for (const r of this.results) {
      lines.push(
        `| ${r.id} | ${r.name} | ${r.status} | ${(r.ms / 1000).toFixed(1)}s | ${r.shots
          .map((x) => `\`${x}\``)
          .join(", ")} | ${(r.error || r.detail).replace(/\|/g, "\\|").slice(0, 220)} |`,
      );
    }
    return lines.join("\n") + "\n";
  }
}

/* --------------------------------------------------------------- helpers */

async function waitMarker(page, timeout = 45000) {
  return page.waitForSelector("[data-lwa-highlight][data-issue-id]", {
    timeout,
  });
}

async function countMarkers(page) {
  return page.evaluate(
    () => document.querySelectorAll("[data-lwa-highlight][data-issue-id]").length,
  );
}

async function humanType(page, selector, text, delay = 25) {
  await page.focus(selector);
  await page.fill(selector, "");
  await page.type(selector, text, { delay });
}

/** Open the extension's NATIVE context menu with REAL X input on a page
 *  selection, then activate the submenu item whose first letter matches
 *  `itemChar` ("s" = Save selection as snippet, "r" = Rewrite…). */
const MENU_HEIGHT = 490;
const SCREEN_H = 1024;

function xdiff(a, b, x, y, w, h) {
  const out = execFileSync(
    PYBIN,
    [XHUMAN, "diff", a, b, String(x), String(y), String(w), String(h)],
    { env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" }, timeout: 20000, encoding: "utf8" },
  );
  return parseFloat(out.trim()) || 0;
}

const TMP_A = "/tmp/lwa-menu-a.png";
const TMP_B = "/tmp/lwa-menu-b.png";

/** TRUE when the native context menu is visibly open: Xvfb frames are
 *  pixel-identical when nothing changes, so any real diff inside the
 *  menu region means browser-drawn UI appeared (CDP cannot see it). */
async function menuVisible(page, clickX, clickY) {
  xinput("shot", TMP_B);
  const x = Math.max(0, clickX - 10);
  const y = Math.max(0, Math.min(clickY, SCREEN_H - 8 - MENU_HEIGHT) - 10);
  return xdiff(TMP_A, TMP_B, x, y, 460, MENU_HEIGHT) > 5;
}

async function openExtensionSubmenuAndPick(
  runner,
  page,
  clickX,
  clickY,
  entry,
  shotBase,
  itemChar,
  verifyFn,
  opts = {},
) {
  const {
    reselect = null,
    getPageValue = null,
    restorePageValue = null,
    timeout = 20000,
    getClickPoint = null,
    menuChar = "l", // no browser row starts with "L" — type-ahead jumps to
    // "Local Writing Assistant" whatever the menu height happens to be
  } = opts;

  for (let attempt = 1; attempt <= 4; attempt++) {
    let cx = clickX;
    let cy = clickY;
    if (getClickPoint) {
      const p = await getClickPoint();
      if (p) {
        cx = p.x;
        cy = p.y;
      }
    }
    if (reselect) {
      await reselect();
      await page.waitForTimeout(350);
    }
    xinput("shot", TMP_A); // baseline before the menu opens
    xinput("click", cx, cy, 3); // real right-click -> native menu
    await page.waitForTimeout(800);
    if (!(await menuVisible(page, cx, cy))) {
      runner.note(entry, `attempt ${attempt}: right-click did not open a menu, retrying`);
      continue;
    }
    xinput("shot", TMP_A); // menu open = new baseline

    // Type-ahead: highlight "Local Writing Assistant", then Right opens
    // its submenu — geometry-independent.
    xinput("type", menuChar);
    await page.waitForTimeout(350);
    xinput("key", "Right");
    await page.waitForTimeout(500);
    runner.xshot(`${shotBase}-${attempt}`, entry);
    // NO pixel gate for the submenu: over a white page the submenu is
    // white-on-white to the region differ and would false-negative
    // forever. Safety is enforced by the leak probe below — if the
    // submenu did NOT open, the item keystroke lands on the PAGE, its
    // content changes, and the attempt aborts before Return misfires.
    if (getPageValue) {
      const v0 = await getPageValue();
      xinput("type", itemChar);
      await page.waitForTimeout(280);
      const v1 = await getPageValue();
      if (v1 !== v0) {
        if (restorePageValue) await restorePageValue(v0);
        runner.note(entry, `attempt ${attempt}: keys leaked to page, aborting cleanly`);
        xinput("key", "Escape");
        await page.waitForTimeout(350);
        continue;
      }
    } else {
      xinput("type", itemChar);
      await page.waitForTimeout(280);
    }
    xinput("key", "Return");
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await verifyFn()) return true;
      await page.waitForTimeout(300);
    }
    xinput("key", "Escape");
    await page.waitForTimeout(400);
  }
  return false;
}

async function deepHasText(page, text) {
  return page.evaluate((t) => {
    const walk = (root) => {
      for (const el of root.querySelectorAll("*")) {
        if (
          el.children.length === 0 &&
          (el.textContent || "").includes(t)
        )
          return true;
        if (el.shadowRoot && walk(el.shadowRoot)) return true;
      }
      return false;
    };
    return walk(document);
  }, text);
}

module.exports = {
  ROOT,
  EVID,
  EXTENSION_ID,
  servePages,
  launchSession,
  xinput,
  clientToScreen,
  Runner,
  waitMarker,
  countMarkers,
  humanType,
  openExtensionSubmenuAndPick,
  deepHasText,
  screenShot,
};
