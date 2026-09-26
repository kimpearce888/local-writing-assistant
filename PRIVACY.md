# Privacy Notice — Local Writing Assistant

This document describes accurately how the Local Writing Assistant extension handles user data.

## TL;DR

* **Your writing stays on your computer.** No cloud AI processes your text.
* The only AI engine is LM Studio running locally on the same PC.
* Settings, the custom dictionary, site exclusions, and the ignored-suggestion memory are stored in `chrome.storage.local` only — never in `chrome.storage.sync`, never on a server.
* There is no telemetry, no analytics, no crash reporting, no account, no login.
* The only runtime network destination is `http://127.0.0.1:1234` — the local LM Studio server.

---

## Where text goes

When the assistant analyzes text, the data path is:

```
focused editor in webpage
   │
   ▼  (content script extracts only the relevant text)
extension service worker
   │
   ▼  (Chrome native messaging, stdin/stdout on the same PC)
native host EXE  (%LOCALAPPDATA%\LocalWritingAssistant\native-host\LocalWritingAssistantHost.exe)
   │
   ▼  (HTTP, 127.0.0.1 only)
LM Studio
   │
   ▼
local LLM
```

No part of this path crosses the public internet.

### What is sent to LM Studio

For grammar checks, the assistant sends:

* the current sentence and a small context window (default 600 characters)
* a system prompt instructing the model to return strict JSON
* the model ID, temperature, and token budget (all configurable in Settings)

For rewrite operations, the assistant sends:

* the selected text
* a rewrite prompt
* the model ID and parameters

### What is NOT sent

* Passwords, credit-card numbers, API keys, security codes (these fields are detected and skipped — see section 21 of the spec)
* The full webpage HTML
* Cookies, browser history, hidden DOM
* Unrelated page content

---

## How settings are stored

All settings are stored in `chrome.storage.local` under these keys:

* `settings` — the full ExtensionSettings object (LM Studio URL, model, temperature, etc.)
* `customDictionary` — array of strings the user has added
* `siteExclusions` — array of host names where the assistant is disabled
* `ignoredWords` — array of words the user has chosen to ignore globally
* `ignoredSuggestions` — capped at 200 entries; tracks per-suggestion ignore-once decisions
* `diagnostics` — capped at 500 entries; stores local-only log entries (no full text)
* `extensionId` — cached extension ID for diagnostics

`chrome.storage.sync` is **never** used. The extension does not sync any data through Chrome Sync.

---

## LM Studio authentication

If you have configured LM Studio to require a bearer token, the extension stores the token in `chrome.storage.local` under `settings.lmStudioToken`. The token is sent **only** to `http://127.0.0.1:1234`. It is never logged and never sent anywhere else.

---

## Telemetry

**There is no telemetry.**

The extension contains no calls to any analytics service, no Sentry, no Segment, no Mixpanel, no Amplitude, no Google Analytics, no Firebase. Verified by `scripts/network-audit.cjs` which is run before packaging.

---

## Network endpoints

The only runtime network destination the extension ever contacts is the local LM Studio server, by default:

```
http://127.0.0.1:1234
```

This can be changed in Settings, but the native host enforces that only `127.0.0.1`, `localhost`, and `::1` are accepted as LM Studio hosts. Any other host is rejected by the Go binary's custom HTTP transport, regardless of what the user typed.

---

## Crash safety

If the native host crashes:

* Chrome and the webpage remain stable.
* The extension will report "Not connected" in the popup.
* Re-running `Install.bat` repairs the installation.

---

## Uninstallation

Run `Uninstall.bat`. This removes:

* the native messaging registry entry
* the native host EXE and manifest
* the application folder under `%LOCALAPPDATA%\LocalWritingAssistant`
* this application's own `ExtensionInstallForcelist` entries (and only ours)

It does **not** touch:

* your LM Studio installation or models
* unrelated Chrome settings
* unrelated Chrome policies

---

## Changes to this notice

This notice may be updated as the project evolves. The current version always reflects the actual behavior of the source code, which is auditable at:

* `extension/src/` — TypeScript source for the extension
* `native-host/` — Go source for the native host
* `scripts/network-audit.cjs` — automated check that no forbidden network patterns exist
* `scripts/security-audit.cjs` — automated check that no `eval`, `new Function`, or cloud API keys exist
