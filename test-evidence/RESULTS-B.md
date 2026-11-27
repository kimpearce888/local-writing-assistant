# E2E session B — 2026-11-27T03:39:11.169Z

**8/10 steps passed, 2 failed**

| Step | Name | Result | Time | Shots | Detail |
|---|---|---|---|---|---|
| B-01 | Password and API-key fields are never analyzed | PASS | 5.2s | `B-01-sensitive-fields.png` | values intact, 0 inline markers on sensitive fields |
| B-02 | Side panel Check tab: 'Check now' returns real AI issues | PASS | 17.3s | `B-02-sidepanel-check.png` | 5 issue(s) listed; chip="5 suggestions" |
| B-03 | Insights tab: performance dashboard, stats, tone detection, synonyms | PASS | 2.3s | `B-03-sidepanel-insights.png` | stats: 17Words86Characters2Sentences1Paragraphs0.1 minReading time0.1 minSpeaking timeVery easy (98.7)Readability90%V \| tone readings: 2 \| synonyms for "good": 2 suggestion(s) |
| B-04 | 'Improve it' rewrites the text with REAL AI | PASS | 10.4s | `B-04-improve-it.png` | result: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday...." |
| B-05 | Custom instruction: 'Rewrite this as a friendly Slack message' | PASS | 10.2s | `B-05-custom-instruction.png` | result: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday...." |
| B-06 | Write menu: 'Create a TL;DR' generates a summary | PASS | 10.5s | `B-06-tldr.png` | TL;DR: "They're going to the store, and she doesn't know the way there. We saw it happen yesterday." |
| B-07 | Evaluate menu: 'Pick out my main point' analyzes and disables Replace | PASS | 10.8s | `B-07-main-point.png` | analysis: "The main point is that they are going to the store and she doesn't know the way. Secondary..." \| Replace disabled=true |
| B-08 | FULL journey: select-all, native menu 'Rewrite…', side panel handshake, Improve it, Replace onto page | FAIL | 108.8s | `B-08a-context-menu-rewrite-1.png` | page.waitForFunction: Timeout 90000ms exceeded. |
| B-09 | Popup master toggle OFF stops all analysis; ON restores it | FAIL | 69.5s | `B-09a-toggle-off.png`, `B-09b-disabled-no-markers.png` | page.waitForSelector: Timeout 60000ms exceeded.
Call log:
  - waiting for locator('[data-lwa-highlight][data-issue-id]') to be visible
 |
| B-10 | AI call log proves every result came from a real model round-trip | PASS | 0.0s |  | 15 AI requests / 8 real responses / 2 cache-served duplicates; sample: [2026-11-27T03:35:52.968Z] RES#6 1080ms 196 chars |
