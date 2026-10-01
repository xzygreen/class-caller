@echo off
setlocal
cd /d "%~dp0"

for %%T in (gcc windres objdump) do (
  where i686-w64-mingw32-%%T.exe >nul 2>nul || (
    echo Required tool i686-w64-mingw32-%%T.exe was not found in PATH.
    exit /b 1
  )
)
rem Stock Win7 SP1 has msvcrt, not UCRT. Select it on newer toolchains.
set CRT_FLAGS=
i686-w64-mingw32-gcc.exe --help=target 2>nul | findstr /c:"-mcrtdll=" >nul && set CRT_FLAGS=-mcrtdll=msvcrt-os
if not exist build mkdir build
if exist build\win7-launcher.exe del build\win7-launcher.exe
pushd src
i686-w64-mingw32-windres.exe --input win7-launcher.rc --output ..\build\launcher-res.o --output-format coff --target pe-i386
if errorlevel 1 (
  popd
  exit /b 1
)
popd
i686-w64-mingw32-gcc.exe -std=c11 -O2 -Wall -Wextra -municode -mconsole -static %CRT_FLAGS% ^
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 ^
  -Wl,--subsystem,console:6.01 -o build\launcher-unchecked.exe src\win7-launcher.c build\launcher-res.o ^
  -lwinhttp -ladvapi32
if errorlevel 1 exit /b %errorlevel%

i686-w64-mingw32-objdump.exe -p build\launcher-unchecked.exe >build\launcher-imports.txt
if errorlevel 1 goto rejected
findstr /i /c:"ucrtbase.dll" /c:"api-ms-win-crt-" build\launcher-imports.txt >nul
if not errorlevel 1 goto rejected
findstr /i /c:"msvcrt.dll" build\launcher-imports.txt >nul
if errorlevel 1 goto rejected
move /y build\launcher-unchecked.exe build\win7-launcher.exe >nul
if errorlevel 1 exit /b 1
i686-w64-mingw32-objdump.exe -f build\win7-launcher.exe
certutil -hashfile build\win7-launcher.exe SHA256
exit /b %errorlevel%

:rejected
del build\launcher-unchecked.exe >nul 2>nul
echo ERROR: Win7 build requires verified msvcrt.dll imports and must not import UCRT.
exit /b 1
