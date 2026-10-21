; Kokon's additions to Tauri's NSIS installer (bundle > windows > nsis > installerHooks).
;  - Before installing, updating or uninstalling: stop the background processes (MCP servers,
;    kokon-service, sd-server) that keep Kokon's files locked. Tauri itself only closes Kokon.exe.
;  - After uninstalling: offer to delete the downloaded models and app data. Images in the
;    output folder (Pictures\Kokon) are never touched. The WebView's cache (hundreds of MB,
;    rebuilt on demand) always goes; its small UI preferences go with the app data.

; This folder, captured now (inside a macro, __FILEDIR__ is the file that uses it).
!define KOKON_HOOKS_DIR "${__FILEDIR__}"

!macro KOKON_STOP_PROCESSES
  Push $0
  Push $1
  InitPluginsDir
  File "/oname=$PLUGINSDIR\kokon-stop.ps1" "${KOKON_HOOKS_DIR}\kokon-stop.ps1"
  ; 64-bit PowerShell from the 32-bit installer (Sysnative), the plain path otherwise.
  StrCpy $1 "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${IfNot} ${FileExists} "$1"
    StrCpy $1 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  DetailPrint "Stopping Kokon's background processes..."
  nsExec::Exec '"$1" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\kokon-stop.ps1" -InstDir "$INSTDIR"'
  Pop $0
  Pop $1
  Pop $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro KOKON_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KOKON_STOP_PROCESSES
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Never during an update or a silent/passive uninstall: only when a person uninstalls.
  ${If} $UpdateMode <> 1
  ${AndIf} $PassiveMode <> 1
  ${AndIfNot} ${Silent}
    SetShellVarContext current
    ; WebView2 user data folder (named after the bundle identifier).
    RMDir /r "$LOCALAPPDATA\app.kokon.desktop\EBWebView\Default\Cache"
    RMDir /r "$LOCALAPPDATA\app.kokon.desktop\EBWebView\Default\Code Cache"
    RMDir /r "$LOCALAPPDATA\app.kokon.desktop\EBWebView\Default\GPUCache"
    ${IfNot} ${FileExists} "$LOCALAPPDATA\KokonData\*.*"
      RMDir /r "$LOCALAPPDATA\app.kokon.desktop"
    ${EndIf}
    ${If} ${FileExists} "$LOCALAPPDATA\KokonData\*.*"
      ${GetSize} "$LOCALAPPDATA\KokonData" "/S=0M /G=1" $0 $1 $2
      IntOp $1 $0 / 1024
      IntOp $2 $0 % 1024
      IntOp $2 $2 * 10
      IntOp $2 $2 / 1024
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete the AI models Kokon downloaded and its app data ($1.$2 GB)?$\r$\n$\r$\nThis frees the disk space. If you install Kokon again, it downloads the models again.$\r$\n$\r$\nYour images in the Kokon output folder (Pictures\Kokon by default) are kept either way.$\r$\n$\r$\nChoose No if you are reinstalling or updating Kokon." IDNO kokon_keep_data
      DetailPrint "Deleting Kokon's models and data..."
      RMDir /r "$LOCALAPPDATA\KokonData"
      RMDir /r "$LOCALAPPDATA\QwenLocalStudio"
      RMDir /r "$APPDATA\Kokon"
      RMDir /r "$LOCALAPPDATA\app.kokon.desktop"
      ${If} ${FileExists} "$LOCALAPPDATA\KokonData\*.*"
        MessageBox MB_OK|MB_ICONEXCLAMATION "Some files could not be deleted. You can delete this folder yourself:$\r$\n$LOCALAPPDATA\KokonData"
      ${EndIf}
      kokon_keep_data:
    ${EndIf}
  ${EndIf}
!macroend
