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

- Node.js 20+ and npm
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
3. Add the option to `extension/src/options/options.html` and `extension/src/options/index.ts`.

## Extension signing

For local development, the extension loads as "unpacked" with a temporary ID derived from the absolute path. For production distribution with a stable Chrome-recognized ID:

1. Generate an RSA keypair once (`openssl genrsa -out key.pem 2048 && openssl rsa -in key.pem -pubout -out public.pem`).
2. Put the public key in `extension/public/manifest.json` under the `"key"` field.
3. Keep `key.pem` **out of source control**, in a password manager or CI secret.
4. The extension ID is then derived from the public key and is stable across machines.

See `DEVELOPMENT.md` → "Extension signing" for details.

## Licensing

By contributing, you agree that your contributions will be licensed under the project's MIT License.

## Code of conduct

Be kind. Disagreements about code are fine; personal attacks are not. PRs from anyone are welcome, regardless of experience level.
