#!/usr/bin/env bash
# 在 Linux/macOS 构建机上交叉编译 32 位 display.exe
#   macOS:  brew install mingw-w64
#   Debian: apt install gcc-mingw-w64-i686
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC="${CC:-i686-w64-mingw32-gcc}"
OBJDUMP="${OBJDUMP:-${CC%-gcc}-objdump}"
mkdir -p "$ROOT/build"

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
  -o "$ROOT/build/display.exe" "$ROOT/src/display.c" \
  -lwinhttp -lgdi32 -lmsimg32 -luser32 -lshell32 -ladvapi32

file "$ROOT/build/display.exe" || true
if command -v "$OBJDUMP" >/dev/null 2>&1; then
  "$OBJDUMP" -f "$ROOT/build/display.exe" | grep -E 'file format|architecture'
  DLLS="$("$OBJDUMP" -p "$ROOT/build/display.exe" | awk '/DLL Name:/{print $3}')"
  echo "imports: $(echo "$DLLS" | tr '\n' ' ')"
  if echo "$DLLS" | grep -qiE '^(ucrtbase\.dll|api-ms-win-crt-)'; then
    echo "ERROR: display.exe depends on the Universal CRT and will not start on a stock Windows 7 SP1." >&2
    echo "       Use a msvcrt-default MinGW-w64 (Debian gcc-mingw-w64-i686) or GCC >= 15 (-mcrtdll=msvcrt-os)." >&2
    exit 1
  fi
fi
shasum -a 256 "$ROOT/build/display.exe" 2>/dev/null || sha256sum "$ROOT/build/display.exe"
