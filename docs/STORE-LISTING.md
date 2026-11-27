# Chrome Web Store listing draft — v1.10.1

Everything below is submission-ready copy for the Chrome Web Store
developer dashboard. Store screenshots (1280×800 PNG) still need to be
produced — suggested shots are listed at the end.

## Store metadata

- **Name** (≤45 chars): `Local Writing Assistant — Offline AI Writer`
- **Short description** (≤132 chars):
  `Grammar, rewrite and continue writing with your own local AI model. No cloud, no telemetry — everything stays on your machine.`
- **Category**: Productivity → Tools
- **Language**: English (US)
- **Single purpose** (dashboard field):
  This extension has one purpose: improving the text the user writes in
  browser editors (grammar checking, rewriting, continuing, explaining and
  summarizing the user's own text), powered entirely by a language model
  running on the user's own machine.

## Detailed description

Local Writing Assistant brings AI writing help to every editor in your
browser — web mail, CMS boxes, docs, forms, textareas — while keeping all
processing on your own computer.

How it works:
- Select text and use the right-click menu (or Alt+Shift+R) to Rewrite,
  Continue, Explain or Summarize it in the side panel.
- Pause typing and the assistant instantly flags clear-cut errors
  (misspellings, doubled words, a/an mistakes, spacing) with an offline
  rule engine — no model round trip needed.
- Press Alt+Shift+L in any editor for a full writing check that combines
  the offline rules with your local AI model.
- Manage snippets in the options page and reuse them anywhere with
  Alt+Shift+O; snippets can be exported and imported as JSON.

Privacy by design:
- No cloud. No account. No analytics. No remote code.
- The extension talks only to a helper process on your own machine, which
  talks only to the language model you installed (LM Studio, Ollama or any
  OpenAI-compatible local server).
- Your text never leaves your computer. If the model is offline, the
  offline rule engine still works.

Getting started: install the extension ZIP for your platform from the
project README, run its installer to register the local helper, and point
the options page at your local model endpoint.

## Permission justifications (dashboard "Permission justification" fields)

- `storage` — stores your preferences, custom dictionary, ignored words
  and snippets locally in chrome.storage. Nothing is synced or sent
  anywhere.
- `nativeMessaging` — communicates with the Local Writing Assistant host
  process installed on your machine; this process is the only bridge to
  your local language-model server.
- `contextMenus` — adds the "Local Writing Assistant" items (Rewrite,
  Continue, Explain, Summarize, Check) to the right-click menu on
  selected text.
- `sidePanel` — shows the rewrite/continue results in Chrome's side panel
  next to the page you are writing in.
- `activeTab` — reads the text you are editing and applies corrections in
  the tab you invoked the assistant on, only after you trigger an action.
- Content script on `<all_urls>` — the assistant must be available in
  every editor a user may write in (web mail, CMS, docs, forms). The
  content script only reads text from the focused editable element when
  you invoke an action; it does not browse, collect or transmit page
  content. Remote pages cannot reach it (isolated world, locked CSP).

## Privacy practices tab (data usage disclosures)

- Does this extension collect or use personal data? **No.**
- Does it transmit data for required features? **No** — all processing is
  local; the only network endpoint is the user-configured local model
  server on localhost.
- Compliance statement: no data sold, no data used for unrelated purposes,
  no data used for credit/lending decisions. Remote code is not used
  (MV3 locked CSP, verified by the repo's `npm run audit:security`).

## Required screenshots (to produce)

1. 1280×800 — side panel rewriting a paragraph in a web editor.
2. 1280×800 — inline underline suggestions appearing after typing pause.
3. 1280×800 — options page (endpoint config + snippets manager).
4. 1280×800 — right-click context menu with assistant items.
5. Small promo tile 440×280 and marquee 1400×560 (optional but
   recommended).

The human-like E2E evidence run (`test-evidence/`) already contains
full-screen captures of flows 1 and 4 that can be re-shot at 1280×800.
