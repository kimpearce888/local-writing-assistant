# E2E session A — 2026-11-27T03:34:53.092Z

**14/14 steps passed, 0 failed**

| Step | Name | Result | Time | Shots | Detail |
|---|---|---|---|---|---|
| A-01 | Extension is installed and enabled in chrome://extensions | PASS | 2.3s | `A-01-extensions-page.png` | name visible; errors button present=false |
| A-02 | Popup shows REAL Connected status (native host -> shim -> model list + AI ping) | PASS | 0.7s | `A-02-popup-connected.png` | model="—" suggestions=0 |
| A-03 | Popup 'Test LM Studio Connection' round-trip | PASS | 0.1s | `A-03-popup-connection-test.png` | diag: Connection test passed. |
| A-04 | Real-time grammar check appears WHILE typing (real AI, per-keystroke) | PASS | 3.8s | `A-04-realtime-markers.png` | 1 inline marker(s) after ~4s typing + debounce + AI round-trip |
| A-05 | Hovering an underlined issue opens the suggestion card | PASS | 1.3s | `A-05-hover-card.png` | suggestion card rendered on hover |
| A-06 | Suggestion popup Replace button applies the AI fix | PASS | 0.2s | `A-06a-suggestion-popup.png`, `A-06b-after-replace.png` | popup content: ×GrammarThird-person singular requires 'doesn't' instead of 'don't'.Replace: She don't↓→ She doesn'tReplace✎ EditIgnore \| editor now: "She doesn't like it." |
| A-07 | Offline fast-check underlines local-rule errors instantly (v1.10.0) | PASS | 4.7s | `A-07-offline-fastcheck.png` | 2 markers in 4.6s (local rules: teh + recieved) |
| A-08 | Floating assistant widget docks to the editor | PASS | 3.2s | `A-08-floating-widget.png` | widget rect {"found":true,"x":606,"y":293,"w":40,"h":40} |
| A-09 | Content-rich email compose page gets inline checks (contenteditable) | PASS | 8.4s | `A-09-compose-page.png` | 1 marker(s) on the email draft |
| A-10 | Options page: create snippet 'sig' via the form | PASS | 0.4s | `A-10a-options-snippet-form.png`, `A-10b-snippet-saved.png` | snippet list now has 1 item(s) |
| A-11 | Native context menu: 'Save selection as snippet' (real X11 right-click) | PASS | 7.7s | `A-11a-context-menu-1.png`, `A-11b-snippet-from-selection.png` | options page opened with the selection pre-filled \| saved snippet "addr" from context-menu selection: "" |
| A-12 | Snippet expansion: typing ';sig' expands to the full signature | PASS | 0.6s | `A-12-snippet-expanded.png` | expanded (62 chars): "Reach me anytime. Best regards, / Alex Kim / Founder, Example Corp..." |
| A-13 | Settings persist; Refresh models lists the real model; diagnostics run | PASS | 1.4s | `A-13a-options-models.png`, `A-13b-options-diagnostics.png` | dialect=uk persisted across reload \| models: glm-4.6; selected glm-4.6 \| diagnostics: [..] Running diagnostics… [PASS] Native host installed [PASS] LM Studio reachable [PASS] /v1/models endpoint [PASS] At least one mod |
| A-14 | Pause on this site suppresses analysis; Resume restores it | PASS | 13.0s | `A-14a-paused-site.png`, `A-14b-resumed-site.png` | paused: 0 markers while typing an error sentence \| resumed: markers are back |
