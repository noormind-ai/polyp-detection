<#
  NoorMind clinic PC - log Windows in by itself.

  Called by setup-clinic-pc.cmd. Run it directly only if you need to redo
  just this step.

  ---------------------------------------------------------------------------
  A PIN WILL NOT WORK HERE. IT ASKS FOR THE ACCOUNT PASSWORD.
  ---------------------------------------------------------------------------
  A Windows Hello PIN is not a password: it exists only on this one machine
  and only unlocks while a person is present (the TPM enforces that). Windows
  cannot replay it to log itself in. Automatic logon needs the real account
  password - the one sitting behind the PIN.

  Being an administrator does not avoid this. Admin rights let the script
  WRITE the setting; Windows still needs a credential to DO the logon.

  ---------------------------------------------------------------------------
  IF THIS PC SIGNS IN WITH A MICROSOFT ACCOUNT, CONVERT IT TO A LOCAL ONE.
  ---------------------------------------------------------------------------
  It is technically possible to auto-logon a Microsoft account, and this
  script will do it if you insist. You should not, for three reasons:

    * the password it has to store is your MICROSOFT account password - the
      one for your email, OneDrive and everything else. Without Autologon.exe
      that goes into the registry in plain text, on an unattended PC in a
      clinic. A local account password is worth far less if it leaks.
    * two-step verification on the Microsoft account defeats it entirely.
    * if that password is ever changed - anywhere, on any device, or because
      Microsoft asks - the clinic PC quietly stops logging itself in, and
      nobody finds out until a patient is on the table.

  Converting keeps everything: same files, same desktop, same browser
  profile, same PIN for people. You just choose a password.

      Settings > Accounts > Your info > "Sign in with a local account instead"

  Do that first, then run this script.

  ---------------------------------------------------------------------------
  Two ways to store the password, and this prefers the better one:

    Autologon.exe   Sysinternals. Stores it as an encrypted LSA secret - the
                    same way Windows stores service passwords. Used
                    automatically if Autologon64.exe or Autologon.exe is
                    sitting next to this script.
                      https://learn.microsoft.com/sysinternals/downloads/autologon

    registry        The fallback. Windows reads the password from
                    DefaultPassword under Winlogon, IN PLAIN TEXT. Any
                    administrator on this PC can read it back.

  Either way, a PC that logs itself in is a PC that anyone who can reach the
  keyboard is logged in to. In this room that means the live camera and the
  recordings. That is the trade for a machine nobody has to operate.

  To get a normal sign-in screen once: hold SHIFT while Windows starts.
#>

$ErrorActionPreference = 'Stop'
$WINLOGON = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '  Not running as Administrator.' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  Which account should the PC log into automatically?'
$defaultUser = $env:USERNAME
$account = Read-Host "  Windows username [$defaultUser]"
if ([string]::IsNullOrWhiteSpace($account)) { $account = $defaultUser }

# Local account or Microsoft account? PrincipalSource answers it directly, and
# the two need different things written: a Microsoft account logs on as
# MicrosoftAccount\<full email>, not as the short local name Windows shows you.
$source = 'Local'
try {
    $source = (Get-LocalUser -Name $account -ErrorAction Stop).PrincipalSource
} catch {
    Write-Host "  (Could not look up '$account' locally - treating it as a domain account.)" -ForegroundColor Yellow
    $source = 'Unknown'
}

$user   = $account
$domain = $env:COMPUTERNAME

if ($source -eq 'MicrosoftAccount') {
    Write-Host ''
    Write-Host '  ------------------------------------------------------------------' -ForegroundColor Yellow
    Write-Host "  '$account' is a MICROSOFT ACCOUNT." -ForegroundColor Yellow
    Write-Host '  ------------------------------------------------------------------' -ForegroundColor Yellow
    Write-Host '  Strongly recommended: convert it to a local account first, then'
    Write-Host '  run this again. It keeps your files, desktop, browser profile and'
    Write-Host '  PIN - you only choose a password:'
    Write-Host ''
    Write-Host '      Settings > Accounts > Your info'
    Write-Host '        > "Sign in with a local account instead"' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '  Why it matters here:'
    Write-Host '    - the password stored would be your MICROSOFT password (email,'
    Write-Host '      OneDrive, everything), on an unattended PC in a clinic'
    Write-Host '    - two-step verification on the account defeats auto-logon'
    Write-Host '    - any future password change silently stops the clinic PC from'
    Write-Host '      logging itself in, and you find out at 8am'
    Write-Host ''
    $cont = Read-Host '  Continue with the Microsoft account anyway? (y/N)'
    if ($cont -notmatch '^[Yy]') {
        Write-Host '  Stopped. Nothing was changed. Convert the account and re-run.' -ForegroundColor Green
        exit 2
    }
    $email = Read-Host '  Full Microsoft account email address'
    if ([string]::IsNullOrWhiteSpace($email)) { Write-Host '  No email given. Stopped.'; exit 2 }
    $user   = $email.Trim()
    $domain = 'MicrosoftAccount'
} elseif ($source -eq 'Unknown') {
    $defaultDomain = if ($env:USERDOMAIN) { $env:USERDOMAIN } else { $env:COMPUTERNAME }
    $domain = Read-Host "  Domain or computer name [$defaultDomain]"
    if ([string]::IsNullOrWhiteSpace($domain)) { $domain = $defaultDomain }
}

