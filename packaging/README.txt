Local Writing Assistant — Windows package
==========================================

This folder contains the complete Windows installation package.

Quick start:
  1. Extract this ZIP to any folder on your PC.
  2. Double-click Install.bat
  3. Follow the on-screen instructions.

What's inside:
  Install.bat             — Double-click to install
  Uninstall.bat           — Double-click to uninstall
  Diagnose.bat            — Run a PASS/WARN/FAIL health check
  README.md               — Project overview and usage
  PRIVACY.md              — Privacy notice
  SECURITY.md             — Security model
  DEVELOPMENT.md          — Build instructions
  installer/              — PowerShell scripts invoked by the .bat files
  native-host/            — Standalone Go-built Windows EXE for native messaging
  extension/              — Built Chrome extension (Manifest V3)
  policy/                  — Empty; installer populates this on Mode A machines
  update/                  — Empty; installer writes update.xml here on Mode A machines
  diagnostics/             — Empty; installer + extension write local diagnostics here

Important notes:
  - The only AI engine is LM Studio running on YOUR PC. No cloud, no telemetry.
  - For unmanaged personal Chrome, you'll need to load the extension as
    "unpacked" once via chrome://extensions (Mode B). The installer will
    tell you this clearly if it can't do Mode A silently.
  - After installation, open LM Studio, load a model, and start the local
    server (default port 1234). Then click "Test LM Studio Connection"
    in the extension popup.

Troubleshooting:
  Run Diagnose.bat for a full PASS/WARN/FAIL report.
