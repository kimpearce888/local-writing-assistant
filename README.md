# Local Writing Assistant

A **fully local** AI writing assistant for Chrome on Windows, powered by [LM Studio](https://lmstudio.ai).

The user's text never leaves the user's computer. There is no cloud AI, no telemetry, no analytics, no account, no login, no remote backend. The only AI engine is LM Studio running locally on the same PC.

This is **not** a Grammarly clone — it is an original local-first writing assistant with its own UI, prompts, and architecture.

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

## Architecture

```
WEB PAGE
   │
   ▼
CONTENT SCRIPT
   │
   ▼
EXTENSION SERVICE WORKER
   │
   ▼
CHROME NATIVE MESSAGING
   │
   ▼
LOCAL NATIVE HOST EXE  (Go, ~5 MB standalone)
   │
   ▼
LM STUDIO  (http://127.0.0.1:1234)
   │
   ▼
LOCAL LLM
```

The browser page never talks to the cloud. The native host dials **only** `127.0.0.1` / `localhost`. A custom transport in the Go binary refuses any non-loopback dial, so even a misconfigured URL cannot escape the local machine.

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
* Generate `update.xml` for enterprise installation
* Attempt Mode A (enterprise force-install) where Chrome permits it
* Verify LM Studio reachability

### 3. The Chrome installation step (Mode A vs Mode B)

The installer is honest about which mode it applied:

#### Mode A — Managed / enterprise Chrome

If Chrome accepts enterprise policy in the current user context (this is typical for company-managed Chrome, or for any user who can write to `HKCU\Software\Policies\Google\Chrome`), the installer:

* Adds the extension to `ExtensionInstallForcelist`
* Points the update URL at the local `update.xml`
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

Open any webpage with a `<textarea>`, `<input>` (text/email/search/url/tel), or `contenteditable="true"` editor. Start typing. After a short debounce (~700ms), inline suggestions will appear.

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

## Development

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for build instructions, project structure, and how to run the test suite.

---

## Troubleshooting

Run `Diagnose.bat` from the extracted folder. It prints a PASS/WARN/FAIL report covering:

* Chrome installation
* Native host EXE presence
* Native messaging registry entry
* Chrome enterprise policy
* Extension folder
* LM Studio reachability
* Available models

If any FAIL appears, run `Install.bat` again — it is idempotent and will repair the installation.

---

## License

This project is released under the MIT License. See `LICENSE` (if present) or the source files for details.
