@echo off
rem Prefer one scheduled task; fall back to HKCU Run only if task creation fails.
rem Both mechanisms use --autostart: repeated automatic starts never restore the window.
rem Entries live on C: even when the executable is on D:; see the deployment guide.
setlocal
set "EXE=%~dp0display.exe"
set "RUNKEY=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
if not exist "%EXE%" (
  echo Missing: %EXE%
  exit /b 1
)

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "ClassCallerDisplay" ^
  /TR "\"%EXE%\" --autostart" >nul 2>nul
if errorlevel 1 goto fallback

rem Remove the legacy duplicate registration after the task has been installed.
reg query "%RUNKEY%" /v ClassCallerDisplay >nul 2>nul
if errorlevel 1 goto task_done
reg delete "%RUNKEY%" /v ClassCallerDisplay /f >nul 2>nul
if errorlevel 1 (
  echo Failed to remove the legacy HKCU Run entry. No successful migration reported.
  echo Remove ClassCallerDisplay from HKCU Run and rerun this script.
  exit /b 1
)
:task_done
echo Scheduled task ClassCallerDisplay installed. HKCU Run is not used.
exit /b 0

:fallback
rem A previous task may still exist after a failed update. Do not leave two owners.
schtasks /Query /TN "ClassCallerDisplay" >nul 2>nul
if errorlevel 1 goto write_run
schtasks /Delete /F /TN "ClassCallerDisplay" >nul 2>nul
if errorlevel 1 (
  echo Could not remove the old scheduled task. HKCU Run was not added.
  exit /b 1
)
:write_run
reg add "%RUNKEY%" /v ClassCallerDisplay /t REG_SZ /d "\"%EXE%\" --autostart" /f >nul
if errorlevel 1 (
  echo Failed to write HKCU Run. Autostart installation failed.
  exit /b 1
)
echo Scheduled task unavailable; installed HKCU Run only.
exit /b 0
