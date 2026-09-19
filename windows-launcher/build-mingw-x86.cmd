@echo off
setlocal
cd /d "%~dp0"

where i686-w64-mingw32-gcc.exe >nul 2>nul || (
  echo i686-w64-mingw32-gcc.exe was not found in PATH.
  exit /b 1
)

if not exist build mkdir build
i686-w64-mingw32-gcc.exe -std=c11 -O2 -Wall -Wextra -municode -mconsole -static ^
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 ^
  -Wl,--subsystem,console:6.01 -o build\win7-launcher.exe src\win7-launcher.c ^
  -lwinhttp -ladvapi32
if errorlevel 1 exit /b %errorlevel%

echo.
echo Built: %CD%\build\win7-launcher.exe
where i686-w64-mingw32-objdump.exe >nul 2>nul && i686-w64-mingw32-objdump.exe -f -p build\win7-launcher.exe
certutil -hashfile build\win7-launcher.exe SHA256
