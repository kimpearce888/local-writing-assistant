# Changelog

All notable changes to Local Writing Assistant are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_No unreleased changes yet._

## [1.1.0] — 2026-09-27

### Added

- **Real extension signing** (spec §50, §81). Generated an RSA 2048-bit keypair (`scripts/generate-keypair.sh`), embedded the public key in `extension/public/manifest.json` under the `"key"` field, and computed the resulting stable Chrome extension ID (`lclfegmpnhibpkijgmlpjaoemnjpabcp`). The private key lives in `.keys/extension.pem` (gitignored) and is never shipped in the installer package.

- **CRX3 packager** (`scripts/build-crx.cjs`). Produces a signed `extension.crx` from `extension/dist` + `.keys/extension.pem`. The CRX3 format is hand-encoded (no protobuf dependency) — magic + version + length-prefixed CrxFileHeader + ZIP. Verified with `file(1)` as "Google Chrome extension, version 3".

- **Mock AI mode** (spec §56). Set `LOCAL_MOCK_AI=true` when launching the native host to get deterministic, in-process canned responses instead of contacting LM Studio. Used by the E2E tests so they run in CI without a real local model. Three new Go integration tests cover mock-mode grammar_check, check_connection, and get_models.

- **Playwright E2E browser tests** (spec §58, §60, §61). Seven tests that load the real Chrome extension into a real Chromium via `chromium.launchPersistentContext`, register the native host into the user-data-dir's `NativeMessagingHosts/` folder, set `LOCAL_MOCK_AI=true`, and exercise:
  - Popup status shows "Connected" when mock AI is on
  - Textarea is detected and the mock issue ("don't" → "doesn't") appears as a marker
  - Contenteditable is detected and the same issue appears
  - Replace button applies the suggestion (textarea value becomes "She doesn't like it.")
  - Password field is never analyzed
  - Prompt-injection text in the editor cannot trigger shell exec
  - Ignore button removes the suggestion without modifying text

- **Polished icons** (`scripts/generate-icons.cjs`). Replaced the hand-rolled pixel-loop PNGs with an SVG design (rounded gradient square with a stylized "L" + quill/caret detail) rendered to 16/32/48/128 PNGs via Playwright's Chromium. The SVG source is also committed at `extension/public/icons/icon.svg` for future re-rendering.

- **Inno Setup script** (`installer/LocalWritingAssistant.iss`). A polished Windows installer script that wraps the existing `install.ps1`. Adds the extension to Add/Remove Programs, provides a graphical wizard, supports `/SILENT` for unattended install, and integrates with Windows Settings' uninstall flow. Optional — the bare `Install.bat` / `install.ps1` installer still works without Inno Setup.

- **GitHub Pages workflow** (`.github/workflows/pages.yml`). Publishes the signed CRX3 + `update.xml` to GitHub Pages so Mode A enterprises can configure `ExtensionInstallForcelist` to point at `https://kimpearce888.github.io/local-writing-assistant/update.xml`. Requires the maintainer to add the `CRX_SIGNING_KEY` repository secret (base64-encoded PEM).

- **CI now runs Playwright E2E**. The CI workflow gained a new `e2e` job that installs Playwright Chromium + xvfb, builds the extension (two-pass: SW + IIFE content.js), builds the native host for Linux, and runs `xvfb-run npx playwright test`. Traces are uploaded as artifacts on failure.

- **Release workflow builds signed CRX**. When the `CRX_SIGNING_KEY` secret is configured, `release.yml` now also produces a signed `Local-Writing-Assistant-Windows.crx` and attaches it to the GitHub Release alongside the ZIP. The SHA-256 of the CRX is also uploaded for build provenance.

- **Two-pass Vite build**. Content script is now built as an IIFE (`vite build --mode content`) instead of an ES module — Chrome MV3 content scripts cannot use ES module imports. The service worker is still built as a module (manifest declares `type: "module"`). This was caught by the E2E tests (the original module-based content.js failed to load with "Cannot use import statement outside a module").

- **Native-bridge relay through service worker**. Content scripts cannot call `chrome.runtime.connectNative` directly — only the service worker can. The content script's suggestion engine now sends a `runtime.sendMessage({type:"native-bridge-call", ...})` to the SW, which calls `sendNative()` and returns the host response. This fixes the architectural bug that was blocking the E2E tests.

- **Stale-result hash consistency fix**. The content script's `onIssueMarkerClick` and `handleReplace` functions were computing the hash differently from the suggestion engine — `hashText(getText())` vs. `hashText(normalizeText(text) + "|" + tone + "|" + model)`. This caused every popup to falsely show as "stale". Now both paths use the same hash function.

