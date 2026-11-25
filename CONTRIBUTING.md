# Contributing to Local Writing Assistant

Thanks for considering a contribution! This document explains how to set up your environment, what the project expects, and how to land a change.

## The one rule that overrides everything else

**Every contribution must keep the assistant fully local.** No cloud, no telemetry, no remote backend, no remote dependencies, no remote JavaScript, no remote fonts. If your change would introduce any of these, it will not be merged — even if the new feature is genuinely useful. See `PRIVACY.md` and `SECURITY.md` for the full model.

The automated CI workflow will reject PRs that introduce:

- `fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `axios`
- Any non-local URL (anything other than `127.0.0.1`, `localhost`, `::1`)
- `eval`, `new Function`, `dangerouslySetInnerHTML`, `document.write`
- Go `exec.Command` / `os/exec`
- Cloud API key names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_ACCESS_KEY`, etc.)

## Setting up your dev environment

You need:

- Node.js 24+ and npm
- Go 1.23+

Fork the repo, clone your fork, and run:

```bash
# install root deps (jsdom, vitest)
npm install

# install extension deps
cd extension && npm install && cd ..

# build the extension once
npm run build:extension

# build the native host (Linux binary for local testing)
npm run build:native:linux
```

## Running the checks locally

Before opening a PR, run:

```bash
npm run typecheck           # TypeScript type-check
npm run audit:network        # static network audit
npm run audit:security       # static security audit
npm run test:native          # Go unit tests
npm run test:integration     # Go integration tests (builds + exercises the host binary)
npx vitest run              # Vitest unit tests
```

All of these must pass. The CI workflow runs the same set on every PR, so you'll find out quickly if something is broken — but running locally saves a round-trip.

## Project structure

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the full layout. The short version:

- `extension/` — Chrome MV3 extension (TypeScript + Vite)
- `native-host/` — Go native messaging host (standalone Windows EXE when cross-compiled)
- `installer/` — Windows PowerShell installer scripts
- `tests/` — Vitest + Go integration tests
- `scripts/` — icon generator, audits, ZIP packager

## How to make a change

1. **Open an issue first** if your change is anything bigger than a typo fix. The maintainer can save you a lot of time by confirming the approach before you write code.
2. **Create a branch** off `main`:
   ```bash
   git checkout -b feature/short-description
   ```
3. **Write your change.** Match the surrounding code style. Run the checks above.
4. **Add tests** for any new behavior. Bug fixes should include a regression test that fails before the fix and passes after.
5. **Update documentation** (`README.md`, `PRIVACY.md`, `SECURITY.md`, `DEVELOPMENT.md`) if your change is user-visible or affects the security/privacy model.
6. **Bump the version** in all four places if your change is user-visible (see `DEVELOPMENT.md` → "Updating the version"):
   - `extension/package.json`
   - `extension/public/manifest.json`
   - `native-host/cmd/localwritingassistanthost/main.go` (`hostVersion()`)
   - root `package.json`
7. **Commit** with a clear message. Conventional-style prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `deps:`) are appreciated but not required.
8. **Open a PR** against `main`. Fill in the PR template.

## Code review criteria

The maintainer will look at:

- Does CI pass?
- Does the change preserve the local-only security model?
- Are tests added for new behavior?
- Is the code clear and maintainable?
- Are there obvious edge cases the change misses?
- Did the PR avoid committing secrets (signing keys, tokens, etc.)?

## Adding a new editor adapter

1. Create `extension/src/content/adapters/<name>.ts` implementing `EditorAdapter`.
2. Register it in `extension/src/content/adapters/index.ts`.
3. Add a jsdom-based test mirroring `tests/sensitive-field.test.ts`.
4. Document it in `DEVELOPMENT.md` → "How to extend".

## Adding a new native-host command

1. Add the command name to `extension/src/shared/types.ts` (the `NativeCommand` union).
2. Add a handler in `native-host/cmd/localwritingassistanthost/main.go`.
3. Add the command name to `security.IsAllowedCommand` in `native-host/internal/security/security.go` (or it will be rejected as `UNKNOWN_COMMAND`).
4. Add a wire-protocol test in `tests/native_host_integration_test.go`.

## Adding a new tone mode

1. Add the value to the `ToneMode` union in `extension/src/shared/types.ts`.
2. Add a description string in `extension/src/shared/prompts.ts` → `buildTonePrompt`.
3. Add the option to `extension/options.html` (the Vite build entry — not a copy under `src/`) and `extension/src/options/index.ts`.
4. To expose it in the side panel, add an entry with `kind: "tone"` to the **Adjust tone** category in the `CATEGORIES` table in `extension/src/sidepanel/index.ts`. New rewrite operations are added to that table too; analysis-only ops (Evaluate menu) must also be listed in `ANALYSIS_OPERATIONS` in `types.ts` so Replace stays disabled for them.

## Extension signing

The RSA keypair was already generated and the **public key is committed** in `extension/public/manifest.json` under the `"key"` field, so unpacked loads get the stable extension ID `lclfegmpnhibpkijgmlpjaoemnjpabcp` on every machine — development and packaged builds share one ID.

1. The matching private key lives **out of source control** (`.keys/extension.pem`, gitignored; also provisioned as the `CRX_SIGNING_KEY` CI secret).
2. `scripts/build-crx.cjs` signs release CRX3 files with that key; `scripts/embed-public-key.sh` re-embeds a rotated public key into the manifest if the keypair is ever replaced.
3. Replacing the keypair changes the extension ID — every installer pins the ID, so rotation requires updating install.ps1 / install.sh / diagnose scripts together.

See `DEVELOPMENT.md` → "Extension signing" for details.

## Licensing

By contributing, you agree that your contributions will be licensed under the project's MIT License.

## Code of conduct

Be kind. Disagreements about code are fine; personal attacks are not. PRs from anyone are welcome, regardless of experience level.
