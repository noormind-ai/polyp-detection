@echo off
setlocal
REM ===========================================================================
REM  NoorMind clinic PC - install the corrected kiosk launcher.
REM
REM  RUN THIS ONCE, AS ADMINISTRATOR, from the USB stick.
REM  Right-click this file -> "Run as administrator".
REM
REM  What it fixes: the first launcher used `start /wait`, which does not
REM  reliably wait for Chrome. The loop therefore relaunched the browser every
REM  five seconds, the page restarted constantly, and nothing could be typed
REM  into it. The replacement waits for the actual browser process.
REM
REM  It stops the kiosk, swaps the files, and starts it again. Your sign-in is
REM  NOT affected - that lives in C:\NoorMind\chrome-profile, which is left
REM  completely alone.
REM ===========================================================================

net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Not running as Administrator.
  echo   Right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

set "TARGET=C:\NoorMind"
if not exist "%TARGET%" mkdir "%TARGET%"

echo.
echo === Stopping the kiosk ===
schtasks /end /tn "NoorMind Kiosk" >nul 2>&1
REM The old launcher is a cmd loop; ending the task stops it. Then close the
REM browser it left behind.
taskkill /f /im chrome.exe  >nul 2>&1
taskkill /f /im msedge.exe  >nul 2>&1
timeout /t 2 /nobreak >nul
echo   ok

echo.
echo === Installing the corrected launcher ===
copy /Y "%~dp0run-noormind-kiosk.cmd" "%TARGET%\run-noormind-kiosk.cmd" >nul
if errorlevel 1 ( echo   FAILED to copy run-noormind-kiosk.cmd & pause & exit /b 1 )
copy /Y "%~dp0kiosk-loop.ps1" "%TARGET%\kiosk-loop.ps1" >nul
if errorlevel 1 ( echo   FAILED to copy kiosk-loop.ps1 & pause & exit /b 1 )
echo   ok

echo.
echo === Starting it again ===
schtasks /run /tn "NoorMind Kiosk" >nul 2>&1
if errorlevel 1 (
  echo   The scheduled task could not be started - starting the launcher directly.
  start "" "%TARGET%\run-noormind-kiosk.cmd"
)
echo   ok

echo.
echo ===========================================================================
echo   Done. The browser should reopen full screen and STAY on one page this
echo   time. You are still signed in, so it should go straight to the live
echo   camera.
echo.
echo   If anything still looks wrong, send me this file:
echo       C:\NoorMind\kiosk.log
echo   It records every time the browser starts and stops, with times.
echo ===========================================================================
echo.
pause
