; AsterBridge Windows installer recovery hooks.
; electron-builder calls customInit after MultiUser initialization and before upgrade removal.

!macro customInit
  ; Upgrade removal requires a runnable old uninstaller. A partial/corrupt installation can retain
  ; the launcher executable and both electron-builder registry keys while losing that uninstaller;
  ; electron-builder then aborts the new install before it can repair the files. Treat the registry
  ; entry as stale whenever neither the current nor legacy uninstaller exists. We remove only the
  ; installer registry metadata here, never the installation directory or user data, so the new
  ; package can overwrite/repair the existing launcher in place.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" asterbridge_stale_registration_done
  IfFileExists "$0\Uninstall AsterBridge.exe" asterbridge_stale_registration_done
  IfFileExists "$0\Uninstall Codex Web GPT.exe" asterbridge_stale_registration_done

  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"

  asterbridge_stale_registration_done:
!macroend
