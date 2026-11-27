# HANDOVER — Local Writing Assistant (full state as of 2026-11-27)

> Read this first. It captures everything discovered, fixed, verified, and left open
> in the audit/fix session for `https://github.com/kimpearce888/local-writing-assistant`.

## 0. One-paragraph summary

The repo is a **Chrome MV3 extension + Go native-messaging host** that sends selected
text to a local LM Studio (or Ollama) endpoint for rewrite/continue/explain/summarize.
The original code was mostly *offered but never built or broken*: every feature had at
least one real bug. All of them were found by end-to-end human-style testing, fixed,
unit-tested, and verified in a real browser. Current state (v1.10.1):

- feature-complete writing surface (inline checks, side panel with
  Check/Insights/Rewrite/Write/Evaluate tabs, snippets with export/import,
  offline fast-check rule engine, pause/resume, sensitive-field protection);
- **24/24 human-like E2E scenarios PASSED against a REAL LLM** (real Chromium,
  real X11 input for native context menus, real native-messaging host,
  LM Studio-compatible shim backed by a live model) — harness in `test-lab/`,
  screenshots + AI call logs in `test-evidence/`, report in
  `test-evidence/E2E-REPORT.md`;
- GAADS-audited twice (v1.8/v1.9 additions, then v1.10.x additions) with a
  new executable removability probe (`npm run test:removal`, 7/7 PASS);
- 208 unit tests green, CI enforces typecheck/tests/audits/e2e on every push.

The tree is clean, and the work is committed and pushed to GitHub (`main`).

## 1. Where things are

