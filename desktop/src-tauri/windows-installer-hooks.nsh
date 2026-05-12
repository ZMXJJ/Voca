!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's default "Delete app data" cleanup targets ${BUNDLEID}-based
  ; paths, but Voca stores its runtime/models/logs under %APPDATA%\Voca.
  ; Only remove these extra directories when the user explicitly opts in.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r /REBOOTOK "$APPDATA\Voca"
    RmDir /r /REBOOTOK "$LOCALAPPDATA\Voca"
  ${EndIf}
!macroend
