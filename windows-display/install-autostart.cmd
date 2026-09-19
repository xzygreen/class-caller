@echo off
rem 把 D 盘的 display.exe 注册为“当前用户登录时自动启动”。
rem 同时写两处（任务计划 + HKCU Run），任一生效即可。
rem 注意：这两处都保存在 C 盘/注册表里，学校若每次重启还原 C 盘，需要把本脚本
rem 放进母盘、登录脚本或 GPO 里重新执行（见 docs/windows-display.md 第 4 节）。
setlocal
set "EXE=%~dp0display.exe"
if not exist "%EXE%" (
  echo Missing: %EXE%
  pause
  exit /b 1
)

schtasks /Create /F /SC ONLOGON /RL LIMITED /TN "ClassCallerDisplay" ^
  /TR "\"%EXE%\"" >nul 2>nul
if errorlevel 1 (
  echo schtasks failed, falling back to HKCU Run key only.
) else (
  echo Scheduled task "ClassCallerDisplay" created (runs at logon).
)

reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ClassCallerDisplay ^
  /t REG_SZ /d "\"%EXE%\"" /f >nul
if errorlevel 1 (
  echo Failed to write HKCU Run key.
) else (
  echo HKCU Run key written.
)

echo.
echo Done. display.exe will start automatically at next logon.
pause
