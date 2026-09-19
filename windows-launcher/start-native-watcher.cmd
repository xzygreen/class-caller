@echo off
setlocal
cd /d "%~dp0"

rem 原生监听只监听一个班的事件流：把 class-a 换成本教室的班级 id（class-b / class-c / class-d）
set "STREAM_URL=https://example.com/api/classes/class-a/public/stream?role=launcher"
if not "%~1"=="" set "STREAM_URL=%~1"

if not exist win7-launcher.exe (
  echo Missing: %CD%\win7-launcher.exe
  exit /b 1
)
if not exist win7-launcher.ini (
  echo Missing: %CD%\win7-launcher.ini
  echo Copy win7-launcher.ini.example and edit it first.
  exit /b 1
)

echo Connecting to %STREAM_URL%
win7-launcher.exe --config "%CD%\win7-launcher.ini" --watch "%STREAM_URL%"
