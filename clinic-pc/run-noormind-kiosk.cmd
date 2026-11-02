@echo off
REM ===========================================================================
REM  NoorMind polyp detection - clinic PC launcher
REM
REM  Started by the "NoorMind Kiosk" scheduled task at logon. Do not run this
REM  by hand except to test.
REM
REM  All it does is hand over to kiosk-loop.ps1, which opens the browser full
REM  screen and reopens it if it ever closes.
REM
REM  It used to do the loop itself, with `start "" /wait chrome.exe ...`. That
REM  does not reliably wait - Chrome's launcher process can hand off and exit
REM  straight away, so the loop relaunched the browser every five seconds, the
REM  page restarted constantly, and the login form could not be filled in.
REM  PowerShell's Start-Process -PassThru + WaitForExit() waits for the browser
REM  process itself, which is the whole point.
REM ===========================================================================

set "HERE=%~dp0"
if exist "%HERE%kiosk-loop.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%HERE%kiosk-loop.ps1"
) else (
  echo kiosk-loop.ps1 is missing from %HERE%
  echo Run FIX-LAUNCHER.cmd from the USB stick as administrator.
  pause
)
