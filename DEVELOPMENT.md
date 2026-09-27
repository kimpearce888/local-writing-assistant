# Development Guide — Local Writing Assistant

## Repository layout

```
local-writing-assistant/
│
├── extension/                     Chrome extension (TypeScript + Vite, MV3)
│   ├── manifest.json              Manifest V3 (in public/, copied verbatim)
│   ├── popup.html                 Popup UI
│   ├── sidepanel.html             Side panel UI
│   ├── options.html               Settings UI
│   ├── src/
│   │   ├── background/
│   │   │   └── service-worker.ts  Service worker — native messaging hub, commands, context menu
│   │   ├── content/
│   │   │   ├── index.ts           Content script entry — orchestrates adapters, engine, popup
│   │   │   ├── adapters/
│   │   │   │   ├── adapter.ts     EditorAdapter interface, sensitive/unsupported detection
│   │   │   │   ├── text-input.ts  <textarea>/<input> adapter
│   │   │   │   ├── content-editable.ts  contenteditable adapter (preserves undo, range-based)
│   │   │   │   └── index.ts      Adapter registry
│   │   │   ├── highlight-layer.ts Inline underline overlay (scoped with [data-lwa-*] attrs)
│   │   │   ├── suggestion-popup.ts  Suggestion popup with collision detection
│   │   │   └── suggestion-engine.ts Engine — extract → request → validate → render → accept
│   │   ├── popup/                 Popup entry
│   │   ├── sidepanel/             Side panel entry
│   │   ├── options/               Options page entry
│   │   ├── shared/
│   │   │   ├── types.ts           All shared TypeScript types + DEFAULT_SETTINGS
│   │   │   ├── storage.ts         chrome.storage.local wrapper (settings, dictionary, etc.)
│   │   │   ├── native-bridge.ts   Long-lived chrome.runtime.connectNative port + multiplexing
│   │   │   ├── prompts.ts         System-prompt builders for grammar / rewrite / tone
│   │   │   ├── ai-validation.ts   Strict JSON parser + offset validation + HTML escaping
│   │   │   ├── text-utils.ts      FNV-1a hash, sentence splitter, context window
│   │   │   ├── i18n.ts            chrome.i18n wrapper
│   │   │   └── rewrite.ts         Rewrite API used by the side panel
│   │   └── styles/
│   │       └── content.css        Scoped content-script styles
│   ├── public/
│   │   ├── _locales/en/messages.json   i18n catalog
│   │   └── icons/                 Extension icons (16/32/48/128)
│   ├── vite.config.ts             Vite config with multi-entry build + relative base
│   ├── tsconfig.json
│   └── package.json
│
├── native-host/                   Go native messaging host
│   ├── go.mod
│   ├── cmd/
│   │   └── localwritingassistanthost/
│   │       └── main.go            Host main — dispatcher, command handlers
│   ├── internal/
│   │   ├── protocol/              Length-prefixed JSON protocol
│   │   │   ├── protocol.go
│   │   │   └── protocol_test.go
│   │   ├── security/              URL allowlist, command allowlist, payload clamps
│   │   │   ├── security.go
│   │   │   └── security_test.go
│   │   ├── lmstudio/
│   │   │   └── client.go          Constrained HTTP client (loopback-only dialer)
│   │   └── logging/               Local-only stderr logging
│   │       └── logging.go
│   ├── host-manifest.template.json
│   └── build/                     Compiled binaries (gitignored in production)
│
├── installer/                     Windows installer scripts
│   ├── Install.bat                Double-click entry
│   ├── Uninstall.bat
│   ├── Diagnose.bat
│   ├── install.ps1                Main installer (Mode A + Mode B)
│   ├── uninstall.ps1
│   ├── diagnose.ps1               Read-only PASS/WARN/FAIL report
│   ├── detect-chrome.ps1          Helper
│   └── generate-policy.ps1        Helper
│
├── tests/                         Vitest + Go integration tests
│   ├── ai-validation.test.ts      Strict AI parser tests
│   ├── text-utils.test.ts         Hash / context-window tests
│   ├── stale-suggestion.test.ts   Race-condition / staleness tests
│   ├── prompts.test.ts            Prompt builder tests
│   ├── sensitive-field.test.ts    Sensitive-field detection tests
│   ├── native_host_integration_test.go   End-to-end wire-protocol tests
│   └── go.mod
│
├── scripts/
│   ├── generate-icons.cjs         PNG icon generator
│   ├── network-audit.cjs          Static network audit (section 92)
│   ├── security-audit.cjs         Static security audit (section 93)
│   └── package.js                 ZIP packager
│
├── packaging/                     README.txt for the final ZIP
├── docs/                          Additional docs
│
├── README.md
├── PRIVACY.md
├── SECURITY.md
├── DEVELOPMENT.md                 ← this file
└── package.json                   Root npm scripts
```