| What | Path |
|---|---|
| Repo checkout | `local-writing-assistant/` (working dir; also `/tmp/local-writing-assistant` early on — **use the working-dir copy**, it's the committed one) |
| Extension source | `extension/src/` → built to `extension/dist/` (`npm run build`, esbuild) |
| Native host source | `native-host/` (Go 1.23 toolchain line, modules) |
| Host binary after build | `native-host/local-writing-assistant-host` (built with `cd native-host && go build -o local-writing-assistant-host ./cmd/localwritingassistanthost`) |
| Mock LM Studio for testing | `native-host/internal/mock/` — run: `go test -run TestMock -v` style or the `mock` package's server; listens on 127.0.0.1 (port configurable) and speaks `/v1/chat/completions`, `/v1/models` |
| E2E test scripts | `tests/` (Playwright E2E) + Go integration tests in `tests/` (own module) |
| Test fixtures | `extension/src/__tests__/` (jsdom, run via node) |

Environment facts that matter:
- Go: `/usr/local/bin/go` (go1.27.4). Node v26.13.1.
- Chrome profile used for live tests: `/tmp/chrome-e2e-profile` with `--user-data-dir`, CDP on a local port, extension loaded unpacked from `extension/dist`.
- The host binary is registered in Chrome via the native-messaging manifest at
  `~/.config/google-chrome/NativeMessagingHosts/com.localwritingassistant.host.json`
  (path inside points at the built binary; **rebuild + no restart needed**, Chrome re-execs per message).

## 2. What was broken → what was fixed (the audit trail)

All items below were real, reproduced bugs in the shipped code, not theoretical.

### Extension (`extension/src/`)
1. **Right-click menu never sent the selection.** Clicking "Rewrite" etc. from the
   context menu opened the sidebar but with an *empty* Selected text — you had to
   re-select while the panel was open. Root cause: the context-menu click handler
   created/used a port that hadn't yet received the selection payload from the
   content script (race). Fix: selection is now pushed through the side-panel
   storage channel **before** the panel opens, and the panel re-reads on `onMessage`
   + `storage.onChanged`; verified in real Chrome via CDP (right-click → Rewrite →
   text present).
2. **Selection lost for `<textarea>`/contenteditable.** `window.getSelection()` is
   empty inside inputs. Fix: detect active element; if textarea/input read
   `.selectionStart/.selectionEnd` on the value, if contenteditable use the range.
   (Commit 484a2ed.)
3. **AI key-name aliases + plain-text fallback.** LLMs return keys like `rewritten`,
   `text`, `output`, or bare strings instead of the expected JSON shape. The host now
   accepts aliases and falls back to raw text when JSON parse fails. (Commit 580905c.)
4. Various dead code / orphan files removed; every exported function is now either
   used or covered by a test.

### Native host (`native-host/`)
7. **Security hardening in `internal/security/security.go`:** URL must be http(s),
   no userinfo (`@` rejected pre-parse), host allow-list = localhost/127.0.0.1/**any
   loopback literal** (IPv4 127.x.y.z and IPv6 via `ip.IsLoopback()`), query/fragment
   stripped, length cap, and **`net.JoinHostPort`** so IPv6 base URLs like
   `http://[::1]:1234` don't break every later `http.NewRequest`.
8. **Protocol framing bugs** in `internal/protocol/` (message-length prefix handling)
   fixed; host no longer hangs on malformed frames.
9. **LM Studio client** (`internal/lmstudio/client.go`): timeouts, request/response
   mode verified against the mock.
10. **Logging** (`internal/logging/`) writes structured lifecycle logs to stderr.

### Build / packaging
11. `npm run build` output must be rebuilt after every source change; **`dist/` is
    gitignored, not committed** — run `npm run build:extension` before loading the
    unpacked extension from `extension/dist`.

## 3. How to verify (the exact commands)

```bash
cd local-writing-assistant

# Go: unit tests + build
cd native-host && go vet ./... && go test ./... && \
  go build -o local-writing-assistant-host ./cmd/localwritingassistanthost

# Extension: build + jsdom fixture tests
cd ../extension && npm run build && node src/__tests__/run.js   # (see package.json scripts)

# Mock LM Studio, then a full round-trip through the host binary:
# start mock on 127.0.0.1:<port>, point host config at it, send a framed request,
# expect framed response with model output.
```

Live browser check (what was done in this session):
1. `google-chrome --user-data-dir=/tmp/chrome-e2e-profile --remote-debugging-port=9333`
   (or the CDP port used), load `extension/dist` unpacked.
2. Open any page, select text, right-click → **Local Writing Assistant → Rewrite**.
3. Sidebar opens **with the selection already in it**; click Run; result
   appears; Stop discards stale results; textarea selections work.

## 4. Current git state

- Branch `main`, working tree **clean** (0 modified files).
- Latest commits: the v1.10.1 production-release commit, on top of
  `b509235` (executable removability probe, 7/7), `161fe4e` (24/24
  human-like E2E evidence run), `722869c` (v1.10.1 real-model fixes
  found BY that run), `50e3342` (v1.10.0 offline fast-check).
- Tag `v1.10.1` created at the release commit.
- Pushed: `origin/main` through `b0a2eff` and tag `v1.10.1` (credentials
  were restored in the sandbox before this session ended).
- Verification commands: see `CHANGELOG.md` section `[1.10.1]` and
  `test-evidence/E2E-REPORT.md`; the E2E harness itself lives in `test-lab/`
  (single-call foreground design — it needs Xvfb + the AI shim alive in the
  same shell invocation; see test-lab/session-*.cjs headers).

## 5. Known open items / decisions left for the next session

- ~~Store-listing assets not drafted~~ — RESOLVED: listing text in
  `docs/STORE-LISTING.md`; 4 × 1280×800 screenshots in
  `test-evidence/store/` (provenance in the CHANGELOG Unreleased
  section). Promo tiles (440×280 / 1400×560) are still not produced.
- ~~Removal probe covers only `shared/local-check.ts`~~ — RESOLVED: the
  table-driven probe now covers `local-check` + `snippets` (14/14;
  future leaf modules: append to `MODULES` in `scripts/removal-probe.cjs`).
- ~~Ollama backend untested~~ — RESOLVED at wire level
  (`ollama_compat_test.go` passes against an Ollama-shaped endpoint);
  exercising a LIVE Ollama install stays a deployment-time check.
- **Windows/Linux host install scripts** exist but were only exercised on this Linux box.
- **CRX3 packager** — verified end-to-end (`npm run verify:crx`, 8/8)
  with a throwaway key; real distribution needs the developer's own key
  (`.keys/extension.pem`, gitignored) and `scripts/embed-public-key.sh`.
- The AI shim (`/v1/chat/completions` over z-ai-web-dev-sdk) is test-only; don't ship it as a feature.
- The upstream LLM API can 429 under burst — the shim retries 3× then
  fails honestly; heavy AI-heavy runs (store shots) may need a cooldown.

## 6. Ground rules used in this session (keep them)

1. Find issues by *using* the product like a human, not just reading code.
2. Every fix ships with a regression test (Go `*_test.go` or jsdom fixture).
3. Rebuild **both** artifacts after every source change; verify through the real browser when UI is involved.
4. Commit per logical fix with a message that says what was broken and what proves the fix.
5. Never ask the user for decisions that have an obvious best answer — pick it, document it here if non-trivial.
