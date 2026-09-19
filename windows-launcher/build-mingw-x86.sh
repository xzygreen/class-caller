#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC="${CC:-i686-w64-mingw32-gcc}"
mkdir -p "$ROOT/build"

"$CC" -std=c11 -O2 -Wall -Wextra -municode -mconsole -static \
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 \
  -Wl,--subsystem,console:6.01 \
  -o "$ROOT/build/win7-launcher.exe" "$ROOT/src/win7-launcher.c" \
  -lwinhttp -ladvapi32

file "$ROOT/build/win7-launcher.exe"
sha256sum "$ROOT/build/win7-launcher.exe"
