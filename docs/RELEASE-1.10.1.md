# Release v1.10.1 — production readiness record

Date: 2026-11-27. This file is the one-stop record of what was verified,
what was built, and what remains open for the v1.10.1 production release.

## 1. Quality gates (all re-run on the release tree)

| Gate | Command | Result |
| --- | --- | --- |
| Extension typecheck | `npm run typecheck` | PASS |
| Test-suite typecheck | `npm run typecheck:tests` | PASS |
| Unit tests | `npm run test:unit` | **208/208 PASS** |
| Native host tests (Go) | `npm run test:native` | PASS (`lmstudio`, `protocol`, `security`) |
| Integration suite (Go) | `npm run test:integration` | PASS (mock-mode host flows) |
| Network audit | `npm run audit:network` | PASS — 78 files, no forbidden patterns |
| Security audit | `npm run audit:security` | PASS — 183 files, no forbidden patterns |
| Removability probe | `npm run test:removal` | **7/7 PASS** (`local-check` removal-safe) |
| Human-like E2E | `test-lab/` sessions A+B | **24/24 PASS** (evidence in `test-evidence/`) |
| Extension production build | `npm run build:extension` | PASS (vite, content.js 71.5 kB) |
| ZIP content audit | manual `unzip -l` scan | PASS — no `node_modules`, `.git`, `test-lab`, `tests`, or `.map` files in any artifact |

## 2. Release artifacts (in `dist/`, gitignored; checksums in `dist/SHA256SUMS.txt`)

| Artifact | Size | SHA-256 (first 16 hex) | Contents |
| --- | --- | --- | --- |
| `Local-Writing-Assistant-Windows.zip` | 2,692,112 B | `6e37a17e89764caa…` | Native host `.exe` + `.bat/.ps1` installers + built extension + docs |
| `Local-Writing-Assistant-Linux.zip` | 2,637,608 B | `a3e50a9c64afc626…` | Native host binary + `.sh` installers + built extension + docs |
| `Local-Writing-Assistant-extension-1.10.1-cws.zip` | 75,214 B | `4376c75b83eecc0a…` | Extension only, `manifest.json` at archive root — upload-ready for the Chrome Web Store |

Full checksums:

```
a3e50a9c64afc62634e371d5a7ecf3fc167bad2845245b4592a984709b285c22  Local-Writing-Assistant-Linux.zip
6e37a17e89764caaf430061dc032aac636c405e81a71c7df1e9a1ae778d952c1  Local-Writing-Assistant-Windows.zip
4376c75b83eecc0a8a828f415d374adb024690c1dc5a0100dc2aa92754e0736e  Local-Writing-Assistant-extension-1.10.1-cws.zip
```

Reproduce with: `npm run build:extension && npm run build:native && npm run build:native:linux && npm run package`
(the Go toolchain is required for the native host; the CWS zip is
`cd extension/dist && zip -r ../../dist/<name>.zip .`).

## 3. Manifest / privacy posture (reviewed, not just described)

- MV3, CSP locked to `script-src 'self'; object-src 'self'` — no remote code.
- Permissions are the minimum set: `storage`, `nativeMessaging`,
  `contextMenus`, `sidePanel`, `activeTab`. No `tabs`, no `webRequest`,
  no broad `host_permissions`.
- Content script runs on `<all_urls>` at `document_idle` — justified for
  an assistant that works in any editor; per-permission justification text
  for the store listing lives in `docs/STORE-LISTING.md`.
- No telemetry, no analytics, no third-party network calls — everything
  goes through the local native host to the user's own LM endpoint.
- Version parity: `package.json` = `manifest.json` = `1.10.1`.

## 4. What remains open (honest remainder)

- **Store screenshots/graphics** — listing text is drafted
  (`docs/STORE-LISTING.md`), images are not produced yet.
- **CRX artifact** — deliberately not built: `scripts/build-crx.cjs`
  needs a per-developer private key (`.keys/extension.pem`, gitignored).
  Self-hosted distribution uses the platform ZIPs; store distribution
  uses the CWS zip.
- **Ollama backend** — same OpenAI-compatible shape as the tested
  LM Studio path, but not exercised against a live Ollama.
- **Windows installers** — exercised on Linux only (script review +
  cross-compiled EXE); no Windows machine in this environment.
- **Push/tag publishing** — `v1.10.1` tag and the release commit are
  local until git credentials are restored in the sandbox.
