; Only migrate the known, per-user installation produced by the previous installer.
; Keep its settings and never execute an uninstall command string from the registry.
!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  ReadRegStr $0 HKCU "Software\425ddd3d-3ae7-5130-a14e-d9f70edfb11c" "InstallLocation"
  StrCmp $0 "$LOCALAPPDATA\Programs\local-dashboard" 0 dashboard_migration_done
  IfFileExists "$0\Localhost Dashboard.exe" 0 dashboard_migration_done
  IfFileExists "$0\Uninstall Localhost Dashboard.exe" 0 dashboard_migration_done
  IfFileExists "$0\resources\app.asar" 0 dashboard_migration_done
  ; Run a temporary copy, matching the legacy installer's own upgrade procedure.
  InitPluginsDir
  ClearErrors
  CopyFiles /SILENT "$0\Uninstall Localhost Dashboard.exe" "$PLUGINSDIR\previous-dashboard-uninstaller.exe"
  IfErrors dashboard_migration_failed
  ExecWait '"$PLUGINSDIR\previous-dashboard-uninstaller.exe" /S --updated _?=$0' $1
  IfErrors dashboard_migration_failed
  IntCmp $1 0 dashboard_migration_done dashboard_migration_failed dashboard_migration_failed
  dashboard_migration_failed:
    Abort "Close Localhost Dashboard and retry the installation."
  dashboard_migration_done:
  Pop $1
  Pop $0
!macroend
