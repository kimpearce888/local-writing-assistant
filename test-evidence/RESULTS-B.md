# E2E session B — 2026-11-27T03:54:01.921Z

**10/10 steps passed, 0 failed**

| Step | Name | Result | Time | Shots | Detail |
|---|---|---|---|---|---|
| B-01 | Password and API-key fields are never analyzed | PASS | 5.2s | `B-01-sensitive-fields.png` | values intact, 0 inline markers on sensitive fields |
| B-02 | Side panel Check tab: 'Check now' returns real AI issues | PASS | 15.8s | `B-02-sidepanel-check.png` | 4 issue(s) listed; chip="4 suggestions" |
| B-03 | Insights tab: performance dashboard, stats, tone detection, synonyms | PASS | 2.0s | `B-03-sidepanel-insights.png` | stats: 17Words86Characters2Sentences1Paragraphs0.1 minReading time0.1 minSpeaking timeVery easy (98.7)Readability90%V \| tone readings: 2 \| synonyms for "good": 2 suggestion(s) |
| B-04 | 'Improve it' rewrites the text with REAL AI | PASS | 10.3s | `B-04-improve-it.png` | result: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday...." |
| B-05 | Custom instruction: 'Rewrite this as a friendly Slack message' | PASS | 10.3s | `B-05-custom-instruction.png` | result: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday...." |
| B-06 | Write menu: 'Create a TL;DR' generates a summary | PASS | 10.4s | `B-06-tldr.png` | TL;DR: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday." |
| B-07 | Evaluate menu: 'Pick out my main point' analyzes and disables Replace | PASS | 10.7s | `B-07-main-point.png` | analysis: "The main point is that someone is going to the store and another person doesn't know the w..." \| Replace disabled=true |
| B-08 | FULL journey: select-all, native menu 'Rewrite…', side panel handshake, Improve it, Replace onto page | PASS | 21.6s | `B-08a-context-menu-rewrite-1.png`, `B-08b-panel-rewrite.png`, `B-08c-replaced-on-page.png` | panel preloaded with fresh page selection (304 chars) \| rewrite ready: "Hi Sarah, /  / I wanted to follow up on the Q3 roadmap we discussed last week. The t..." \| apply confirmed (errorLine="Replaced."); page now: "Hi  |
| B-09 | Popup master toggle OFF stops all analysis; ON restores it | PASS | 12.3s | `B-09a-toggle-off.png`, `B-09b-disabled-no-markers.png`, `B-09c-re-enabled.png` | extension disabled: 0 markers \| re-enabled: markers are back |
| B-10 | AI call log proves every result came from a real model round-trip | PASS | 0.0s |  | 17 AI requests / 14 real responses / 3 cache-served duplicates; sample: [2026-11-27T03:53:56.433Z] RES#14 378ms 11 chars |
