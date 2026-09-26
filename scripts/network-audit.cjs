/**
 * Static network audit (spec section 92).
 *
 * Walks every source file (excluding node_modules / dist / build
 * artifacts) and flags any occurrence of:
 *   - fetch(...    (we use chrome.runtime.connectNative instead)
 *   - XMLHttpRequest
 *   - WebSocket
 *   - EventSource
 *   - axios
 *   - http:// or https:// URLs that are NOT 127.0.0.1 / localhost
 *
 * The only permitted runtime network destination is the local LM
 * Studio server. Anything else is treated as a build failure.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "tests",
]);
const SKIP_FILES = new Set([
  "network-audit.js", // self
  "security-audit.js",
]);

const FORBIDDEN_PATTERNS = [
  { name: "fetch(", regex: /\bfetch\s*\(/g },
  { name: "XMLHttpRequest", regex: /\bXMLHttpRequest\b/g },
  { name: "WebSocket", regex: /\bWebSocket\b/g },
  { name: "EventSource", regex: /\bEventSource\b/g },
  { name: "axios", regex: /\baxios\b/g },
];

// Permitted host substrings in URLs.
const ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"];

let issues = 0;
let scanned = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      const name = entry.name;
      if (SKIP_FILES.has(name)) continue;
      const ext = path.extname(name).toLowerCase();
      if (![".ts", ".tsx", ".js", ".jsx", ".json", ".html", ".css", ".go", ".ps1", ".bat", ".md"].includes(ext)) continue;
      const full = path.join(dir, name);
      scan(full);
    }
  }
}

function scan(file) {
  const text = fs.readFileSync(file, "utf8");
  scanned++;
  // Skip lock files — they're build-time metadata, not runtime code.
  if (file.endsWith("package-lock.json") || file.endsWith("yarn.lock")) return;
  // Skip docs — they describe patterns but don't execute them.
  if (file.endsWith(".md")) return;
  // Check forbidden patterns.
  for (const { name, regex } of FORBIDDEN_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      console.log(`[FAIL] ${file}:${line}  forbidden "${name}"`);
      issues++;
    }
  }
  // Check non-local URLs.
  const urlRegex = /https?:\/\/([^/:"'\s]+)/g;
  let m;
  while ((m = urlRegex.exec(text))) {
    const host = m[1].toLowerCase();
    // Allow only loopback.
    const isLocal = ALLOWED_HOSTS.some((h) => host.startsWith(h));
    if (isLocal) continue;
    // Skip XML namespace URIs in PowerShell / XML files — those are
    // identifiers, not network calls. Chrome's update.xml schema requires
    // the http://www.google.com/update2/response namespace.
    if (file.endsWith(".ps1") && host.includes("google.com/update2")) continue;
    if (file.endsWith(".ps1") && host === "www.google.com") continue;
    // Skip test fixtures that intentionally exercise rejection logic.
    if (file.endsWith("_test.go")) {
      // These tests deliberately include "should be rejected" URLs —
      // any 0.0.0.0 / 10.x / 192.168.x / example.com / user@ in test
      // files is intentional and not a runtime call.
      if (/(0\.0\.0\.0|192\.168|10\.0\.|example\.com|user:pass|^user$)/.test(host)) continue;
    }
    const line = text.slice(0, m.index).split("\n").length;
    console.log(`[FAIL] ${file}:${line}  non-local URL "http://${host}"`);
    issues++;
  }
}

walk(ROOT);

console.log("");
console.log(`Scanned ${scanned} source files.`);
if (issues === 0) {
  console.log("[PASS] No forbidden network patterns found.");
  process.exit(0);
} else {
  console.log(`[FAIL] Found ${issues} forbidden pattern(s).`);
  process.exit(1);
}
