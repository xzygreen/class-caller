#!/usr/bin/env bash
# 在 Linux/macOS 构建机上交叉编译 32 位 display.exe
#   macOS:  brew install mingw-w64
#   Debian: apt install gcc-mingw-w64-i686
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC="${CC:-i686-w64-mingw32-gcc}"
OBJDUMP="${OBJDUMP:-${CC%-gcc}-objdump}"
WINDRES="${WINDRES:-${CC%-gcc}-windres}"
command -v "$OBJDUMP" >/dev/null || { printf 'Required PE inspector not found: %s\n' "$OBJDUMP" >&2; exit 1; }
mkdir -p "$ROOT/build"
rm -f "$ROOT/build/display.exe"
(
  cd "$ROOT/src"
  "$WINDRES" --input display.rc --output "$ROOT/build/display-res.o" --output-format coff --target pe-i386
)

# Windows 7 SP1 原版镜像没有 UCRT（ucrtbase / api-ms-win-crt-*），exe 必须只依赖系统自带的 msvcrt.dll。
# mingw-w64 12 起（Homebrew 现版本）默认改链 UCRT；GCC 15+ 提供 -mcrtdll 选回 msvcrt，老版本工具链本身就默认 msvcrt。
CRT_FLAGS=""
# 先整体收下帮助文本再 grep：pipefail 下 grep -q 提前退出会让 gcc 收到 SIGPIPE，误判为不支持
TARGET_HELP="$("$CC" --help=target 2>/dev/null || true)"
if printf '%s' "$TARGET_HELP" | grep -q -- '-mcrtdll='; then
  CRT_FLAGS="-mcrtdll=msvcrt-os"
fi

# shellcheck disable=SC2086  # CRT_FLAGS 有意按空白拆分
"$CC" -std=c11 -O2 -Wall -Wextra -municode -mwindows -static $CRT_FLAGS \
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 \
  -Wl,--subsystem,windows:6.01 \
  -o "$ROOT/build/display-unchecked.exe" "$ROOT/src/display.c" "$ROOT/build/display-res.o" \
  -lwinhttp -lgdi32 -lmsimg32 -luser32 -lshell32 -ladvapi32

HEADERS="$("$OBJDUMP" -p "$ROOT/build/display-unchecked.exe")"
if grep -qiE 'DLL Name:.*(ucrtbase\.dll|api-ms-win-crt-)' <<< "$HEADERS" \
    || ! grep -qiE 'DLL Name:.*msvcrt\.dll' <<< "$HEADERS"; then
  rm -f "$ROOT/build/display-unchecked.exe"
  printf '%s\n' 'ERROR: Win7 build requires msvcrt.dll and must not import UCRT.' \
    'Use a msvcrt-default MinGW (Debian gcc-mingw-w64-i686) or -mcrtdll=msvcrt-os.' >&2
  exit 1
fi
mv "$ROOT/build/display-unchecked.exe" "$ROOT/build/display.exe"
file "$ROOT/build/display.exe"
"$OBJDUMP" -f "$ROOT/build/display.exe"
shasum -a 256 "$ROOT/build/display.exe" 2>/dev/null || sha256sum "$ROOT/build/display.exe"
