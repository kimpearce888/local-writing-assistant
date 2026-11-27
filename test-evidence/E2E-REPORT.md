# Human-like End-to-End Test Report — Local Writing Assistant v1.10.1

**Date:** 2026-11-27 · **Driver:** `test-lab/` in this repository · **Evidence:** `test-evidence/`
**Result: 24/24 scenarios passed across 2 sessions — with 3 real product bugs found and fixed.**

## What "test it like a human" meant here

1. **Real installation.** The built extension (`extension/dist`, v1.10.1) was loaded into a
   real headful Chromium 159 (Playwright persistent context) — verified on `chrome://extensions`.
2. **Real AI.** The Go native-messaging host talked to an LM Studio-compatible shim
   (`127.0.0.1:1234`, `GET /v1/models` + `POST /v1/chat/completions`) backed by a **live LLM**
   via `z-ai-web-dev-sdk`. No `LOCAL_MOCK_AI` — every grammar check, rewrite, tone detection,
   and connection ping was a genuine model round-trip (unedited logs: `ai-call-log-A.txt`,
   `ai-call-log-B.txt`).
3. **Real input.** Chrome's native context menus do not respond to synthetic DOM events, so
   the driver sends **real X11 input** (python-xlib XTEST) against Xvfb: right-clicks, drag
   selection, Ctrl+A, and menu keyboard navigation. Browser-drawn menus were verified with
   full-screen captures and pixel-diff gating.
4. **Real user journeys.** Typing with per-keystroke events, hover, popup clicks, side-panel
   tab flows, options management, pause/resume, master toggle — plus the full
   *select → right-click → "Rewrite…" → side panel → "Improve it" → Replace onto the page*
   journey on a Gmail-like compose page.

## Results

### Session A — 14/14 (`RESULTS-A.md`, shots `A-*.png`)

| # | Scenario | Key proof |
|---|---|---|
| 01 | Installed & enabled on `chrome://extensions` | name visible, no errors |
| 02 | Popup "Connected" | native host → model list + AI ping |
| 03 | Popup "Test LM Studio Connection" | "Connection test passed." |
| 04 | Real-time check **while typing** | inline marker after keystrokes + real AI |
| 05 | Hover opens suggestion card | `[data-lwa-popup]` rendered |
| 06 | Popup **Replace** applies the AI fix | `"She don't like it."` → `"She doesn't like it."` |
| 07 | Offline fast-check (v1.10.0) | `teh` + `recieved` underlined by local rules, no AI |
| 08 | Floating widget docks to editor | `[data-lwa-widget]` with issue badge |
| 09 | Contenteditable (Gmail-like compose) | "don't" underlined word-perfect |
| 10 | Options: create snippet `sig` | list updated |
| 11 | **Native context menu** → "Save selection as snippet" | options pre-filled with the selection, snippet `addr` saved |
| 12 | Snippet expansion while typing | `;sig` → full signature |
| 13 | Settings persist (dialect=UK), Refresh models, diagnostics | model `glm-4.6` selected; diagnostics ran |
| 14 | Pause/Resume site | 0 markers paused → markers restored |

### Session B — 10/10 (`RESULTS-B.md`, shots `B-*.png`)

| # | Scenario | Key proof |
|---|---|---|
| 01 | Password / API-key fields never analyzed | values intact, 0 markers |
| 02 | Side panel Check tab "Check now" | 5 real AI issues listed |
| 03 | Insights: dashboard, stats, tone, synonyms | local stats + tone readings + synonym suggestions |
| 04 | "Improve it" (real AI) | `They're going to the store… We saw it happen…` |
| 05 | Custom instruction (real AI) | rewrite delivered |
| 06 | Write menu → "Create a TL;DR" | summary generated |
| 07 | Evaluate → "Pick out my main point" | analysis shown, **Replace disabled** |
| 08 | **FULL journey**: select-all → right-click → "Rewrite…" → side panel → "Improve it" → **Replace onto page** | panel preloaded via handshake (304 chars), real AI rewrite, `errorLine="Replaced."`, page text updated |
| 09 | Popup master toggle OFF/ON | 0 markers disabled → markers restored |
| 10 | AI call-log proof | 17 requests / 14 real responses / 3 cache-served duplicates |

## Real bugs found by the human-like run (fixed in v1.10.1, commit `722869c`)

1. **Drifted AI offsets dropped every highlight (checker).** The strict
   `analyzedText.slice(start,end) !== original` check silently discarded all issues from a
   real model (the canned mock's perfect offsets masked this). `reconcileIssue()` now
   re-locates the flagged substring near the claim — the security contract holds (an issue
   can only reference text that exists in the editor). +9 unit tests
   (`tests/issue-reconciliation.test.ts`).
2. **Cold side panel lost the selection.** Right-click → "Rewrite…" broadcast the selection
   the instant `chrome.sidePanel.open()` resolved — before the panel's modules loaded — so
   the first invocation silently showed an empty panel. The SW now stashes side-panel
   broadcasts (15 s TTL) and the panel pulls them via a `side-panel-ready` handshake on init.
3. **Broadcast clobbered the working box on mere focus.** The panel dropped fresh page
   selections whenever `#selectedText` held focus, even if the user hadn't typed for minutes.
   The guard now requires *active* typing (2 s window).

## Observations (follow-up candidates, not fixed here)

- In the **textarea** adapter, some overlay markers render at the container's bottom edge
  instead of under the word (contenteditable rendering is word-perfect; A-07 shows `teh`
  correct while the second marker lands on the bottom edge). Cosmetic — markers still
  appear, remain clickable, and Replace works. Worth a dedicated mirror-metrics fix.

## Test-harness notes (hard-won lessons, encoded in `test-lab/`)

- Chromium 159 groups extension context-menu items under a "Local Writing Assistant ▸"
  submenu whose position varies by host page — blind `Down`-counting activates browser items
  (a stray Enter even opened a Google search tab once). Type-ahead (`l` → parent, unique
  item letter → target) plus **leak probes** (compare page content before/after each
  keystroke) made the flow deterministic.
- The docked side panel is not exposed to Playwright as a page; the same panel UI opened as
  a tab exercises the identical code path including the cold-start handshake.
- Upstream 429 rate limiting required request pacing + adaptive backoff (with response
  caching for identical payloads); all retries stay inside the extension's 30 s request
  timeout.

## Reproduce

```bash
# 1. build
npm ci && (cd extension && npm ci && npm run build) && npm run build:native:linux
# 2. real-AI shim (LM Studio-compatible, port 1234)
bun run /path/to/mini-services/lmstudio-shim/index.ts
# 3. sessions (Xvfb :99, DISPLAY=:99)
node test-lab/session-a.cjs && node test-lab/session-b.cjs
```
