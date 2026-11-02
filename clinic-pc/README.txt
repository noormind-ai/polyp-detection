===========================================================================
  NoorMind - Clinic PC setup checklist
===========================================================================

  Do these in order, on the clinic PC.

  Written for this exact machine: a personal device (not joined to any
  organisation), signing in with a Microsoft account and a PIN.

  At the end: turn the PC on and it detects polyps. Turn it off at night.
  Nothing else.


---------------------------------------------------------------------------
  BEFORE YOU START
---------------------------------------------------------------------------

  * Capture card plugged in
  * PC on the internet
  * Chrome installed (Edge also works)
  * This whole folder copied onto the PC (the desktop is fine)

  Keep the folder together. The files need each other.


---------------------------------------------------------------------------
  STEP 1 - Nothing to download
---------------------------------------------------------------------------

  Autologon64.exe is ALREADY IN THIS FOLDER, downloaded from Microsoft
  Sysinternals with its signature verified. You do not need the internet
  for anything except the site itself.

  Why it is here: the setup script has to save the Windows password so the
  PC can log itself in. With this file present it stores it encrypted - the
  same way Windows stores service passwords - instead of as plain text in
  the registry.


---------------------------------------------------------------------------
  STEP 2 - Convert the account to a local account
---------------------------------------------------------------------------

      Settings  >  Accounts  >  Your info
                >  "Sign in with a local account instead"

  It asks for your PIN, then you choose a local username and password.

  WHY: otherwise the password this PC has to store is your MICROSOFT
  password - your email, OneDrive, everything - sitting on an unattended
  machine in a clinic. A local password is worth far less if it leaks. It
  also means a future Microsoft password change cannot silently stop the
  clinic PC from starting itself.

  WHAT STAYS THE SAME: your files, your desktop, your admin rights, and
  your PIN for everyday use. Only the sign-in identity changes.

  EXPECT: it signs you out at the end, and you will probably have to set
  the PIN up again afterwards.

    >>> WRITE THE NEW PASSWORD DOWN. It is your only admin account. <<<

  If that menu option is not there: skip this step, but FIRST turn off
  two-step verification on the Microsoft account, or automatic logon
  cannot work at all. The script will then ask for your Microsoft email
  and password instead, and will warn you before using them.


---------------------------------------------------------------------------
  STEP 3 - Run the setup script
---------------------------------------------------------------------------

  Right-click  setup-clinic-pc.cmd  >  Run as administrator

  Parts 1 to 5 run by themselves. Part 6 asks you three things:

    Windows username ....... press ENTER to accept the one shown

    Password ............... the LOCAL PASSWORD YOU CHOSE IN STEP 2.
                             NOT your PIN. Nothing appears on screen
                             as you type - that is normal.

    "continue with plain     This should not appear. If it does, it means
     text?" ................ Autologon64.exe went missing from the folder.
                             Answer N and tell me.

  It checks the password against Windows immediately. If you see
  "Password checked: correct" in green, you are good. If it says the
  password was rejected, you most likely typed the PIN.

  You can answer N to part 6 to skip automatic logon entirely. Everything
  else still works - you would just type a password each morning.


---------------------------------------------------------------------------
  STEP 4 - Sign in to the site, once
---------------------------------------------------------------------------

  The browser opens full screen on ir.noormind.me. Sign in with the clinic
  account.

  This is the ONLY time you ever do this. That session lasts a year and
  renews itself for as long as the page is open.


---------------------------------------------------------------------------
  STEP 5 - Restart, and do not touch anything
---------------------------------------------------------------------------

  Shut down. Power on. Hands off the keyboard.

  It should log into Windows, open full screen, and reach live detection
  on its own. That is the real test.


===========================================================================
  WHAT YOU END UP WITH
===========================================================================

  Power on  ->  Windows logs itself in  ->  browser opens full screen
            ->  capture card starts     ->  detection running

  No clicks, ever. And it looks after itself while running:

    Server restarted, or a network blip
        Reconnects on its own. The camera is never dropped meanwhile.

    Card unplugged, replugged, or the picture freezes
        Reopens the device by itself. After 3 failed tries it reloads
        the page, which rebuilds everything from scratch.

    Browser closed or crashed
        Reopens automatically within 5 seconds.

    Next patient
        Gets their own folder automatically, once the scope has been
        out of the body for a minute.


===========================================================================
  WORTH KNOWING
===========================================================================

  * ANYONE WHO CAN REACH THAT KEYBOARD is logged in as the clinic account,
    and therefore has the live camera and the recordings. That is the real
    cost of a PC that needs nobody. Decide it deliberately.

  * Need a normal sign-in screen for one boot?
    Hold SHIFT while Windows starts.

  * Do not delete C:\NoorMind\chrome-profile
    The site login, the kiosk setting and the remembered capture card all
    live in there. Delete it and you are back to a login screen.

  * To turn it all off:
        open  https://ir.noormind.me/?kiosk=0   once
        then  schtasks /delete /tn "NoorMind Kiosk" /f
    The full undo list prints at the end of the setup script.


===========================================================================
  IF SOMETHING DOES NOT COME UP
===========================================================================

  Press ALT+F4 to close the kiosk browser. It reopens after 5 seconds, so
  press it again quickly and use the gap to get to the desktop.

  Then tell me what you saw.

  Being straight with you: the server side of this is tested end to end,
  but THE WINDOWS SIDE HAS NEVER RUN ON A REAL MACHINE. The PowerShell is
  syntax-checked and the account detection is verified, but this first
  reboot is where it meets reality.


===========================================================================
  THE FILES IN THIS FOLDER
===========================================================================

  README.txt ................ this checklist

  setup-clinic-pc.cmd ....... the one you run, as administrator

  enable-autologon.ps1 ...... the automatic-logon part.
                              The script above calls it; you do not.

  run-noormind-kiosk.cmd .... opens the browser and keeps it open.
                              Never run this by hand.

  Autologon64.exe ........... Microsoft Sysinternals. Used by the script
  Autologon.exe               to store the password encrypted.

  Eula.txt .................. Microsoft's licence for those two.
