@echo off
rem 手动启动 / 唤醒大屏。已在运行时，再次执行只会把窗口拉到最前。
cd /d "%~dp0"
if not exist display.exe (
  echo Missing: %CD%\display.exe
  pause
  exit /b 1
)
if not exist display.ini (
  echo Missing: %CD%\display.ini  ^(copy display.ini.example and edit server=^)
  pause
  exit /b 1
)
start "" "%CD%\display.exe" %*