- **Installer uses real extension ID**. The `Get-StableExtensionId` function in `install.ps1` previously derived a fake ID from a fixed seed string. It now uses the real RSA-derived ID `lclfegmpnhibpkijgmlpjaoemnjpabcp`, hardcoded as a constant. Mode A force-install entries now reference the ID Chrome will actually recognize.

- **New scripts**: `scripts/generate-keypair.sh`, `scripts/embed-public-key.sh`, `scripts/build-crx.cjs`, `scripts/generate-icons.cjs` (rewritten). All shell scripts are executable and documented in `DEVELOPMENT.md`.

- **New root npm scripts**: `npm run build:crx`, `npm run test:e2e`, `npm run icons`.

### Changed

- `.gitignore` now also ignores `test-results/`, `playwright-report/`, `dist-pages/` (Playwright + Pages build artifacts).
- `extension/package.json` `build` script now runs `vite build && vite build --mode content` (two passes).
- The service worker now also handles a `native-bridge-call` message type that proxies native-messaging calls from content scripts.
- The native host's `handleRequest` now branches on `mock.Enabled()` for `get_models`, `check_connection`, `grammar_check`, and `rewrite` — mock responses include a `"mock": true` field so the extension can detect mock mode in diagnostics.

### Fixed

- Content script bundle was an ES module but Chrome MV3 requires it to be a classic script. Fixed by adding a second Vite build pass with `lib: { formats: ["iife"] }`.
- Content script called `chrome.runtime.connectNative` which doesn't exist in content-script context. Fixed by routing native calls through `chrome.runtime.sendMessage` to the service worker.
- Stale-result hash mismatch (see "Stale-result hash consistency fix" above).

## [1.0.0] — 2026-09-26

### Added

- **Chrome extension** (Manifest V3, TypeScript + Vite)
  - Content script with editor adapters for `<textarea>`, `<input>` (text/email/search/url/tel), and `contenteditable` elements
  - Suggestion engine with stale-result protection (text-hash verification before any replacement), debouncing (default 700 ms), request cancellation via `AbortController`, per-editor state isolation, and an in-memory cache keyed on `text + tone + model`
  - Inline highlight layer scoped with `[data-lwa-*]` attributes so it cannot break host page CSS
  - Suggestion popup with viewport / fixed-header collision detection, keyboard support (Escape to close, focusable buttons), and Replace / Ignore / Add-to-dictionary / Ignore-word actions
  - Popup, side panel, and options page with light / dark mode (respects `prefers-color-scheme`)
  - Custom dictionary (add / remove / import / export / clear)
  - Per-site exclusions (enable / disable / pause-until-reload)
  - Ignored-suggestion memory (capped at 200 entries)
  - Settings backup (export / import / reset)
  - Diagnostics tool with PASS / WARN / FAIL report covering Chrome, native host, registry, policy, extension folder, LM Studio reachability, and model availability
  - Keyboard shortcuts: `Alt+Shift+L` (check writing), `Alt+Shift+R` (rewrite selection), `Alt+Shift+O` (open popup)
  - Context menu: Improve writing / Make shorter / Make professional / Rewrite…
  - Sensitive-field detection (passwords, hidden inputs, API-key-like names, credit-card autocomplete attributes) — never analyzed
  - Unsupported-editor detection (Google Docs canvas, Monaco, CodeMirror) — never touched
  - Strict AI output validation: JSON schema + offset/length verification against the analyzed text + category allowlist + confidence bounds + per-response issue cap + HTML escaping on every DOM insertion
  - Per-editor `EditorAdapter` interface (TextareaAdapter, TextInputAdapter, ContentEditableAdapter) for future extensibility
  - `_locales/en/messages.json` i18n catalog (English only at this release)

- **Native messaging host** (Go, ~5.4 MB standalone Windows EXE)
  - Chrome Native Messaging wire protocol (length-prefixed JSON over stdin/stdout)
  - 6 commands: `ping`, `get_config`, `get_models`, `check_connection`, `grammar_check`, `rewrite`
  - Loopback-only HTTP transport — a custom `http.Transport.DialContext` refuses any destination that is not `127.0.0.1`, `localhost`, or `::1`. Defense in depth: even if URL sanitization were bypassed, the dialer would still refuse non-local connections.
  - URL sanitization layer (`security.SanitizeLMStudioURL`) rejects `0.0.0.0`, LAN IPs, public DNS names, non-http(s) schemes, and userinfo in URLs
  - Command allowlist (`security.IsAllowedCommand`) — only the 6 known commands are accepted; everything else returns `UNKNOWN_COMMAND`
  - Payload size clamps on every request type (analyze text 8 KB, rewrite text 8 KB, system prompt 8 KB, total envelope 1 MiB)
  - No shell-exec, no `os/exec`, no `eval` capability. By design, the host cannot be turned into a general-purpose command runner by any extension message.
  - Local-only stderr logging (lifecycle events only — no user writing in ordinary logs)

