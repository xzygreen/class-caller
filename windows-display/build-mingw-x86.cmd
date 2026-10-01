@echo off
rem 在 Windows 上用 i686 MinGW-w64 编译 32 位 display.exe（需要 PATH 中有 i686-w64-mingw32-gcc.exe）
setlocal
cd /d "%~dp0"

where i686-w64-mingw32-gcc.exe >nul 2>nul || (
  echo i686-w64-mingw32-gcc.exe was not found in PATH.
  exit /b 1
)

rem Windows 7 SP1 原版镜像没有 UCRT，exe 只能依赖系统自带的 msvcrt.dll：
rem mingw-w64 12 起默认改链 UCRT，GCC 15+ 用 -mcrtdll=msvcrt-os 选回 msvcrt；老版本工具链本身默认 msvcrt。
set CRT_FLAGS=
i686-w64-mingw32-gcc.exe --help=target 2>nul | findstr /c:"-mcrtdll=" >nul && set CRT_FLAGS=-mcrtdll=msvcrt-os

where i686-w64-mingw32-objdump.exe >nul 2>nul || (
  echo Required PE inspector i686-w64-mingw32-objdump.exe was not found in PATH.
  exit /b 1
)
if not exist build mkdir build
if exist build\display.exe del build\display.exe
pushd src
i686-w64-mingw32-windres.exe --input display.rc --output ..\build\display-res.o --output-format coff --target pe-i386
if errorlevel 1 (
  popd
  exit /b 1
)
popd
i686-w64-mingw32-gcc.exe -std=c11 -O2 -Wall -Wextra -municode -mwindows -static %CRT_FLAGS% ^
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 ^
  -Wl,--subsystem,windows:6.01 -o build\display-unchecked.exe src\display.c build\display-res.o ^
  -lwinhttp -lgdi32 -lmsimg32 -luser32 -lshell32 -ladvapi32
if errorlevel 1 exit /b %errorlevel%

i686-w64-mingw32-objdump.exe -p build\display-unchecked.exe >build\display-imports.txt
if errorlevel 1 goto rejected
findstr /i /c:"ucrtbase.dll" /c:"api-ms-win-crt-" build\display-imports.txt >nul
if not errorlevel 1 goto rejected
findstr /i /c:"msvcrt.dll" build\display-imports.txt >nul
if errorlevel 1 goto rejected
move /y build\display-unchecked.exe build\display.exe >nul
if errorlevel 1 exit /b 1
i686-w64-mingw32-objdump.exe -f build\display.exe
certutil -hashfile build\display.exe SHA256
exit /b %errorlevel%

:rejected
del build\display-unchecked.exe >nul 2>nul
echo ERROR: Win7 build requires verified msvcrt.dll imports and must not import UCRT.
exit /b 1
