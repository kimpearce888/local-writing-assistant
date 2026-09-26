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

For development, the extension loads as "unpacked" with a temporary ID derived from the absolute path. For production distribution, you should:

1. Generate an RSA keypair once
2. Place the public key in `extension/public/manifest.json` under the `key` field
3. Keep the private key **out of source control**, in a secure location (e.g. a password manager, a hardware key, or a CI secret)
4. The extension ID is then derived from the public key and is stable across machines

The installer's `Get-StableExtensionId` function returns a deterministic ID derived from a fixed seed — this works for Mode A force-install on a single machine but does **not** match the ID Chrome would compute from a real RSA key. For real distribution, replace this with the ID derived from your real public key.

The spec (section 50, 81) requires that the key remain stable across builds and not be exposed in logs or browser-accessible files. The recommended pattern is:

* Keep `key.pem` (private) in a CI secret
* Keep the public key in the manifest
* Document where the private key is stored (e.g. in your team's password manager under "Local Writing Assistant signing key")

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
