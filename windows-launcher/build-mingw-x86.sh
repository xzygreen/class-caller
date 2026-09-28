#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC="${CC:-i686-w64-mingw32-gcc}"
WINDRES="${WINDRES:-${CC%-gcc}-windres}"
mkdir -p "$ROOT/build"
(
  cd "$ROOT/src"
  "$WINDRES" --input win7-launcher.rc --output "$ROOT/build/launcher-res.o" --output-format coff --target pe-i386
)

"$CC" -std=c11 -O2 -Wall -Wextra -municode -mconsole -static \
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 \
  -Wl,--subsystem,console:6.01 \
  -o "$ROOT/build/win7-launcher.exe" "$ROOT/src/win7-launcher.c" "$ROOT/build/launcher-res.o" \
  -lwinhttp -ladvapi32

file "$ROOT/build/win7-launcher.exe"
sha256sum "$ROOT/build/win7-launcher.exe"
