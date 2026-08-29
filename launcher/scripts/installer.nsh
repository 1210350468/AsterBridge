; AsterBridge Windows installer recovery hooks.
; electron-builder calls customInit after MultiUser initialization and before upgrade removal.

!macro customInit
  ; A crashed/manual uninstall can leave both electron-builder registry keys behind after the
  ; installation directory has already disappeared. In that state electron-builder tries to copy
  ; and execute a non-existent old uninstaller and aborts the new install. Recover only when the
  ; recorded installation has none of the current/legacy launcher or uninstaller executables.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCmp $0 "" asterbridge_stale_registration_done
  IfFileExists "$0\AsterBridge.exe" asterbridge_stale_registration_done
  IfFileExists "$0\Codex Web GPT.exe" asterbridge_stale_registration_done
  IfFileExists "$0\Uninstall AsterBridge.exe" asterbridge_stale_registration_done
  IfFileExists "$0\Uninstall Codex Web GPT.exe" asterbridge_stale_registration_done

  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"

  asterbridge_stale_registration_done:
!macroend
