@echo off
setlocal
cd /d "%~dp0"

where cl.exe >nul 2>nul || (
  echo Run this script from an "x86 Native Tools Command Prompt for VS".
  exit /b 1
)

if not exist build mkdir build
cl.exe /nologo /W4 /O2 /MT /TC /DUNICODE /D_UNICODE /D_WIN32_WINNT=0x0601 /DWINVER=0x0601 ^
  /Fe:build\win7-launcher.exe src\win7-launcher.c ^
  /link /MACHINE:X86 /SUBSYSTEM:CONSOLE,6.01 advapi32.lib winhttp.lib
if errorlevel 1 exit /b %errorlevel%

echo.
echo Built: %CD%\build\win7-launcher.exe
where dumpbin.exe >nul 2>nul && dumpbin.exe /headers build\win7-launcher.exe | findstr /i /c:"14C machine" /c:"32 bit word machine" /c:"subsystem"
certutil -hashfile build\win7-launcher.exe SHA256
