@echo off
REM Local Writing Assistant — Windows installer launcher.
REM
REM Per spec section 46, this .bat invokes install.ps1 with the right
REM execution policy for the current process and forwards all arguments.

setlocal
set PS1=%~dp0install.ps1

if not exist "%PS1%" (
  echo [FAIL] install.ps1 not found next to %~nx0
  echo Expected: %PS1%
  exit /b 1
)

REM Try PowerShell Core first, then fall back to Windows PowerShell.
where pwsh >nul 2>&1
if %ERRORLEVEL%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
  exit /b %ERRORLEVEL%
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %ERRORLEVEL%
