# Security Policy — Reporting Vulnerabilities

This file describes how to **report a security vulnerability** in Local Writing Assistant.

For the **architecture** of the security model (native messaging boundary, loopback-only HTTP, AI output validation, etc.), see [`../SECURITY.md`](../SECURITY.md).

## Supported versions

Only the latest tagged release (`v1.x.x`) receives security fixes.

| Version | Supported |
|---------|-----------|
| latest `v1.x` | ✅ |
| any `v0.x` pre-release | ❌ |

## Reporting a vulnerability

**Please DO NOT open a public GitHub issue for security problems.**

Instead, report privately using one of:

1. **GitHub's private vulnerability reporting** — go to <https://github.com/kimpearce888/local-writing-assistant/security/advisories/new> and use the "Report a vulnerability" button. This is the preferred channel — it lets the maintainer discuss details with you privately and then optionally publish a GitHub Security Advisory with CVE assignment when a fix is ready.

2. **Email** — if GitHub's reporting tool isn't available to you, email the maintainer directly. (Replace the email with the maintainer's actual contact if different.) Please encrypt sensitive details using the maintainer's published PGP key if available.

## What to include

Please include as much of the following as possible:

- A clear description of the vulnerability and its impact.
- The exact version (or git commit SHA) you tested.
- A minimal reproduction — a sequence of steps, a tiny HTML page, a sample LM Studio response, or a one-liner that triggers the bug.
- Whether the issue is in the extension, the native host, the installer, or the docs.
- Any affected component paths you can identify (e.g. `extension/src/content/suggestion-popup.ts`, `native-host/internal/security/security.go`).

## What you can expect

- **Acknowledgement** within 5 business days.
- **An initial assessment** within 14 days — whether the report is accepted as a vulnerability, needs more info, or is declined.
- **A fix timeline** coordinated with you before any public disclosure. We will not publish details until a fix is available and users have had a reasonable window to update.
- **Credit** in the release notes and the GitHub Security Advisory, if you want it.

## Scope

Vulnerabilities in scope include anything that violates the security promises in [`../SECURITY.md`](../SECURITY.md), for example:

- A way for the extension or native host to make a non-loopback network connection.
- A way for AI output (model responses) to inject HTML or JavaScript into the extension UI.
- A way for a webpage to invoke an unauthorized native-host command.
- A way to escape the native host's loopback-only HTTP restriction.
- A way to extract the LM Studio bearer token (if configured) from storage or logs.
- A way for prompt-injection text inside the user's writing to cause anything other than a (possibly wrong) text replacement in the editor.
- Installer behavior that overwrites unrelated Chrome policies or fails to remove its own entries on uninstall.

## Out of scope

- Bugs in LM Studio itself — report those to LM Studio's maintainers.
- Bugs in Chrome itself — report those to the Chromium project.
- Vulnerabilities that require the user to deliberately disable the security model (e.g. manually editing the registry to allow non-loopback hosts).
- "The assistant returned a wrong grammar suggestion" — that's a model quality issue, not a security issue.

## Hardening notes for contributors

If you are submitting a PR that touches anything security-sensitive (the native host command list, the URL allowlist, AI output validation, the installer's policy writes), please:

- Add or update tests proving the change preserves the security boundary.
- Re-run `npm run audit:network` and `npm run audit:security` and confirm both still pass.
- Mention in the PR description that the change is security-relevant, so it can get extra review.
