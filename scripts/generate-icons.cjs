/**
 * Generate proper extension icons from an SVG design, rendered to PNG at
 * multiple resolutions using Playwright's Chromium.
 *
 * The design: a stylized "L" (for Local) inside a rounded square with
 * a blue-to-purple gradient, plus a small caret/quill detail.
 *
 * Why Playwright instead of a pure Node library? Because getting crisp
 * PNG output from SVG requires a real browser renderer — libraries like
 * sharp require native deps that don't always cross-compile cleanly.
 * We already have Chromium installed for the E2E tests, so reusing it
 * here is zero-cost.
 */

const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("@playwright/test");

const ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1f6feb"/>
      <stop offset="100%" stop-color="#8957e5"/>
    </linearGradient>
    <linearGradient id="pen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="#e6edf3" stop-opacity="0.85"/>
    </linearGradient>
  </defs>

  <!-- Rounded background -->
  <rect x="6" y="6" width="116" height="116" rx="24" ry="24" fill="url(#bg)"/>

  <!-- Subtle inner highlight -->
  <rect x="6" y="6" width="116" height="58" rx="24" ry="24" fill="#ffffff" opacity="0.08"/>

  <!-- Stylized "L" — vertical stroke + horizontal foot -->
  <path d="M 44 36 L 44 88 L 84 88 L 84 78 L 54 78 L 54 36 Z"
        fill="url(#pen)"/>

  <!-- Quill/caret detail in the corner — suggests "writing" -->
  <path d="M 88 28 L 100 28 L 100 40 L 96 44 L 92 40 L 88 36 Z"
        fill="#ffffff" opacity="0.9"/>
  <path d="M 88 28 L 92 32 L 96 36 L 100 40 L 100 28 Z"
        fill="#ffffff" opacity="0.6"/>
</svg>
`;

const ROOT = path.resolve(__dirname, "..");
const ICONS_DIR = path.join(ROOT, "extension", "public", "icons");

async function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true });

  const chromePath =
    path.join(process.env.HOME || "", ".cache/ms-playwright/chromium-1243/chrome-linux64/chrome");

  // Use a headless Chrome to render the SVG to PNG at each size.
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(chromePath) ? chromePath : undefined,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 128, height: 128 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  for (const size of [16, 32, 48, 128]) {
    const html = `<!doctype html>
<html><head><style>
  body { margin: 0; padding: 0; background: transparent; }
  svg { width: ${size}px; height: ${size}px; display: block; }
</style></head>
<body>${ICON_SVG}</body></html>`;
    await page.setContent(html);
    await page.waitForLoadState("domcontentloaded");

    const out = path.join(ICONS_DIR, `icon-${size}.png`);
    await page.screenshot({
      path: out,
      type: "png",
      clip: { x: 0, y: 0, width: size, height: size },
      omitBackground: true,
    });
    console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
  }

  await browser.close();

  // Also write the SVG itself for reference / future re-rendering.
  const svgPath = path.join(ICONS_DIR, "icon.svg");
  fs.writeFileSync(svgPath, ICON_SVG.trim() + "\n");
  console.log(`wrote ${svgPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
