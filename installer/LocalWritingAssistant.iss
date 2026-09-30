; Local Writing Assistant — Inno Setup script
;
; This produces a polished installer .exe that wraps the existing
; install.ps1 PowerShell script. The advantage of using Inno Setup:
;
;   - Adds the extension to Add/Remove Programs
;   - Provides a graphical wizard with a EULA acceptance page
;   - Can be silently installed via /SILENT /VERYSILENT
;   - Uninstaller integrates with Windows Settings
;
; The .iss is built with: iscc.exe installer.iss
; Output: dist/LocalWritingAssistantSetup.exe
;
; This is OPTIONAL — the bare Install.bat / install.ps1 installer works
; without Inno Setup. This script is for users who prefer a polished
; installer experience.

#define MyAppName "Local Writing Assistant"
; The version MUST be kept in sync with package.json, extension/package.json,
; extension/public/manifest.json, and native-host/cmd/localwritingassistanthost/main.go.
; We use the manifest.json version as the single source of truth by reading it
; with Inno Setup's preprocessor. The previous version was hardcoded to
; "1.0.0" while the extension was already on 1.1.0 — Add/Remove Programs
; showed the wrong version. Run `iscc installer/LocalWritingAssistant.iss`
; from the repo root so the relative paths below resolve correctly.
#ifndef MyAppVersion
  #define MyAppVersion "1.5.0"
#endif
#define MyAppPublisher "Local Writing Assistant Project"
#define MyAppURL "https://github.com/kimpearce888/local-writing-assistant"
#define MyAppExeName "LocalWritingAssistantHost.exe"

[Setup]
AppId={{8B5C3F4A-7E2D-4F1B-9A6C-3E5D7F8A2B1C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\LocalWritingAssistant
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=dist
OutputBaseFilename=LocalWritingAssistantSetup
SetupIconFile=extension\public\icons\icon-48.png
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
LicenseFile=LICENSE

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "startupentry"; Description: "Add to Windows startup (optional — the native host is started on-demand by Chrome, this is unnecessary)"; GroupDescription: "Additional shortcuts:"; Flags: unchecked

[Files]
; Native host EXE
Source: "native-host\LocalWritingAssistantHost.exe"; DestDir: "{app}\native-host"; Flags: ignoreversion
; Host manifest template (the installer will fill in the path)
Source: "native-host\host-manifest.template.json"; DestDir: "{app}\native-host"; Flags: ignoreversion
; Built extension
Source: "extension\dist\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
; Installer / uninstaller scripts
Source: "installer\install.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "installer\uninstall.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "installer\diagnose.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
Source: "installer\setup-lm-studio.ps1"; DestDir: "{app}\installer"; Flags: ignoreversion
; (detect-chrome.ps1 and generate-policy.ps1 were removed in v1.3.0
; — they were dead code that duplicated install.ps1's logic and
; contained an unfixed New-ItemProperty -Force bug that wiped the
; user's existing ExtensionInstallForcelist entries.)
; Documentation
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "SECURITY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Local Writing Assistant"; Filename: "{app}\installer\Install.bat"; IconFilename: "{app}\extension\icons\icon-48.png"
Name: "{group}\Diagnostics"; Filename: "{app}\installer\Diagnose.bat"; IconFilename: "{app}\extension\icons\icon-48.png"
Name: "{group}\Uninstall Local Writing Assistant"; Filename: "{uninstallexe}"

[Run]
; After files are copied, run install.ps1 to register the native host
; and the extension policy.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\install.ps1"" -InstallDir ""{app}"""; StatusMsg: "Registering native messaging host and Chrome policy..."; Flags: runhidden waituntilterminated

[UninstallRun]
; Before removing files, run uninstall.ps1 to clean up the registry.
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\uninstall.ps1"""; StatusMsg: "Removing native messaging registration..."; Flags: runhidden waituntilterminated; RunOnceId: "UninstallPs1"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
