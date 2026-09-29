# Local Writing Assistant

[![CI](https://github.com/kimpearce888/local-writing-assistant/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/kimpearce888/local-writing-assistant/actions/workflows/ci.yml)
[![E2E](https://img.shields.io/badge/E2E-10%2F10%20passing-brightgreen.svg)](#testing)
[![Release](https://github.com/kimpearce888/local-writing-assistant/actions/workflows/release.yml/badge.svg)](https://github.com/kimpearce888/local-writing-assistant/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)](https://github.com/kimpearce888/local-writing-assistant/releases/tag/v1.2.0)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![No cloud](https://img.shields.io/badge/runtime-no%20cloud%20AI-1f6feb.svg)](PRIVACY.md)

A **fully local** AI writing assistant for Chrome on Windows, powered by [LM Studio](https://lmstudio.ai).

Your text never leaves your computer. There is no cloud AI, no telemetry, no analytics, no account, no login, no remote backend. The only AI engine is LM Studio running locally on the same PC.

This is **not** a Grammarly clone — it is an original local-first writing assistant with its own UI, prompts, and architecture.

> **Download the latest Windows package:** see the [Releases page](https://github.com/kimpearce888/local-writing-assistant/releases). **v1.2.0** (production-ready) is the current stable release — see [what changed](#whats-new-in-120).

---

## The story — why this project exists

Most "AI writing assistants" today are SaaS products. You type into a browser, your text goes to a remote server, an LLM processes it, and the suggestion comes back. That model has three problems:

1. **Privacy.** Your draft cover letter, your medical appointment note, your frustrated Slack message to HR — all of it leaves your machine. Most vendors promise they don't read it, but you have to trust them, and you have to trust their downstream model providers, and you have to trust their ops team not to leak logs. Breaches happen.
2. **Cost.** Either you pay a monthly subscription, or you pay with your data. There is no third option in the cloud-AI model.
3. **Offline.** Plane Wi-Fi, train tunnels, rural cafés — anywhere without solid internet, your "AI assistant" becomes a dead toolbar icon.

This project takes a different bet: **run the LLM on the user's own machine.** [LM Studio](https://lmstudio.ai) already makes that easy — it loads any Hugging Face model (Qwen, Llama, Mistral, etc.) and exposes an OpenAI-compatible local API on `http://127.0.0.1:1234`. What was missing was a *browser* surface that plugs into that local API and gives the user Grammarly-style inline suggestions and rewrite tools.

That's what this is. A Chrome extension that:

- watches the page for textareas, supported inputs, and contenteditable editors
- sends the *relevant text only* to the local LM Studio server (never to the cloud)
- renders inline grammar / spelling / clarity / word-choice suggestions with stale-result protection
- offers a side panel for "rewrite this selection" workflows (improve / shorter / clearer / professional / friendly / formal / simplify / custom)
- runs a per-site pause and per-site exclusion list, so the user is always in control

The architecture forces the privacy promise by construction: a custom Go HTTP transport in the native host refuses any non-loopback dial. Even if the URL were misconfigured to `https://example.com`, the dialer would refuse to connect. Defense in depth.

---

## How it was built — the architecture decision

The project is split into four layers, each with a clear responsibility:

```
WEB PAGE
   │  (content script extracts only relevant text)
   ▼
EXTENSION SERVICE WORKER  (chrome.runtime.connectNative)
   │
   ▼
CHROME NATIVE MESSAGING  (length-prefixed JSON over stdin/stdout)
   │
   ▼
LOCAL NATIVE HOST EXE  (Go, ~5 MB standalone)
   │  (custom HTTP transport refuses non-loopback dials)
   ▼
LM STUDIO  (http://127.0.0.1:1234 only)
   │
   ▼
LOCAL LLM
```

**Why four layers?** Because each layer enforces an independent security boundary, and a breach of one doesn't compromise the others:

1. **Content script** can't make any `fetch` / `XMLHttpRequest` calls (verified by `npm run audit:network` on every CI run). It only sees the editor's text and asks the service worker for help.
2. **Service worker** is the only context that can call `chrome.runtime.connectNative`. It validates and forwards messages to the native host.
3. **Native host (Go)** is the security boundary between Chrome and the network. It accepts only 6 known commands (`ping`, `get_config`, `get_models`, `check_connection`, `grammar_check`, `rewrite`). It exposes NO shell-exec, NO `os/exec`, NO eval capability. It sanitizes the LM Studio URL (rejects `0.0.0.0`, LAN IPs, public DNS names, non-http(s) schemes, userinfo in URLs). And as defense in depth, the HTTP transport's custom `DialContext` refuses any destination that isn't `127.0.0.1`, `localhost`, or `::1` — so even a sanitizer bypass can't escape.
4. **LM Studio** is the only runtime network destination. The user controls which model is loaded; the user controls whether the server is running; the user can kill the server at any time and the assistant goes silent.

**Why a native host at all?** Because Chrome MV3 content scripts and service workers can't make HTTP calls to arbitrary localhost ports without explicit `host_permissions` (which would weaken the CSP). Going through a native host also lets us enforce the loopback-only transport at a layer the extension JavaScript can't touch.

**Why Go for the native host?** Three reasons: (1) single-file standalone EXE — no Node.js, Python, or JVM runtime required on the user's machine; (2) excellent stdin/stdout/JSON/stdlib support for the Chrome Native Messaging wire protocol; (3) easy cross-compilation (the Linux dev box produces a Windows EXE via `GOOS=windows GOARCH=amd64`).

---

## What it does

* Grammar checking
* Spelling suggestions (with custom dictionary)
* Punctuation
* Clarity / conciseness
* Tone transformation (Professional, Friendly, Formal, Casual, Concise, Confident, Neutral)
* Rewrite operations: Improve / Shorter / Clearer / Professional / Friendly / Formal / Simplify / Custom
* Inline suggestions with stale-result protection
* Side panel for rewrite workflows
* Custom dictionary, site exclusions, ignore rules
* Diagnostics tool
* Polished options page with import/export settings
* Light/dark mode

---

## Requirements

* Windows 11 64-bit (also works on Windows 10)
* Google Chrome (recent version; MV3 is required)
* LM Studio with at least one local model loaded and the local server started
* No Node.js, Python, Go, Rust, Java, or any other runtime needed on the user's machine — the native host is a single standalone EXE

---

## Installation

### 1. Extract the ZIP

Extract `Local-Writing-Assistant-Windows.zip` anywhere on your PC.

### 2. Run the installer

Double-click `Install.bat` inside the extracted folder.

The installer will:

* Detect Windows architecture
* Detect Chrome
* Install the native host EXE
* Generate the native messaging host manifest with the real installed path
* Register the native messaging host in `HKCU`
* Copy the extension files into `%LOCALAPPDATA%\LocalWritingAssistant\extension`
* Generate `update.xml` for enterprise installation (Mode A)
* Attempt Mode A (enterprise force-install) where Chrome permits it
* Verify LM Studio reachability

### 3. The Chrome installation step (Mode A vs Mode B)

The installer is honest about which mode it applied:

#### Mode A — Managed / enterprise Chrome

If Chrome accepts enterprise policy in the current user context (this is typical for company-managed Chrome, or for any user who can write to `HKCU\Software\Policies\Google\Chrome`), the installer:

* Reads the existing `ExtensionInstallForcelist` (preserving any other extensions your org has force-installed)
* Appends our entry only if it isn't already present
* Points the update URL at `https://kimpearce888.github.io/local-writing-assistant/update.xml` (HTTPS — Chrome refuses `file://` and non-localhost `http://` for update servers)
* Chrome then silently installs the extension on next launch — no Developer Mode, no "Load unpacked", no drag-and-drop CRX

#### Mode B — Normal unmanaged personal Chrome

Chrome refuses to silently install a self-hosted off-store extension. **We do not pretend otherwise.** The installer:

* Installs every local component (native host, manifest, registry entry, extension files)
* Prints a clear diagnostic explaining what Chrome allows and does not allow
* Asks for a one-time manual step:

  1. Open `chrome://extensions`
  2. Toggle **Developer mode** ON (top-right)
  3. Click **Load unpacked**
  4. Select `%LOCALAPPDATA%\LocalWritingAssistant\extension`

This step is needed exactly once. After it, the extension will load automatically on every Chrome launch, and updates to the extension files in that folder will be picked up on Chrome restart.

### 4. Set up LM Studio

1. Open LM Studio
2. Load any chat-capable model (e.g. a Qwen, Llama, or Mistral instruct model)
3. Start the local server (default port `1234`)
4. Open Chrome's popup → click **Test LM Studio Connection**

If the test passes, you're done. If it fails, the diagnostic message tells you exactly what's wrong (LM Studio offline / no model loaded / etc.).

### 5. Start writing

Open any webpage with a `<textarea>`, `<input>` (text/email/search/url/tel), or `contenteditable="true"` editor. Start typing. After a short debounce (~700 ms), inline suggestions will appear.

Click a suggestion to see the popup with **Replace / Ignore / Add to dictionary** (for spelling) options.

Open the side panel (Alt+Shift+O or the extension's side-panel button) for rewrite operations on the current selection.

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+Shift+L` | Check writing in the focused editor |
| `Alt+Shift+R` | Open the rewrite side panel for the current selection |
| `Alt+Shift+O` | Open the Local Writing Assistant popup |

These can be remapped in `chrome://extensions/shortcuts`.

---

## Context menu

Select text on any page, right-click, and choose:

* **Improve writing**
* **Make shorter**
* **Make professional**
* **Rewrite…**

These send **only** the selected text to LM Studio via the local native host.

---

## Privacy

See [`PRIVACY.md`](PRIVACY.md) for the full statement. In short:

* The user's writing is processed locally only.
* Settings, custom dictionary, site exclusions, and ignored-suggestion memory live in `chrome.storage.local` only.
* `chrome.storage.sync` is **never** used.
* No telemetry. No analytics. No remote endpoints.
* The only runtime network destination is `http://127.0.0.1:1234` (the local LM Studio server).

---

## Security

See [`SECURITY.md`](SECURITY.md) for the full model. Highlights:

* The native host is a security boundary.
* Only known commands are accepted (`ping`, `get_config`, `get_models`, `check_connection`, `grammar_check`, `rewrite`).
* The native host dials `127.0.0.1` / `localhost` only — enforced by a custom `http.Transport` dialer.
* The native host exposes **no** command that runs shell, PowerShell, cmd, bash, or eval.
* AI output is treated as completely untrusted — strict JSON parsing, offset validation, HTML escaping on every insertion.

---

## What's new in 1.2.0

This is a **production-readiness release**. A from-scratch neutral audit was performed across the entire codebase (extension TypeScript, native host Go, Windows installer PowerShell, CI/CD, docs) — independent of the project's own test suite — and every BLOCKER and HIGH severity issue uncovered was fixed.

### Numbers

* **60 tests passing** (37 Vitest unit + 4 Go unit + 9 Go integration + 10 Playwright E2E — 3 of which are new manual-flow tests covering the previously-untested fixes)
* All 9 pending dependabot branches merged (GitHub Actions, root npm, extension npm)
* Static network + security audits: clean
* TypeScript typecheck: clean
* Windows EXE cross-compile: PE32+ verified

### Highlights of what was fixed

A few that users will actually notice:

* **The side-panel Replace button used to always say "No editor is bound to this rewrite"** — even after a normal Alt+Shift+R flow. The content script wasn't forwarding the selection offsets or text hash to the side panel. Fixed.
* **The pause-site button did nothing.** Pause state was stored in an in-memory `Set` that lived separately in the service worker's bundle and the content script's bundle — they never agreed. Now in `chrome.storage.local` so both contexts see the same state.
* **Inline suggestion markers drifted when the page was scrolled.** The overlay used `position:absolute` anchored at the document origin, so on any scrolled page (Gmail, Slack, Notion) markers were `scrollY` pixels off. Now `position:fixed` with a scroll listener that re-syncs on every scroll/resize.
* **Multi-paragraph contenteditable editors got wrong suggestions silently.** `getText()` returned `innerText` (which collapses whitespace) but offset bookkeeping walked `Text` nodes by `node.data.length` (which doesn't collapse). For multi-block editors (Gmail compose, Outlook web, Slack message input), the LLM's offsets didn't map to the right range. Now both paths walk `Text` nodes identically.
* **After ~10 analyses, a single click on a marker would fire the click handler 10×.** The `layer.onClick()` returned an unsubscribe that nobody captured — so every re-analysis stacked another listener. Now we capture it and remove the previous one before attaching a new one.
* **The installer used to wipe the user's existing `ExtensionInstallForcelist` entries.** `New-ItemProperty -Force` deletes and recreates the property with only the new value — destroying every other force-install entry (corporate SSO, password managers, etc.). The docstring promised otherwise; the code did the opposite. Now we read the existing array, append ours only if it isn't already present, and write the full array back with `Set-ItemProperty` (which preserves the property's ACLs and metadata).
* **The three `.bat` launchers always exited 0** even when `install.ps1` / `uninstall.ps1` / `diagnose.ps1` failed. `%ERRORLEVEL%` inside an `if` block is expanded at parse time (before `pwsh` runs), so `exit /b %ERRORLEVEL%` always returned the value from before `pwsh` ran. Fixed with `setlocal enabledelayedexpansion` + `!ERRORLEVEL!`.
* **The Windows ZIP release didn't ship `LICENSE`** — MIT-non-compliant. Now it does.

Full details in [`CHANGELOG.md`](CHANGELOG.md).

---

## Development

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for build instructions, project structure, and how to run the test suite.

Quick start for contributors:

```bash
# Install Go 1.23+ and Node 20+.
# Clone, then:
npm install                          # root deps (vitest, jsdom, playwright)
cd extension && npm install          # extension deps (typescript, vite, vitest)
npm run build:extension              # two-pass Vite build (SW + IIFE content.js)
npm run build:native                 # Go cross-compile to Windows EXE
npm run test:native                  # Go unit tests
npm run test:integration             # Go integration tests (wire protocol)
npx vitest run                       # Vitest unit tests
npm run test:e2e                     # Playwright E2E (requires xvfb on Linux)
npm run audit:network                # verify no fetch/XHR/WebSocket in runtime
npm run audit:security               # verify no eval / exec / shell patterns
```

---

## Troubleshooting

Run `Diagnose.bat` from the extracted folder. It prints a PASS / WARN / FAIL report covering:

* Chrome installation
* Native host EXE presence
* Native messaging registry entry
* Chrome enterprise policy
* Extension folder
* LM Studio reachability
* Available models

If any FAIL appears, run `Install.bat` again — it is idempotent and will repair the installation.

---

## Testing

The project has four test suites, all running on every push/PR via GitHub Actions:

| Suite | What it covers | Count |
|-------|----------------|-------|
| Vitest unit tests | AI output parser, text utilities, stale-result protection, sensitive-field detection, prompt builders | 37 |
| Go unit tests | Native-messaging protocol, security URL/command allowlists, payload clamps | 4 |
| Go integration tests | Full wire-protocol round-trip against the built host binary, including mock-AI mode | 9 |
| Playwright E2E tests | Real Chrome with the extension loaded + mock AI — popup status, textarea detection, contenteditable detection, suggestion popup, Replace button, password-field skipping, prompt-injection safety, ignore button, **scroll repositioning**, **side-panel rewrite→Replace flow**, **pause-site** | 10 |

Run them locally:

```bash
npm run test:native        # Go unit tests
npm run test:integration   # Go integration tests (wire protocol)
npx vitest run            # Vitest unit tests
npm run test:e2e           # Playwright E2E (requires xvfb on Linux)
```

The E2E suite uses `LOCAL_MOCK_AI=true` (spec §56) so it runs without a real LM Studio — the native host returns deterministic canned responses that match the input text. This makes the tests fully reproducible in CI.

---

## Contributing

Pull requests are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first — every change must keep the assistant fully local (no cloud, no telemetry, no remote backend). See [`CHANGELOG.md`](CHANGELOG.md) for version history.

To report a security vulnerability, please follow the [security policy](https://github.com/kimpearce888/local-writing-assistant/security/policy) — do **not** open a public issue.

---

## License

This project is released under the MIT License. See [`LICENSE`](LICENSE) for details.
