Local Writing Assistant — Linux installation package
====================================================

This folder contains the complete Linux installation package.

Contents:
  install.sh          — one-shot installer (extension + native host + Chrome registration)
  diagnose.sh         — connection/installation diagnostics
  uninstall.sh        — removes everything the installer added
  extension/          — built extension (loaded unpacked by Chrome)
  native-host/        — LocalWritingAssistantHost binary + host manifest template
  installer/          — the raw installer scripts referenced above

Install:  bash installer/install.sh
Diagnose: bash installer/diagnose.sh
Remove:   bash installer/uninstall.sh

Requirements: Chrome/Chromium, local LM Studio server (http://127.0.0.1:1234).
See README.md in the repository for full documentation.
