@echo off
rem 在 Visual Studio 的 "x86 Native Tools Command Prompt" 中运行，生成严格的 PE32 x86 display.exe
setlocal
cd /d "%~dp0"
if not exist build mkdir build

cl /nologo /W4 /O2 /MT /utf-8 /D_WIN32_WINNT=0x0601 /DWINVER=0x0601 /DUNICODE /D_UNICODE ^
  src\display.c /Fe:build\display.exe /Fo:build\ ^
  /link /MACHINE:X86 /SUBSYSTEM:WINDOWS,6.01 /ENTRY:wWinMainCRTStartup ^
  winhttp.lib gdi32.lib msimg32.lib user32.lib shell32.lib advapi32.lib
if errorlevel 1 exit /b %errorlevel%

echo.
echo Built: %CD%\build\display.exe
dumpbin /headers build\display.exe | findstr /i "machine subsystem"
certutil -hashfile build\display.exe SHA256
