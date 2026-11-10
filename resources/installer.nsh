; Custom pages for the Windows (NSIS) installer. electron-builder includes this
; file automatically because it sits in the build resources folder
; (directories.buildResources in electron-builder.yml). The same file is also
; compiled into the uninstaller, so everything installer-only is guarded by
; BUILD_UNINSTALLER: an unused variable or function would be a warning, and
; electron-builder treats NSIS warnings as errors.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  ; "1" creates the desktop shortcut and "0" removes it. It starts as "1" so a
  ; silent install (/S), which never shows the page, keeps the shortcut.
  Var StatekeepDesktopShortcut
  Var StatekeepDesktopShortcutBox

  !macro customInit
    StrCpy $StatekeepDesktopShortcut "1"
  !macroend

  ; electron-builder's assisted installer has no welcome page of its own. The
  ; license page comes next; Statekeep is MIT licensed, so that page is shown
  ; for information with a Next button instead of "I Agree". These defines
  ; apply to the next MUI page only.
  !macro customWelcomePage
    !insertmacro MUI_PAGE_WELCOME
    !define MUI_LICENSEPAGE_BUTTON "$(^NextBtn)"
    !define MUI_LICENSEPAGE_TEXT_BOTTOM "$(^Name) is open source software under the MIT License. Click Next to continue."
  !macroend

  ; Inserted by electron-builder's assisted installer after the destination
  ; folder page and before files are installed.
  !macro customPageAfterChangeDir
    Page custom StatekeepShortcutPageCreate StatekeepShortcutPageLeave

    Function StatekeepShortcutPageCreate
      ; Automatic updates (--updated) keep the existing shortcuts.
      ${if} ${isUpdated}
        Abort
      ${endIf}

      !insertmacro MUI_HEADER_TEXT "Choose shortcuts" "Choose which shortcuts Setup creates for $(^Name)."

      nsDialogs::Create 1018
      Pop $0
      ${if} $0 == error
        Abort
      ${endIf}

      ${NSD_CreateLabel} 0 0 100% 24u "Setup always adds $(^Name) to the Start menu. It can also add a shortcut to your desktop."
      Pop $0

      ${NSD_CreateCheckbox} 0 32u 100% 12u "Create a &desktop shortcut"
      Pop $StatekeepDesktopShortcutBox
      ${if} $StatekeepDesktopShortcut == "1"
        ${NSD_Check} $StatekeepDesktopShortcutBox
      ${endIf}

      nsDialogs::Show
    FunctionEnd

    Function StatekeepShortcutPageLeave
      ${NSD_GetState} $StatekeepDesktopShortcutBox $0
      ${if} $0 == ${BST_CHECKED}
        StrCpy $StatekeepDesktopShortcut "1"
      ${else}
        StrCpy $StatekeepDesktopShortcut "0"
      ${endIf}
    FunctionEnd
  !macroend

  ; Runs at the end of the install section, after electron-builder has created
  ; the shortcuts. The uninstaller deletes the desktop shortcut only if it
  ; exists, so removing it here is safe.
  !macro customInstall
    ${if} $StatekeepDesktopShortcut == "0"
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${endIf}
  !macroend
!endif