Write-Host ''
Write-Host '  Now the PASSWORD for that account - NOT the Windows Hello PIN.' -ForegroundColor Yellow
if ($domain -eq 'MicrosoftAccount') {
    Write-Host '  This is your Microsoft account password (the one for the email' -ForegroundColor Yellow
    Write-Host '  address above), not anything set on this PC.' -ForegroundColor Yellow
}
Write-Host '  (Nothing appears as you type. Leave empty if there is no password.)'
$secure = Read-Host "  Password for $domain\$user" -AsSecureString
$plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

# Check it BEFORE writing it. A wrong password is otherwise not discovered
# until the next boot, when the PC sits on a sign-in screen in front of a
# patient. Only local accounts can be checked here; a Microsoft account is
# validated by Microsoft, so that case is reported as "cannot check", never
# as "wrong".
if ($source -eq 'Local') {
    try {
        Add-Type -AssemblyName System.DirectoryServices.AccountManagement
        $ctx = New-Object System.DirectoryServices.AccountManagement.PrincipalContext('Machine', $env:COMPUTERNAME)
        if ($ctx.ValidateCredentials($user, $plain)) {
            Write-Host '  Password checked: correct.' -ForegroundColor Green
        } else {
            Write-Host ''
            Write-Host '  That password was REJECTED by Windows.' -ForegroundColor Red
            Write-Host '  If you typed your PIN, that is why - it needs the password.' -ForegroundColor Red
            $anyway = Read-Host '  Write it anyway? (y/N)'
            if ($anyway -notmatch '^[Yy]') { Write-Host '  Stopped. Nothing was changed.'; exit 2 }
        }
    } catch {
        Write-Host "  (Could not verify the password: $($_.Exception.Message))" -ForegroundColor Yellow
    }
} else {
    Write-Host '  (Cannot be checked from here - you will find out at the next boot.)' -ForegroundColor Yellow
}

# Windows 11 ships with "require Windows Hello for Microsoft accounts" on, and
# that silently defeats automatic logon - it is also what hides the checkbox
# in netplwiz. Turning it off is a prerequisite, not an extra. People can
# carry on signing in with their PIN; this only re-allows the password path.
New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' `
                 -Name 'DevicePasswordLessBuildVersion' -Value 0 -Type DWord

# A blank-password local account can log on automatically, but only if Windows
# is not restricting blank passwords to the sign-in screen.
if ([string]::IsNullOrEmpty($plain)) {
    Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Lsa' `
                     -Name 'LimitBlankPasswordUse' -Value 0 -Type DWord
}

# Prefer the 64-bit build; fall back to the 32-bit one, which also runs on a
# 64-bit Windows. Both are shipped in this folder, signed by Microsoft.
$tool = @('Autologon64.exe', 'Autologon64a.exe', 'Autologon.exe') |
        ForEach-Object { Join-Path $PSScriptRoot $_ } |
        Where-Object { Test-Path $_ } |
        Select-Object -First 1 |
        ForEach-Object { Get-Item $_ }

if ($tool) {
    Write-Host ''
    Write-Host "  Using $($tool.Name) - the password is stored encrypted (LSA secret)." -ForegroundColor Green
    & $tool.FullName /accepteula $user $domain $plain | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host '  Autologon.exe reported a failure.' -ForegroundColor Red; exit 1 }
    Remove-ItemProperty -Path $WINLOGON -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
} else {
    Write-Host ''
    Write-Host '  Autologon.exe is not next to this script, so the password will be' -ForegroundColor Yellow
    Write-Host '  stored in the registry IN PLAIN TEXT. Any administrator on this PC' -ForegroundColor Yellow
    Write-Host '  can read it. Download Autologon from Sysinternals, put the .exe in' -ForegroundColor Yellow
    Write-Host '  this folder, and run this script again to avoid that:' -ForegroundColor Yellow
    Write-Host '      https://learn.microsoft.com/sysinternals/downloads/autologon' -ForegroundColor Yellow
    if ($domain -eq 'MicrosoftAccount') {
        Write-Host ''
        Write-Host '  NOTE: that would be your MICROSOFT password in plain text.' -ForegroundColor Red
    }
    Write-Host ''
    $go = Read-Host '  Continue with the plain-text method? (y/N)'
    if ($go -notmatch '^[Yy]') { Write-Host '  Skipped. Windows will still ask at boot.'; exit 2 }

    Set-ItemProperty -Path $WINLOGON -Name 'AutoAdminLogon'    -Value '1'     -Type String
    Set-ItemProperty -Path $WINLOGON -Name 'DefaultUserName'   -Value $user   -Type String
    Set-ItemProperty -Path $WINLOGON -Name 'DefaultDomainName' -Value $domain -Type String
    if ([string]::IsNullOrEmpty($plain)) {
        Remove-ItemProperty -Path $WINLOGON -Name 'DefaultPassword' -ErrorAction SilentlyContinue
    } else {
        Set-ItemProperty -Path $WINLOGON -Name 'DefaultPassword' -Value $plain -Type String
    }
    # Without this, signing out shows the login screen and the PC sits there
    # until someone comes back - which is the whole failure we are removing.
    Set-ItemProperty -Path $WINLOGON -Name 'ForceAutoLogon' -Value '1' -Type String
    Remove-ItemProperty -Path $WINLOGON -Name 'AutoLogonCount' -ErrorAction SilentlyContinue
}

$plain = $null
[GC]::Collect()

Write-Host ''
Write-Host "  Automatic logon enabled for $domain\$user." -ForegroundColor Green
Write-Host '  The PIN still works for people; this only adds the unattended path.'
Write-Host '  Hold SHIFT while Windows starts if you ever need the sign-in screen back.'
exit 0
