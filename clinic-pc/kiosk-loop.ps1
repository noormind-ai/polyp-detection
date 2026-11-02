<#
  NoorMind clinic PC - keep the kiosk browser open.

  Started by run-noormind-kiosk.cmd, which the "NoorMind Kiosk" scheduled task
  runs at logon. Do not run this by hand except to test.

  WHY THIS IS POWERSHELL NOW
  --------------------------
  The first version was a batch loop using `start "" /wait chrome.exe ...`.
  That does not reliably wait: Chrome's launcher process can hand off and exit
  immediately, so `/wait` returned at once and the loop relaunched the browser
  every five seconds. The window never settled, every page load started over,
  and the login form was impossible to fill in - which is exactly what
  happened in the clinic on 2026-10-28.

  Start-Process -PassThru gives a handle to the process actually started, and
  WaitForExit() on that handle waits for that one process and nothing else.

  It also writes C:\NoorMind\kiosk.log, so if the browser is restarting for
  some other reason the evidence is on disk rather than guessed at.
#>

$ErrorActionPreference = 'Continue'

# ?kiosk=1 is harmless to repeat: it sets a flag in the browser's own storage
# and the page behaves identically with or without it afterwards. Passed every
# time on purpose, so a rebuilt profile still comes up in kiosk mode.
$URL     = 'https://ir.noormind.me/?kiosk=1'
$PROFILE_DIR = 'C:\NoorMind\chrome-profile'
$LOG     = 'C:\NoorMind\kiosk.log'

function Log($msg) {
    $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    try { Add-Content -Path $LOG -Value $line -ErrorAction SilentlyContinue } catch { }
}

if (-not (Test-Path $PROFILE_DIR)) { New-Item -ItemType Directory -Path $PROFILE_DIR -Force | Out-Null }

$candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Log 'No Chrome or Edge found. Giving up.'; exit 1 }
Log "Using $browser"

$args = @(
    '--kiosk'
    '--start-fullscreen'
    "--user-data-dir=$PROFILE_DIR"
    '--disable-session-crashed-bubble'
    '--hide-crash-restore-bubble'
    '--noerrdialogs'
    '--disable-infobars'
    '--no-first-run'
    '--no-default-browser-check'
    '--autoplay-policy=no-user-gesture-required'
    '--password-store=basic'
    '--disable-features=TranslateUI,Translate'
    $URL
)

# If the browser dies immediately, something is wrong and relaunching hard in a
# tight circle only makes it harder to get to the desktop and fix it. Back off.
$shortRuns = 0

while ($true) {
    $started = Get-Date
    try {
        $p = Start-Process -FilePath $browser -ArgumentList $args -PassThru -ErrorAction Stop
        Log "Launched, pid $($p.Id)"
        $p.WaitForExit()
    } catch {
        Log "Could not launch: $($_.Exception.Message)"
    }
    $ranFor = [int]((Get-Date) - $started).TotalSeconds
    Log "Browser exited after ${ranFor}s"

    if ($ranFor -lt 15) { $shortRuns++ } else { $shortRuns = 0 }
    # 5s normally; up to a minute if it keeps dying, so there is a usable gap
    # to reach the desktop with nothing but a mouse.
    $wait = if ($shortRuns -ge 3) { 60 } else { 5 }
    if ($shortRuns -ge 3) { Log "Exited quickly $shortRuns times - waiting ${wait}s so the desktop is reachable" }
    Start-Sleep -Seconds $wait
}