---

## Build

### Prerequisites

* Node.js 20+ and npm
* Go 1.23+

### Build the extension

```bash
cd extension
npm install
npm run build       # outputs dist/ (Manifest V3 bundle)
```

### Build the native host

```bash
cd native-host

# Linux/macOS (for development/testing)
go build -o build/LocalWritingAssistantHost ./cmd/localwritingassistanthost

# Windows cross-compile
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 \
  go build -ldflags="-s -w" \
  -o build/LocalWritingAssistantHost.exe \
  ./cmd/localwritingassistanthost
```

The Windows EXE is a standalone ~5 MB binary — no Go runtime needed on the target machine.

### Run the tests

```bash
# From the repository root:
npm run test:extension       # vitest (37 unit tests)
npm run test:native          # go test ./... (4 unit tests)
npm run test:integration     # go test ./... in tests/ (6 integration tests)
npm run typecheck            # tsc --noEmit
```

### Run the audits

```bash
npm run audit:network        # static check for forbidden network patterns
npm run audit:security       # static check for eval / secrets / cloud API keys
```

Both must pass before packaging.

### Package the final ZIP

```bash
npm run package              # outputs dist/Local-Writing-Assistant-Windows.zip
```

---

## Local debugging

### Extension

1. Build the extension: `cd extension && npm run build`
2. Open `chrome://extensions`
3. Enable Developer Mode
4. Click "Load unpacked" and select `extension/dist/`
5. The extension loads with a temporary extension ID

### Native host

1. Build: `cd native-host && go build -o build/LocalWritingAssistantHost ./cmd/localwritingassistanthost`
2. Generate a native host manifest pointing at the binary (or run the installer — it does this for you)
3. Register the manifest in `~/.config/google-chrome/NativeMessagingHosts/com.localwritingassistant.host.json` (Linux) or the equivalent Windows registry location

The manifest must contain:

```json
{
  "name": "com.localwritingassistant.host",
  "description": "Local Writing Assistant native messaging host",
  "path": "/absolute/path/to/LocalWritingAssistantHost",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://EXTENSION_ID/"]
}
```

### Manual wire-protocol test

You can pipe messages directly to the host:

```bash
printf '\x05\x00\x00\x00{"command":"ping","requestId":"r1"}' | \
  ./native-host/build/LocalWritingAssistantHost
```

The first 4 bytes are the little-endian length of the JSON body.

---

## Extension signing

This repo has **already** generated an RSA keypair and embedded the public key in `extension/public/manifest.json` under the `"key"` field. The resulting stable Chrome extension ID is `lclfegmpnhibpkijgmlpjaoemnjpabcp`.

### What lives where