- **Windows installer** (PowerShell, launched via `Install.bat` / `Uninstall.bat` / `Diagnose.bat`)
  - **Mode A** — enterprise force-install via `ExtensionInstallForcelist` + local `update.xml` (when Chrome accepts policy in the user's `HKCU` context)
  - **Mode B** — honest fallback for unmanaged personal Chrome: native host and all settings installed automatically, with a clearly reported one-time `Load unpacked` step in `chrome://extensions`
  - Idempotent: re-running `Install.bat` repairs the existing installation without creating duplicate registry keys or duplicate hosts
  - Never overwrites unrelated Chrome policies — the installer inspects `ExtensionInstallForcelist` first and only adds its own entry; the uninstaller removes only entries that match this application's host name pattern
  - Optional LM Studio bearer token (sent only to `127.0.0.1:1234`, never logged)

- **Tests** (47 total, all passing)
  - Go unit tests (4): protocol round-trip, oversized-message rejection, malformed-JSON rejection, security URL/command allowlist + payload clamps
  - Go integration tests (6): full wire-protocol round-trip against the host binary, covering ping, unknown-command rejection, get_config, check_connection when LM Studio is offline, grammar_check empty-text rejection, grammar_check no-model rejection
  - Vitest unit tests (37): AI parser strictness (malformed JSON, mismatched offsets, invalid categories, out-of-range confidence, code-fence stripping, 20-issue cap), text utilities, stale-result protection, sensitive-field detection, unsupported-editor detection, prompt builders

- **Static audits** (both pass)
  - `npm run audit:network` — scans every runtime source file for `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `axios`, and any non-loopback URL
  - `npm run audit:security` — scans every runtime source file for `eval`, `new Function`, `dangerouslySetInnerHTML`, `document.write`, Go `exec.Command` / `os/exec`, and known cloud API key names

- **Documentation**
  - `README.md` — overview, quick start, installation modes, troubleshooting
  - `PRIVACY.md` — full privacy notice (where text goes, where settings are stored, telemetry, network endpoints)
  - `SECURITY.md` — full security model (trust model, native host boundary, network restrictions, payload limits, input validation, CSP, offline operation, prompt-injection resistance, installer safety, secret handling)
  - `DEVELOPMENT.md` — repository layout, build commands, local debugging, extension signing, how to extend
  - `CONTRIBUTING.md` — dev environment setup, code review criteria, how to add adapters / commands / tone modes
  - `.github/SECURITY.md` — vulnerability reporting policy
  - `.github/ISSUE_TEMPLATE/` — bug report and feature request templates
  - `.github/PULL_REQUEST_TEMPLATE.md` — PR checklist including the privacy / security guardrails
  - `.github/CODEOWNERS` — code ownership rules
  - `.github/dependabot.yml` — weekly dependency updates for npm (root + extension), Go modules, and GitHub Actions

- **CI/CD**
  - `.github/workflows/ci.yml` — runs on every push/PR to main: TypeScript type-check, network audit, security audit, Vitest tests, Go unit tests, Go integration tests, Windows cross-compile verification, manifest.json validity, dist contents check, artifact upload
  - `.github/workflows/release.yml` — runs on tag push (`v*.*.*`): cross-compiles the Windows EXE, builds the extension, packages the ZIP, creates a GitHub Release with the ZIP attached, prints the SHA-256

### Architecture

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
LOCAL NATIVE HOST EXE  (Go, 5.4 MB standalone)
   │  (custom HTTP transport refuses non-loopback dials)
   ▼
LM STUDIO  (http://127.0.0.1:1234 only)
   │
   ▼
LOCAL LLM
```

No cloud, no telemetry, no remote backend, no SaaS, no account, no login. The only runtime network destination is `127.0.0.1:1234`. Verified by automated static audit.

### Known limitations

- The extension ID is derived from a fixed seed (suitable for Mode A on a single machine). For production distribution with a stable Chrome-recognized ID, generate a real RSA keypair and put the public key in `extension/public/manifest.json` under `"key"`. See `DEVELOPMENT.md` → "Extension signing".
- The PowerShell installer scripts have been manually reviewed for syntax and brace balance but have not been executed against real Windows PowerShell in this release. Run `Diagnose.bat` after install to verify every layer.
- Real-world contenteditable behavior in Gmail / Outlook web / other rich-text editors may surface edge cases. The adapter uses `execCommand("insertText")` for undo preservation, but some editors intercept or override this command.

[Unreleased]: https://github.com/kimpearce888/local-writing-assistant/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/kimpearce888/local-writing-assistant/releases/tag/v1.1.0
[1.0.0]: https://github.com/kimpearce888/local-writing-assistant/releases/tag/v1.0.0
