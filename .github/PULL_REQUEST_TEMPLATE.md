## Summary

<!-- Brief description of what this PR changes and why. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Refactor / cleanup (no behavior change)
- [ ] Build / CI change

## Privacy & security guardrails

Every PR must keep the assistant fully local. By checking the boxes below you confirm:

- [ ] No new cloud / network / SaaS / remote-API dependency added.
- [ ] No telemetry, analytics, or remote-logging added.
- [ ] No `eval`, `new Function`, `dangerouslySetInnerHTML`, `document.write`, Go `exec.Command`, or cloud API keys added.
- [ ] AI output (if touched) is still validated strictly before DOM insertion.
- [ ] The native host's loopback-only HTTP restriction is preserved (no new outbound network paths).

## Tests

- [ ] `npm run typecheck` passes
- [ ] `npm run audit:network` passes
- [ ] `npm run audit:security` passes
- [ ] `npm run test:native` passes
- [ ] `npm run test:integration` passes
- [ ] `npx vitest run` passes

## Checklist

- [ ] I bumped the version in `extension/package.json`, `extension/public/manifest.json`, `native-host/cmd/localwritingassistanthost/main.go`, and the root `package.json` if this is a user-visible change (see `DEVELOPMENT.md`).
- [ ] I added or updated tests for any new behavior.
- [ ] I updated `README.md` / `PRIVACY.md` / `SECURITY.md` / `DEVELOPMENT.md` if behavior changed in a user-visible way.
- [ ] I did NOT include the extension signing key, LM Studio token, or any other secret in this PR.
