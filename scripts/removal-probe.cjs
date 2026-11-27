#!/usr/bin/env node
/**
 * GAADS §6 removal probe — executable enforcement of module removability.
 *
 * For each declared LEAF MODULE, proves that the module can be removed
 * without breaking unrelated functionality:
 *
 *   1. creates a DISPOSABLE git worktree at HEAD (the user's working tree
 *      is never touched);
 *   2. deletes the module and its module-owned test file;
 *   3. excises its references from the DECLARED consumers only — if
 *      removal ever needs edits OUTSIDE this table, the module's
 *      independence has regressed and the probe must fail;
 *   4. runs typecheck + production build + the full remaining unit suite;
 *   5. scans for stale references and reports them honestly;
 *   6. removes the worktree.
 *
 * Exit code 0 = every module removal-safe, 1 = regression found.
 *
 * Extending to future leaf modules: append an entry to the MODULES table
 * below with that module's declared import sites and the minimal edits.
 *
 * Run: npm run test:removal
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");

// Every module's declared consumers and the minimal scoped excision per
// file. Keeping these tables tiny and explicit is the point: a removal
// that needs edits outside them is an architecture regression.
const MODULES = [
  {
    key: "local-check",
    description: "offline fast-check rule engine (added v1.10.0)",
    module: "extension/src/shared/local-check.ts",
    test: "tests/local-check.test.ts",
    stalePattern: "localCheck|mergeIssues|shared/local-check",
    note:
      "the enableLocalChecks setting (types/storage/Options UI) is owned by " +
      "the settings module and is intentionally inert after this probe; a " +
      "full feature removal would scope it separately.",
    consumers: [
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
    ],
  },
  {
    key: "snippets",
    description: "text-expansion matcher (added v1.9.0) — consumed by shared/storage.ts (validation) + content/sidepanel (expansion)",
    module: "extension/src/shared/snippets.ts",
    test: "tests/snippets.test.ts",
    // NOTE: anchored on import sites, NOT on "shared/snippets" generally —
    // shared/local-check.ts carries a documentation comment that mentions
    // the snippets module and must NOT count as a stale reference.
    stalePattern: 'findSnippetMatch|from "../shared/snippets"',
    note:
      "the snippet storage + options-page manager (getSnippets, export/" +
      "import) is owned by the storage module and keeps working after this " +
      "probe; expansion simply never fires because the matcher is gone.",
    consumers: [
      {
        file: "extension/src/content/index.ts",
        edits: [
          {
            from: 'import { findSnippetMatch, Snippet } from "../shared/snippets";\n',
            to: "",
          },
          {
            from: "let snippetsCache: Snippet[] = [];",
            to: "const snippetsCache: readonly never[] = []; // removal probe: snippets module removed",
          },
          {
            from: [
              '  const prefix = settingsCache?.snippetTriggerPrefix ?? ";";',
              "  const match = findSnippetMatch(before, snippetsCache, prefix);",
            ].join("\n"),
            to: '  const match = null as { start: number; end: number; snippet: { content: string } } | null; // removal probe: snippets module removed',
          },
          {
            from: "  snippetsCache = await getSnippets().catch(() => []);",
            to: "  await getSnippets().catch(() => []); // removal probe: snippets cache disabled",
          },
          {
            from: [
              "      void getSnippets()",
              "        .then((list) => {",
              "          snippetsCache = list;",
              "        })",
              "        .catch(() => undefined);",
            ].join("\n"),
            to: [
              "      void getSnippets()",
              "        .then(() => {",
              "          // removal probe: snippets cache disabled",
              "        })",
              "        .catch(() => undefined);",
            ].join("\n"),
          },
        ],
      },
      {
        file: "extension/src/sidepanel/index.ts",
        edits: [
          {
            from: 'import { findSnippetMatch, Snippet } from "../shared/snippets";\n',
            to: "",
          },
          {
            from: "let snippetsCache: Snippet[] = [];",
            to: "const snippetsCache: readonly never[] = []; // removal probe: snippets module removed",
          },
          {
            from: '  const match = findSnippetMatch(before, snippetsCache, settings.snippetTriggerPrefix ?? ";");',
            to: '  const match = null as { start: number; end: number; snippet: { content: string } } | null; // removal probe: snippets module removed',
          },
          {
            from: [
              "  try {",
              "    snippetsCache = await getSnippets();",
              "  } catch {",
              "    snippetsCache = [];",
              "  }",
            ].join("\n"),
            to: [
              "  try {",
              "    await getSnippets(); // removal probe: snippets cache disabled",
              "  } catch {",
              "    /* nothing to cache */",
              "  }",
            ].join("\n"),
          },
          {
            from: [
              "        void getSnippets()",
              "          .then((list) => {",
              "            snippetsCache = list;",
              "          })",
              "          .catch(() => undefined);",
            ].join("\n"),
            to: [
              "        void getSnippets()",
              "          .then(() => {",
              "            // removal probe: snippets cache disabled",
              "          })",
              "          .catch(() => undefined);",
            ].join("\n"),
          },
        ],
      },
      {
        file: "extension/src/shared/storage.ts",
        edits: [
          {
            // The storage layer's snippet CRUD keeps its full surface with
            // inert local validation — unrelated settings/dictionary code
            // must compile unchanged.
            from: [
              "import {",
              "  SNIPPET_LIMITS,",
              "  Snippet,",
              "  makeSnippetId,",
              "  sanitizeSnippetInput,",
              '} from "./snippets";',
            ].join("\n"),
            to: [
              "// removal probe: snippets module removed — the storage layer keeps its",
              "// CRUD surface with inert local validation so unrelated settings/",
              "// dictionary code compiles unchanged.",
              "type Snippet = {",
              "  id: string;",
              "  shortcut: string;",
              "  content: string;",
              "  label: string;",
              "  createdAt: number;",
              "};",
              "const SNIPPET_LIMITS = {",
              "  maxCount: 100,",
              "  maxShortcutLen: 32,",
              "  maxContentLen: 5000,",
              "  maxLabelLen: 100,",
              "} as const;",
              "const makeSnippetId = (): string => `snip-${Date.now().toString(36)}`;",
              "const sanitizeSnippetInput = (",
              "  raw: { shortcut: unknown; content: unknown; label?: unknown },",
              "): Pick<Snippet, \"shortcut\" | \"content\" | \"label\"> | null => {",
              "  if (typeof raw.shortcut !== \"string\" || !raw.shortcut.trim()) return null;",
              "  if (typeof raw.content !== \"string\" || !raw.content.trim()) return null;",
              "  return {",
              "    shortcut: raw.shortcut.trim().toLowerCase(),",
              "    content: raw.content.slice(0, SNIPPET_LIMITS.maxContentLen),",
              "    label: typeof raw.label === \"string\" ? raw.label.slice(0, SNIPPET_LIMITS.maxLabelLen) : \"\",",
              "  };",
              "};",
            ].join("\n"),
          },
        ],
      },
    ],
  },
];

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

