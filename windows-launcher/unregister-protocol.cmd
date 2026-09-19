@echo off
setlocal
cd /d "%~dp0"
if not exist win7-launcher.exe (
  echo Missing: %CD%\win7-launcher.exe
  exit /b 1
)
win7-launcher.exe --unregister-protocol
