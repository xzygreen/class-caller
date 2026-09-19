@echo off
setlocal
cd /d "%~dp0"
if not exist win7-launcher.exe (
  echo Missing: %CD%\win7-launcher.exe
  exit /b 1
)
if not exist win7-launcher.ini (
  echo Missing: %CD%\win7-launcher.ini
  echo Copy win7-launcher.ini.example and edit it first.
  exit /b 1
)
win7-launcher.exe --config "%CD%\win7-launcher.ini" --register-protocol
