@echo off
schtasks /Delete /F /TN "ClassCallerDisplay" >nul 2>nul
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ClassCallerDisplay /f >nul 2>nul
echo Autostart entries removed.
pause
