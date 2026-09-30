/**
 * Static security audit (spec section 93).
 *
 * Searches every runtime source file for:
 *   - eval(...                 (forbidden — would allow code injection)
 *   - new Function(...)         (forbidden — same reason)
 *   - innerHTML = ...           (allowed only with escapeHtml)
 *   - dangerouslySetInnerHTML   (forbidden)
 *   - document.write(...)       (forbidden)
 *   - shell execution patterns in Go: exec.Command, os/exec
 *   - API keys / secrets: OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY,
 *     AWS_ACCESS_KEY, etc.
 *
 * For each match, prints the file and line number.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "dist-stage", ".git"]);
const SKIP_FILES = new Set(["security-audit.js", "network-audit.js"]);

const FORBIDDEN = [
  { name: "eval()", regex: /\beval\s*\(/g, exts: [".ts", ".tsx", ".js", ".jsx"] },
  { name: "new Function()", regex: /\bnew\s+Function\s*\(/g, exts: [".ts", ".tsx", ".js", ".jsx"] },
  { name: "dangerouslySetInnerHTML", regex: /dangerouslySetInnerHTML/g, exts: [".ts", ".tsx", ".jsx"] },
  { name: "document.write()", regex: /document\.write\s*\(/g, exts: [".ts", ".tsx", ".js", ".jsx"] },
  { name: "exec.Command (Go shell exec)", regex: /\bexec\.Command\b/g, exts: [".go"] },
  { name: "os/exec import (Go shell exec)", regex: /"os\/exec"/g, exts: [".go"] },
  { name: "OPENAI_API_KEY", regex: /OPENAI_API_KEY/g, exts: [".ts", ".tsx", ".js", ".jsx", ".go", ".ps1", ".bat", ".md"] },
  { name: "ANTHROPIC_API_KEY", regex: /ANTHROPIC_API_KEY/g, exts: [".ts", ".tsx", ".js", ".jsx", ".go", ".ps1", ".bat", ".md"] },
  { name: "GEMINI_API_KEY", regex: /GEMINI_API_KEY/g, exts: [".ts", ".tsx", ".js", ".jsx", ".go", ".ps1", ".bat", ".md"] },
  { name: "AWS_ACCESS_KEY", regex: /AWS_ACCESS_KEY/g, exts: [".ts", ".tsx", ".js", ".jsx", ".go", ".ps1", ".bat", ".md"] },
];

// innerHTML is allowed but must be paired with escapeHtml. Flag any
// innerHTML assignment that doesn't have escapeHtml on the same line.
const INNERHTML_REGEX = /\.innerHTML\s*=\s*([^;]+)/g;

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
      scan(path.join(dir, name), ext);
    }
  }
}

function scan(file, ext) {
  if (!fs.existsSync(file)) return;
  // Test files use exec.Command and innerHTML legitimately — they're
  // not shipped to users.
  const isTest = file.includes("/tests/") || file.endsWith("_test.go") || file.endsWith(".test.ts");
  const text = fs.readFileSync(file, "utf8");
  scanned++;
  for (const { name, regex, exts } of FORBIDDEN) {
    if (!exts.includes(ext)) continue;
    if (isTest && (name.includes("exec.Command") || name.includes("os/exec"))) continue;
    // Skip .md files entirely for API-key patterns — docs legitimately
    // enumerate the forbidden names ("there must be no OPENAI_API_KEY").
    if (file.endsWith(".md") && /API_KEY|ACCESS_KEY/.test(name)) continue;
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      // Allow mentions of API key names in security audits / docs that
      // explicitly say "there must be no OPENAI_API_KEY".
      if (file.endsWith(".md")) {
        const ctx = text.split("\n")[
          Math.max(0, line - 1)
        ];
        if (/no\s+|forbidden|never|must\s+not|there\s+must\s+be\s+no/i.test(ctx)) continue;
      }
      if (file.endsWith("security-audit.cjs")) continue;
      console.log(`[FAIL] ${file}:${line}  forbidden "${name}"`);
      issues++;
    }
  }
  // Check innerHTML without escapeHtml. Skip test files — their
  // innerHTML usages are trusted static fixtures, not LLM output.
  if (!isTest && [".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    INNERHTML_REGEX.lastIndex = 0;
    let m;
    while ((m = INNERHTML_REGEX.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      const rhs = m[1] ?? "";
      // Allowed if escapeHtml is present on the RHS.
      if (/escapeHtml/.test(rhs)) continue;
      // Allowed if it's a constant empty string (clearing).
      if (/^\s*['"]\s*['"]\s*$/.test(rhs)) continue;
      console.log(
        `[FAIL] ${file}:${line}  innerHTML assignment without escapeHtml: ${rhs.slice(0, 80)}`,
      );
      issues++;
    }
  }
}

walk(ROOT);

console.log("");
console.log(`Scanned ${scanned} source files.`);
if (issues === 0) {
  console.log("[PASS] No forbidden security patterns found.");
  process.exit(0);
} else {
  console.log(`[FAIL] Found ${issues} forbidden pattern(s).`);
  process.exit(1);
}
