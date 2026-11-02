@echo off
setlocal
REM ===========================================================================
REM  NoorMind polyp detection - clinic PC, one-time setup
REM
REM  RUN ONCE, AS ADMINISTRATOR (right-click -> Run as administrator).
REM
REM  After this: switch the PC on and it logs itself into Windows, opens the
REM  browser full screen, and starts live detection. Nobody touches anything.
REM
REM  This only configures THIS computer; it does not touch the NoorMind
REM  server. Everything is reversible - see UNDO at the foot.
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

set "SITE=https://ir.noormind.me"
set "HERE=%~dp0"
set "TARGET=C:\NoorMind"

echo.
echo === 1/6  Installing the launcher to %TARGET% ===
if not exist "%TARGET%" mkdir "%TARGET%"
copy /Y "%HERE%run-noormind-kiosk.cmd" "%TARGET%\run-noormind-kiosk.cmd" >nul
if errorlevel 1 ( echo   FAILED to copy the launcher. & pause & exit /b 1 )
copy /Y "%HERE%kiosk-loop.ps1" "%TARGET%\kiosk-loop.ps1" >nul
if errorlevel 1 ( echo   FAILED to copy kiosk-loop.ps1. & pause & exit /b 1 )
echo   ok

echo.
echo === 2/6  Pre-granting camera access to %SITE% ===
REM  This is what removes the permission popup. Without it the browser asks
REM  the first time, and until someone answers, the capture card cannot even
REM  be listed - the device labels stay blank. As a policy it also survives
REM  the browser profile being wiped or rebuilt.
reg add "HKLM\SOFTWARE\Policies\Google\Chrome" /v VideoCaptureAllowed /t REG_DWORD /d 1 /f >nul
reg add "HKLM\SOFTWARE\Policies\Google\Chrome\VideoCaptureAllowedUrls" /v 1 /t REG_SZ /d "%SITE%" /f >nul
REM  Same again for Edge, in case that is the browser actually installed.
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v VideoCaptureAllowed /t REG_DWORD /d 1 /f >nul
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge\VideoCaptureAllowedUrls" /v 1 /t REG_SZ /d "%SITE%" /f >nul
echo   ok

echo.
echo === 3/6  Never sleep, never blank, never lock ===
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
REM  Do not demand a password when the display wakes.
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 >nul 2>&1
reg add "HKCU\Control Panel\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f >nul
reg add "HKCU\Control Panel\Desktop" /v ScreenSaverIsSecure /t REG_SZ /d 0 /f >nul
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization" /v NoLockScreen /t REG_DWORD /d 1 /f >nul
echo   ok

echo.
echo === 4/6  Keep Windows Update out of clinic hours (07:00-22:00) ===
REM  An unattended machine WILL be restarted by Windows Update eventually.
REM  Active hours do not stop the update, they stop the reboot happening
REM  mid-list. 18 hours is the maximum span Windows accepts.
reg add "HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" /v ActiveHoursStart /t REG_DWORD /d 7 /f >nul
reg add "HKLM\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings" /v ActiveHoursEnd /t REG_DWORD /d 22 /f >nul
echo   ok

echo.
echo === 5/6  Start the browser automatically at logon ===
REM  A scheduled task rather than the Startup folder: the Startup folder
REM  cannot delay, and a USB capture card is routinely not enumerated yet
REM  when the desktop appears. 30 seconds is comfortably enough; the page
REM  retries on its own anyway, so this only makes the FIRST try succeed.
schtasks /delete /tn "NoorMind Kiosk" /f >nul 2>&1
schtasks /create /tn "NoorMind Kiosk" ^
  /tr "\"%TARGET%\run-noormind-kiosk.cmd\"" ^
  /sc onlogon /rl highest /delay 0000:30 /f
if errorlevel 1 ( echo   FAILED to create the scheduled task. & pause & exit /b 1 )
echo   ok

echo.
echo === 6/6  Log Windows in by itself (no password at boot) ===
echo.
echo   READ THIS FIRST. From here on, anyone who can reach this keyboard is
echo   logged in as the clinic user - and therefore has the live camera and
echo   the patient recordings. That is the real price of a PC that needs
echo   nobody. Skip this step (answer N below) if that is not acceptable;
echo   everything else above still works, you just type a password at boot.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%enable-autologon.ps1"
set "ALRC=%ERRORLEVEL%"
if "%ALRC%"=="0" (
  echo   ok
) else if "%ALRC%"=="2" (
  echo   skipped - Windows will still ask for a password at boot.
) else (
  echo   FAILED. Automatic logon is NOT set up; everything else is.
)

echo.
echo ===========================================================================
echo   Almost done. One thing left that only you can do:
echo.
echo     SIGN IN ONCE at %SITE% in the kiosk browser, as the clinic
echo     account. The session then lasts a year and renews itself while the
echo     page is open, so this really is once - not every morning.
echo.
echo   Then restart the PC and do not touch the keyboard. It should log in,
echo   open full screen, and reach live detection on its own. That is the
echo   only test that counts.
echo.
echo   Need the normal sign-in screen back for one boot? Hold SHIFT while
echo   Windows starts.
echo ===========================================================================
echo.
echo   UNDO:
echo     schtasks /delete /tn "NoorMind Kiosk" /f
echo     reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon /t REG_SZ /d 0 /f
echo     reg delete "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword /f
echo     reg delete "HKLM\SOFTWARE\Policies\Google\Chrome\VideoCaptureAllowedUrls" /f
echo     reg delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\Personalization" /v NoLockScreen /f
echo     powercfg /change monitor-timeout-ac 15
echo.
pause
