#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CC="${CC:-i686-w64-mingw32-gcc}"
OBJDUMP="${OBJDUMP:-${CC%-gcc}-objdump}"
WINDRES="${WINDRES:-${CC%-gcc}-windres}"
# Inspection is a release gate, not an optional diagnostic.
command -v "$OBJDUMP" >/dev/null || { printf 'Required PE inspector not found: %s\n' "$OBJDUMP" >&2; exit 1; }
mkdir -p "$ROOT/build"
rm -f "$ROOT/build/win7-launcher.exe"
(
  cd "$ROOT/src"
  "$WINDRES" --input win7-launcher.rc --output "$ROOT/build/launcher-res.o" --output-format coff --target pe-i386
)

# Stock Windows 7 SP1 has msvcrt, not UCRT. New MinGW defaults may use UCRT.
CRT_FLAGS=()
TARGET_HELP="$("$CC" --help=target 2>/dev/null || true)"
if grep -q -- '-mcrtdll=' <<< "$TARGET_HELP"; then
  CRT_FLAGS=(-mcrtdll=msvcrt-os)
fi
"$CC" -std=c11 -O2 -Wall -Wextra -municode -mconsole -static "${CRT_FLAGS[@]}" \
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0601 -DWINVER=0x0601 \
  -Wl,--subsystem,console:6.01 \
  -o "$ROOT/build/launcher-unchecked.exe" "$ROOT/src/win7-launcher.c" "$ROOT/build/launcher-res.o" \
  -lwinhttp -ladvapi32

HEADERS="$("$OBJDUMP" -p "$ROOT/build/launcher-unchecked.exe")"
if grep -qiE 'DLL Name:.*(ucrtbase\.dll|api-ms-win-crt-)' <<< "$HEADERS" \
    || ! grep -qiE 'DLL Name:.*msvcrt\.dll' <<< "$HEADERS"; then
  rm -f "$ROOT/build/launcher-unchecked.exe"
  printf '%s\n' 'ERROR: Win7 build requires msvcrt.dll and must not import UCRT.' \
    'Use a msvcrt-default MinGW (Debian gcc-mingw-w64-i686) or -mcrtdll=msvcrt-os.' >&2
  exit 1
fi
mv "$ROOT/build/launcher-unchecked.exe" "$ROOT/build/win7-launcher.exe"
file "$ROOT/build/win7-launcher.exe"
"$OBJDUMP" -f "$ROOT/build/win7-launcher.exe"
shasum -a 256 "$ROOT/build/win7-launcher.exe" 2>/dev/null || sha256sum "$ROOT/build/win7-launcher.exe"
