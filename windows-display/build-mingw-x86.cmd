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

if not exist build mkdir build
i686-w64-mingw32-gcc.exe -std=c11 -O2 -Wall -Wextra -municode -mwindows -static %CRT_FLAGS% ^
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 ^
  -Wl,--subsystem,windows:6.01 -o build\display.exe src\display.c ^
  -lwinhttp -lgdi32 -lmsimg32 -luser32 -lshell32 -ladvapi32
if errorlevel 1 exit /b %errorlevel%

echo.
echo Built: %CD%\build\display.exe
where i686-w64-mingw32-objdump.exe >nul 2>nul && (
  i686-w64-mingw32-objdump.exe -f build\display.exe
  i686-w64-mingw32-objdump.exe -p build\display.exe | findstr /i /c:"ucrtbase.dll" /c:"api-ms-win-crt-" >nul && (
    echo ERROR: display.exe depends on the Universal CRT and will not start on a stock Windows 7 SP1.
    exit /b 1
  )
)
certutil -hashfile build\display.exe SHA256
