#ifndef CC_PORTABLE_WIN_TYPES_H
#define CC_PORTABLE_WIN_TYPES_H
/* Test-only types/string shims. No Win32 I/O, processes, registry or UI is simulated.
 * The production parsers explicitly emit UTF-16 surrogate units, so their unit
 * counts remain Windows-compatible even on hosts with a 32-bit wchar_t.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <wchar.h>
typedef wchar_t WCHAR;
typedef size_t SIZE_T;
typedef uint32_t DWORD;
typedef uint64_t ULONGLONG;
typedef uint16_t INTERNET_PORT;
#define MAX_PATH 260
#define SUCCEEDED(hr) ((hr) >= 0)
#define _stricmp strcasecmp

static int StringCchCopyW(WCHAR *out, SIZE_T capacity, const WCHAR *in)
{
    SIZE_T length = wcslen(in);
    if (!capacity) return -1;
    if (length >= capacity) { out[0] = 0; return -1; }
    memcpy(out, in, (length + 1) * sizeof(*out));
    return 0;
}

static int _wcsnicmp(const WCHAR *a, const WCHAR *b, SIZE_T count)
{
    SIZE_T i;
    for (i = 0; i < count; ++i) {
        WCHAR x = a[i], y = b[i];
        if (x >= L'A' && x <= L'Z') x += L'a' - L'A';
        if (y >= L'A' && y <= L'Z') y += L'a' - L'A';
        if (x != y) return x < y ? -1 : 1;
        if (!x) return 0;
    }
    return 0;
}

static char *contract_input(SIZE_T *length)
{
    char *input = (char *)malloc(65537);
    if (!input) exit(70);
    *length = fread(input, 1, 65536, stdin);
    if (ferror(stdin) || !feof(stdin) || memchr(input, 0, *length)) exit(2);
    input[*length] = 0;
    return input;
}

static WCHAR *contract_ascii(const char *input)
{
    SIZE_T i, length = strlen(input);
    WCHAR *wide = (WCHAR *)malloc((length + 1) * sizeof(*wide));
    if (!wide) exit(70);
    for (i = 0; i <= length; ++i) wide[i] = (unsigned char)input[i];
    return wide;
}
#endif
