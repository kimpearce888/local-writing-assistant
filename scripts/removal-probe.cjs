#!/usr/bin/env node
/**
 * GAADS §6 removal probe — executable enforcement of module removability.
 *
 * Proves that the `shared/local-check.ts` leaf module (offline fast-check,
 * added in v1.10.0) can be removed without breaking unrelated functionality:
 *
 *   1. creates a DISPOSABLE git worktree at HEAD (the user's working tree
 *      is never touched);
 *   2. deletes the module and its module-owned test file;
 *   3. excises its references from the two DECLARED consumers only
 *      (content/suggestion-engine.ts, background/service-worker.ts);
 *   4. runs typecheck + production build + the full remaining unit suite;
 *   5. scans for stale references and reports them honestly;
 *   6. removes the worktree.
 *
 * Exit code 0 = removal-safe, 1 = regression found.
 *
 * Extending to future leaf modules: duplicate the CONSUMERS/excision table
 * below with that module's declared import sites and the minimal edits.
 *
 * Run: npm run test:removal
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const MODULE = "extension/src/shared/local-check.ts";
const MODULE_TEST = "tests/local-check.test.ts";

// The module's declared consumers and the minimal scoped excision per file.
// Keeping this table tiny and explicit is the point: if removal ever needs
// edits OUTSIDE these files, the module's independence has regressed and
// the probe must fail.
const CONSUMERS = [
  {
    file: "extension/src/content/suggestion-engine.ts",
    edits: [
      {
        from: 'import { localCheck, mergeIssues } from "../shared/local-check";\n',
        to: "",
      },
      {
        from: '{ ...cached, issues: mergeIssues(cached.issues, local), source: "ai" }',
        to: '{ ...cached, source: "ai" }',
      },
      {
        // Cache path no longer needs fresh local issues.
        from: [
          "    // The cache stores AI-ONLY issues; fresh local fast-check issues are",
          "    // merged in at hand-off time so dictionary/setting changes apply even",
          "    // when the model result is cached.",
          "    const cached = this.cache.get(hash);",
          "    if (cached) {",
          "      const [dictionary, ignoredWords] = await Promise.all([",
          "        getDictionary(),",
          "        getIgnoredWords(),",
          "      ]);",
          "      const local = this.buildLocalIssues(",
          "        text,",
          "        settings,",
          "        dictionary,",
          "        ignoredWords,",
          "        hash,",
          "        adapter.getEditorIdentity(),",
          "      );",
        ].join("\n"),
        to: [
          "    // The cache stores AI-ONLY issues.",
          "    const cached = this.cache.get(hash);",
          "    if (cached) {",
        ].join("\n"),
      },
      {
        from: "if (!settings.enableLocalChecks) return [];",
        to: "return []; // removal probe: local-check module removed",
      },
      {
        from: [
          "    const raw = localCheck(text, {",
          "      spelling: settings.checkSpelling,",
          "      grammar: settings.checkGrammar,",
          "      punctuation: settings.checkPunctuation,",
          "    });",
        ].join("\n"),
        to: "const raw: TaggedIssue[] = [];",
      },
      {
        from: "issues: mergeIssues(filtered, localIssues),",
        to: "issues: filtered,",
      },
    ],
  },
  {
    file: "extension/src/background/service-worker.ts",
    edits: [
      {
        from: 'import { localCheck, mergeIssues } from "../shared/local-check";\n',
        to: "",
      },
      {
        from: [
          "    const localIssues: Issue[] = settings.enableLocalChecks",
          "      ? localCheck(analyzed, {",
          "          spelling: settings.checkSpelling,",
          "          grammar: settings.checkGrammar,",
          "          punctuation: settings.checkPunctuation,",
          "        }).filter((i) => {",
          "          if (i.confidence < settings.minConfidence) return false;",
          "          const lower = i.original.trim().toLowerCase();",
          "          if (lower && dictionary.some((d) => d.toLowerCase() === lower)) return false;",
          "          if (lower && ignored.includes(lower)) return false;",
          "          return true;",
          "        })",
          "      : [];",
        ].join("\n"),
        to: "    const localIssues: Issue[] = []; // removal probe: local-check module removed",
      },
      {
        from: "issues: mergeIssues(issues, localIssues),",
        to: "issues: issues,",
      },
    ],
  },
];

// References that are EXPECTED to survive this probe (they belong to the
// settings module, not to the rule engine). Anything else counts as stale.
const EXPECTED_REMAINING = ["enableLocalChecks"];

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });
}

function editFile(absPath, edits) {
  let s = fs.readFileSync(absPath, "utf8");
  for (const e of edits) {
    if (!s.includes(e.from)) {
      throw new Error(`${path.relative(REPO, absPath)}: expected snippet not found:\n${e.from}`);
    }
    s = s.replace(e.from, e.to);
  }
  fs.writeFileSync(absPath, s);
}

function linkNodeModules(worktree) {
  // Reuse the main checkout's installed dependencies so the probe takes
  // seconds, not minutes. Falls back to a real install if absent.
  for (const rel of ["node_modules", "extension/node_modules"]) {
    const src = path.join(REPO, rel);
    const dst = path.join(worktree, rel);
    if (fs.existsSync(src)) fs.symlinkSync(src, dst);
  }
}

async function main() {
  const results = [];
  const step = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "lwa-removal-probe-"));
  let failed = false;
  try {
    run(`git worktree add --detach "${wt}" HEAD`, REPO);
    step("disposable worktree created", true, wt);

    // 1. Delete the module and its module-owned tests.
    fs.rmSync(path.join(wt, MODULE));
    fs.rmSync(path.join(wt, MODULE_TEST));
    step("module + module-owned tests deleted", true, `${MODULE}, ${MODULE_TEST}`);

    // 2. Excise references — declared consumers ONLY.
    for (const c of CONSUMERS) {
      editFile(path.join(wt, c.file), c.edits);
    }
    step("declared consumers excised", true, CONSUMERS.map((c) => c.file).join(", "));

    // 3. Prove the rest still builds, typechecks, and passes.
    linkNodeModules(wt);
    try {
      run("npm run typecheck", wt);
      step("typecheck (without module)", true);
    } catch (e) {
      step("typecheck (without module)", false, String(e.stderr || e.message).slice(0, 400));
      failed = true;
    }
    try {
      run("npm run build:extension", wt);
      step("production build (without module)", true);
    } catch (e) {
      step("production build (without module)", false, String(e.stderr || e.message).slice(0, 400));
      failed = true;
    }
    try {
      const out = run("npx vitest run 2>&1", wt);
      const m = out.match(/Tests\s+(\d+) passed/);
      step("remaining unit suite (without module)", true, m ? `${m[1]} tests passed` : "");
    } catch (e) {
      step("remaining unit suite (without module)", false, String(e.stderr || e.stdout || e.message).slice(0, 400));
      failed = true;
    }

    // 4. Honest stale-reference scan.
    let stale = [];
    try {
      const out = run(
        `rg -l "localCheck|mergeIssues|shared/local-check" extension/src`,
        wt,
      );
      stale = out.split("\n").filter(Boolean);
    } catch {
      // rg exits non-zero when there are no matches — that's the good case.
    }
    step(
      "stale-reference scan",
      stale.length === 0,
      stale.length ? `unexpected references in: ${stale.join(", ")}` : "no code references remain",
    );
    if (stale.length) failed = true;

    console.log(
      `\nNote: the enableLocalChecks setting (types/storage/Options UI) is owned by` +
        `\nthe settings module and is intentionally inert after this probe; a full` +
        `\nfeature removal would scope it separately.\n`,
    );
  } catch (e) {
    failed = true;
    console.error("PROBE ERROR:", String(e.stderr || e.stdout || e.message).slice(0, 800));
  } finally {
    try {
      run(`git worktree remove --force "${wt}"`, REPO);
      console.log(`worktree removed: ${wt}`);
    } catch {
      console.error(`WARNING: could not remove worktree ${wt} — remove manually`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nRemoval probe: ${passed}/${results.length} checks passed — ${failed ? "REGRESSION" : "module is removal-safe"}`);
  process.exit(failed ? 1 : 0);
}

main();