| File | Description | Committed to git? |
|------|-------------|-------------------|
| `.keys/extension.pem` | RSA 2048-bit private key — used by `scripts/build-crx.cjs` to sign the CRX | **No** (gitignored via `*.pem`) |
| `.keys/extension.pub.b64` | Base64-encoded DER public key — used by `scripts/embed-public-key.sh` to inject into the manifest | No (not currently; you can choose to commit this since it's not a secret) |
| `.keys/extension.id` | The 32-char stable Chrome extension ID derived from the public key | No (derived; not committed) |
| `extension/public/manifest.json` (`"key"` field) | The base64 public key, baked into the manifest so Chrome computes the correct extension ID on every machine | Yes |

### To regenerate the keypair (DO NOT do this for existing deployments)

Regenerating the keypair changes the extension ID, which breaks Mode A force-install on already-deployed machines. Only do this for a fresh fork:

```bash
./scripts/generate-keypair.sh
./scripts/embed-public-key.sh
```

### Building a signed CRX

```bash
# Locally (requires .keys/extension.pem to exist):
./scripts/embed-public-key.sh
cd extension && npm run build && cd ..
node scripts/build-crx.cjs

# In CI (release.yml):
# Add a repository secret CRX_SIGNING_KEY = base64 of the PEM contents.
# The release workflow will decode it, embed the public key, build, sign, and upload.
```

### How the stable ID is computed

Chrome's algorithm (from the [Chromium source](https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/id_util.cc)):

1. Take the DER-encoded public key
2. Compute SHA-256
3. Take the first 16 bytes
4. For each byte, encode the high nibble and the low nibble into `'a'..'p'` (so 0 → 'a', 15 → 'p')
5. Concatenate to get a 32-character lowercase string

This is implemented in `scripts/generate-keypair.sh` (Python one-liner) and verified against the value Chrome actually computes when you load the extension.

---

## How to extend

### Add a new editor adapter

1. Create `extension/src/content/adapters/<name>.ts` that implements `EditorAdapter`
2. Register it in `extension/src/content/adapters/index.ts`
3. Add a test in `tests/` covering its `getText` / `getSelection` / `replaceRange` behavior

### Add a new native command

1. Add the command name to `extension/src/shared/types.ts` (the `NativeCommand` union)
2. Add a handler in `native-host/cmd/localwritingassistanthost/main.go`
3. Add the command name to `security.IsAllowedCommand` (or it will be rejected)
4. Add a wire-protocol test in `tests/native_host_integration_test.go`

### Add a new tone mode

1. Add the value to the `ToneMode` union in `extension/src/shared/types.ts`
2. Add a description string in `extension/src/shared/prompts.ts` → `buildTonePrompt`
3. Add the option to `extension/src/options/options.html` and `extension/src/options/index.ts`

---

## Architecture decisions

### Why Go for the native host?

* Self-contained Windows EXE — no runtime dependency on Node, Python, .NET, or Java
* Cross-compilation from Linux works out of the box (we built the Windows EXE on this Linux box)
* Excellent standard library for HTTP + JSON
* Small attack surface — the host imports only `net/http`, `encoding/json`, `os`, `io`, `time`, and `localwritingassistant.host/internal/*`

### Why a long-lived native messaging port?

* Multiplexes multiple requests (grammar check + rewrite + connection test) over a single connection
* Supports cancellation via per-request `AbortController`
* Detects crashes immediately via the `onDisconnect` listener
* Avoids re-spawning the host binary for every request

### Why Vite?

* Multi-entry build that emits both classic (service worker) and module (popup/sidepanel/options) bundles
* Built-in TypeScript + esbuild minification
* `base: "./"` produces relative asset paths, which Chrome MV3 requires

### Why scoped `[data-lwa-*]` attributes for content-script CSS?

* Pages can have CSS that targets `class` or `id` — using `all: initial` + attribute selectors guarantees we cannot break the host page's styling
* Same approach for the popup: `all: initial` on the root, then explicit values inside

---

## Updating the version

1. Bump `version` in `extension/package.json`
2. Bump `version` in `extension/public/manifest.json`
3. Bump `hostVersion()` in `native-host/cmd/localwritingassistanthost/main.go`
4. Bump `version` in root `package.json`
5. Run `npm run package` to produce a new ZIP

All four version numbers should stay in sync (spec section 78).