async function probeModule(mod, results) {
  const step = (name, ok, detail = "") => {
    results.push({ name: `${mod.key}: ${name}`, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${mod.key}: ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), `lwa-removal-probe-${mod.key}-`));
  let failed = false;
  try {
    run(`git worktree add --detach "${wt}" HEAD`, REPO);
    step("disposable worktree created", true, wt);

    // 1. Delete the module and its module-owned tests.
    fs.rmSync(path.join(wt, mod.module));
    fs.rmSync(path.join(wt, mod.test));
    step("module + module-owned tests deleted", true, `${mod.module}, ${mod.test}`);

    // 2. Excise references — declared consumers ONLY.
    for (const c of mod.consumers) {
      editFile(path.join(wt, c.file), c.edits);
    }
    step("declared consumers excised", true, mod.consumers.map((c) => c.file).join(", "));

    // 3. Prove the rest still builds, typechecks, and passes.
    linkNodeModules(wt);
    try {
      run("npm run typecheck", wt);
      step("typecheck (without module)", true);
    } catch (e) {
      step("typecheck (without module)", false, String(e.stderr || e.stdout || e.message).slice(0, 400));
      failed = true;
    }
    try {
      run("npm run build:extension", wt);
      step("production build (without module)", true);
    } catch (e) {
      step("production build (without module)", false, String(e.stderr || e.stdout || e.message).slice(0, 400));
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
      const out = run(`rg -l "${mod.stalePattern}" extension/src`, wt);
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

    console.log(`\nNote (${mod.key}): ${mod.note}\n`);
  } catch (e) {
    failed = true;
    console.error(`PROBE ERROR (${mod.key}):`, String(e.stderr || e.stdout || e.message).slice(0, 800));
  } finally {
    try {
      run(`git worktree remove --force "${wt}"`, REPO);
      console.log(`worktree removed: ${wt}`);
    } catch {
      console.error(`WARNING: could not remove worktree ${wt} — remove manually`);
    }
  }
  return failed;
}

async function main() {
  const results = [];
  let anyFailed = false;
  for (const mod of MODULES) {
    console.log(`\n=== Removal probe: ${mod.key} — ${mod.description} ===`);
    const failed = await probeModule(mod, results);
    anyFailed = anyFailed || failed;
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\nRemoval probe: ${passed}/${results.length} checks passed across ${MODULES.length} modules — ${anyFailed ? "REGRESSION" : "all modules are removal-safe"}`,
  );
  process.exit(anyFailed ? 1 : 0);
}

main();
