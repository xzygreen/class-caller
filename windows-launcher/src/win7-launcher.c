#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef WINVER
#define WINVER 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE

#include <windows.h>
#include <winhttp.h>
#include <strsafe.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#define WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 0x00000800
#endif

#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "winhttp.lib")

#define CC_PATH_CHARS MAX_PATH
#define CC_MAX_PAYLOAD_CHARS 8192
#define CC_MAX_JSON_BYTES 6144
#define CC_MAX_SSE_LINE_BYTES 16384
#define CC_MAX_SSE_DATA_BYTES 16384
#define CC_MAX_STATE_IDS 256
#define CC_STATE_HEADER "classcaller-state-v1\n"
#define CC_UUID_CHARS 36
#define CC_DIRECT_FUTURE_SKEW_MS 5000ULL
#define CC_MIN_FRESH_SECONDS 5UL
#define CC_MAX_FRESH_SECONDS 300UL
#define CC_DEFAULT_FRESH_SECONDS 30UL

#define CC_EXIT_OK 0
#define CC_EXIT_INPUT 2
#define CC_EXIT_STATE 3
#define CC_EXIT_LAUNCH 4
#define CC_EXIT_REGISTRY 5
#define CC_EXIT_NETWORK 6

typedef struct Config {
    WCHAR ini_path[CC_PATH_CHARS];
    WCHAR target_path[CC_PATH_CHARS];
    WCHAR working_directory[CC_PATH_CHARS];
    WCHAR state_path[CC_PATH_CHARS];
    DWORD fresh_seconds;
} Config;

typedef struct PayloadInfo {
    char delivery_id[CC_UUID_CHARS + 1];
    char record_id[CC_UUID_CHARS + 1];
    ULONGLONG issued_at;
} PayloadInfo;

typedef struct JsonParser {
    const unsigned char *data;
    SIZE_T length;
    SIZE_T pos;
    const char *error;
    int depth;
} JsonParser;

typedef struct StateData {
    SIZE_T count;
    char ids[CC_MAX_STATE_IDS][CC_UUID_CHARS + 1];
} StateData;

typedef struct WatchEnvelope {
    char type[8];
    char delivery_id[CC_UUID_CHARS + 1];
    char launch_payload[CC_MAX_PAYLOAD_CHARS + 1];
    ULONGLONG launch_valid_until;
    ULONGLONG server_time;
} WatchEnvelope;

typedef struct WatchUrl {
    WCHAR host[256];
    WCHAR object[2048];
    INTERNET_PORT port;
    int secure;
} WatchUrl;

typedef struct SseParser {
    char line[CC_MAX_SSE_LINE_BYTES + 1];
    SIZE_T line_length;
    int line_overflow;
    int previous_was_cr;
    int first_line;
    char data[CC_MAX_SSE_DATA_BYTES + 1];
    SIZE_T data_length;
    int frame_invalid;
    DWORD retry_ms;
    const Config *config;
} SseParser;

static volatile LONG g_stop_requested = 0;

static void print_usage(void)
{
    fwprintf(stderr,
        L"ClassCaller Windows launcher\n\n"
        L"Usage:\n"
        L"  win7-launcher.exe [--config FILE] --register-protocol\n"
        L"  win7-launcher.exe [--config FILE] --unregister-protocol\n"
        L"  win7-launcher.exe [--config FILE] --uri URI\n"
        L"  win7-launcher.exe [--config FILE] --payload-v1 PAYLOAD\n"
        L"  win7-launcher.exe [--config FILE] --watch URL\n");
}

static void print_windows_error(const WCHAR *operation, DWORD error)
{
    WCHAR message[512];
    DWORD count;

    message[0] = L'\0';
    count = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, error, 0, message, (DWORD)(sizeof(message) / sizeof(message[0])), NULL);
    if (count != 0) {
        while (count > 0 && (message[count - 1] == L'\r' || message[count - 1] == L'\n')) {
            message[--count] = L'\0';
        }
        fwprintf(stderr, L"classcaller-launcher: %ls failed (%lu): %ls\n",
            operation, (unsigned long)error, message);
    } else {
        fwprintf(stderr, L"classcaller-launcher: %ls failed (%lu)\n",
            operation, (unsigned long)error);
    }
}

static int copy_wide(WCHAR *destination, SIZE_T capacity, const WCHAR *source)
{
    return SUCCEEDED(StringCchCopyW(destination, capacity, source));
}

static int append_wide(WCHAR *destination, SIZE_T capacity, const WCHAR *source)
{
    return SUCCEEDED(StringCchCatW(destination, capacity, source));
}

static int file_attributes_match(const WCHAR *path, int require_directory)
{
    DWORD attributes;

    attributes = GetFileAttributesW(path);
    if (attributes == INVALID_FILE_ATTRIBUTES) return 0;
    if (require_directory) return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    return (attributes & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static int is_drive_absolute(const WCHAR *path)
{
    return path != NULL
        && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
        && path[1] == L':'
        && (path[2] == L'\\' || path[2] == L'/');
}

static int normalize_absolute_path(const WCHAR *source, WCHAR *destination, SIZE_T capacity)
{
    WCHAR full[CC_PATH_CHARS];
    DWORD length;

    if (!is_drive_absolute(source) || wcschr(source, L'"') != NULL) return 0;
    length = GetFullPathNameW(source, CC_PATH_CHARS, full, NULL);
    if (length == 0 || length >= CC_PATH_CHARS) return 0;
    if (!copy_wide(destination, capacity, full)) return 0;
    return 1;
}

static int normalize_config_path(const WCHAR *source, WCHAR *destination, SIZE_T capacity)
{
    WCHAR full[CC_PATH_CHARS];
    DWORD length;

    if (source == NULL || source[0] == L'\0' || wcschr(source, L'"') != NULL) return 0;
    length = GetFullPathNameW(source, CC_PATH_CHARS, full, NULL);
    if (length == 0 || length >= CC_PATH_CHARS) return 0;
    return copy_wide(destination, capacity, full);
}

static int parent_directory_exists(const WCHAR *path)
{
    WCHAR parent[CC_PATH_CHARS];
    WCHAR *slash;

    if (!copy_wide(parent, CC_PATH_CHARS, path)) return 0;
    slash = wcsrchr(parent, L'\\');
    if (slash == NULL) return 0;
    if (slash == parent + 2) {
        slash[1] = L'\0';
    } else {
        *slash = L'\0';
    }
    return file_attributes_match(parent, 1);
}

static int ends_with_exe(const WCHAR *path)
{
    SIZE_T length;

    length = wcslen(path);
    return length >= 4 && _wcsicmp(path + length - 4, L".exe") == 0;
}

static int read_ini_value(const WCHAR *ini_path, const WCHAR *key,
    WCHAR *value, DWORD capacity, int required)
{
    DWORD length;

    value[0] = L'\0';
    length = GetPrivateProfileStringW(L"launcher", key, L"", value, capacity, ini_path);
    if (length >= capacity - 1) {
        fwprintf(stderr, L"classcaller-launcher: INI value is too long: %ls\n", key);
        return 0;
    }
    if (required && length == 0) {
        fwprintf(stderr, L"classcaller-launcher: missing [launcher] %ls in %ls\n", key, ini_path);
        return 0;
    }
    return 1;
}

static int parse_decimal_dword(const WCHAR *text, DWORD *value)
{
    ULONGLONG result;
    SIZE_T i;

    if (text == NULL || text[0] == L'\0') return 0;
    result = 0;
    for (i = 0; text[i] != L'\0'; ++i) {
        if (text[i] < L'0' || text[i] > L'9') return 0;
        result = result * 10ULL + (ULONGLONG)(text[i] - L'0');
        if (result > 0xffffffffULL) return 0;
    }
    *value = (DWORD)result;
    return 1;
}

static int default_ini_path(WCHAR *path, SIZE_T capacity)
{
    WCHAR executable[CC_PATH_CHARS];
    WCHAR *slash;
    DWORD length;

    length = GetModuleFileNameW(NULL, executable, CC_PATH_CHARS);
    if (length == 0 || length >= CC_PATH_CHARS) return 0;
    slash = wcsrchr(executable, L'\\');
    if (slash == NULL) return 0;
    slash[1] = L'\0';
    if (!copy_wide(path, capacity, executable)) return 0;
    return append_wide(path, capacity, L"win7-launcher.ini");
}

static int load_config(const WCHAR *requested_path, Config *config)
{
    WCHAR raw_target[CC_PATH_CHARS];
    WCHAR raw_working[CC_PATH_CHARS];
    WCHAR raw_state[CC_PATH_CHARS];
    WCHAR raw_fresh[32];
    const WCHAR *extra_colon;

    memset(config, 0, sizeof(*config));
    if (requested_path != NULL) {
        if (!normalize_config_path(requested_path, config->ini_path, CC_PATH_CHARS)) {
            fwprintf(stderr, L"classcaller-launcher: invalid config path\n");
            return 0;
        }
    } else if (!default_ini_path(config->ini_path, CC_PATH_CHARS)) {
        fwprintf(stderr, L"classcaller-launcher: cannot locate default classcaller.ini\n");
        return 0;
    }

    if (!file_attributes_match(config->ini_path, 0)) {
        fwprintf(stderr, L"classcaller-launcher: config file not found: %ls\n", config->ini_path);
        return 0;
    }
    if (!read_ini_value(config->ini_path, L"target_path", raw_target, CC_PATH_CHARS, 1)
        || !read_ini_value(config->ini_path, L"working_directory", raw_working, CC_PATH_CHARS, 1)
        || !read_ini_value(config->ini_path, L"state_path", raw_state, CC_PATH_CHARS, 1)
        || !read_ini_value(config->ini_path, L"fresh_seconds", raw_fresh,
            (DWORD)(sizeof(raw_fresh) / sizeof(raw_fresh[0])), 0)) {
        return 0;
    }

    if (raw_fresh[0] == L'\0') {
        config->fresh_seconds = CC_DEFAULT_FRESH_SECONDS;
    } else if (!parse_decimal_dword(raw_fresh, &config->fresh_seconds)
        || config->fresh_seconds < CC_MIN_FRESH_SECONDS
        || config->fresh_seconds > CC_MAX_FRESH_SECONDS) {
        fwprintf(stderr, L"classcaller-launcher: fresh_seconds must be 5..300\n");
        return 0;
    }

    if (!normalize_absolute_path(raw_target, config->target_path, CC_PATH_CHARS)
        || !normalize_absolute_path(raw_working, config->working_directory, CC_PATH_CHARS)
        || !normalize_absolute_path(raw_state, config->state_path, CC_PATH_CHARS)) {
        fwprintf(stderr, L"classcaller-launcher: INI paths must be absolute drive paths without quotes\n");
        return 0;
    }
    if (!file_attributes_match(config->target_path, 0) || !ends_with_exe(config->target_path)) {
        fwprintf(stderr, L"classcaller-launcher: target_path must name an existing .exe\n");
        return 0;
    }
    if (!file_attributes_match(config->working_directory, 1)) {
        fwprintf(stderr, L"classcaller-launcher: working_directory must name an existing directory\n");
        return 0;
    }
    if (!((config->state_path[0] == L'D' || config->state_path[0] == L'd')
        && config->state_path[1] == L':' && config->state_path[2] == L'\\')) {
        fwprintf(stderr, L"classcaller-launcher: state_path must be an absolute path on D:\\\n");
        return 0;
    }
    extra_colon = wcschr(config->state_path + 2, L':');
    if (extra_colon != NULL || !parent_directory_exists(config->state_path)) {
        fwprintf(stderr, L"classcaller-launcher: state_path parent must exist on D: and may not use an alternate stream\n");
        return 0;
    }
    if (file_attributes_match(config->state_path, 1)) {
        fwprintf(stderr, L"classcaller-launcher: state_path must be a file path, not a directory\n");
        return 0;
    }
    return 1;
}

static int uuid_v4_valid_ascii(const char *text)
{
    int i;
    char c;

    if (text == NULL || strlen(text) != CC_UUID_CHARS) return 0;
    for (i = 0; i < CC_UUID_CHARS; ++i) {
        c = text[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return 0;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')
            || (c >= 'A' && c <= 'F'))) {
            return 0;
        }
    }
    if (text[14] != '4') return 0;
    c = text[19];
    if (!(c == '8' || c == '9' || c == 'a' || c == 'A' || c == 'b' || c == 'B')) return 0;
    return 1;
}

static int base64url_value(char c)
{
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-') return 62;
    if (c == '_') return 63;
    return -1;
}

static int decode_base64url(const char *encoded, unsigned char **decoded, SIZE_T *decoded_length)
{
    SIZE_T length;
    SIZE_T capacity;
    SIZE_T output_length;
    SIZE_T i;
    unsigned int accumulator;
    int bits;
    int value;
    unsigned char *output;

    length = strlen(encoded);
    if (length == 0 || length > CC_MAX_PAYLOAD_CHARS || (length % 4) == 1) return 0;
    capacity = (length * 3) / 4 + 3;
    if (capacity > CC_MAX_JSON_BYTES + 1) return 0;
    output = (unsigned char *)malloc(capacity + 1);
    if (output == NULL) return 0;

    accumulator = 0;
    bits = 0;
    output_length = 0;
    for (i = 0; i < length; ++i) {
        value = base64url_value(encoded[i]);
        if (value < 0) {
            free(output);
            return 0;
        }
        accumulator = (accumulator << 6) | (unsigned int)value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (output_length >= capacity) {
                free(output);
                return 0;
            }
            output[output_length++] = (unsigned char)((accumulator >> bits) & 0xffU);
            if (bits == 0) accumulator = 0;
            else accumulator &= (1U << bits) - 1U;
        }
    }
    if (accumulator != 0 || output_length > CC_MAX_JSON_BYTES) {
        free(output);
        return 0;
    }
    output[output_length] = 0;
    *decoded = output;
    *decoded_length = output_length;
    return 1;
}

static int utf8_next(const unsigned char *data, SIZE_T length, SIZE_T *position, DWORD *codepoint)
{
    SIZE_T i;
    unsigned char a;
    unsigned char b;
    unsigned char c;
    unsigned char d;

    i = *position;
    if (i >= length) return 0;
    a = data[i++];
    if (a <= 0x7f) {
        *codepoint = a;
    } else if (a >= 0xc2 && a <= 0xdf) {
        if (i >= length) return 0;
        b = data[i++];
        if ((b & 0xc0) != 0x80) return 0;
        *codepoint = ((DWORD)(a & 0x1f) << 6) | (DWORD)(b & 0x3f);
    } else if (a >= 0xe0 && a <= 0xef) {
        if (i + 1 >= length) return 0;
        b = data[i++];
        c = data[i++];
        if ((b & 0xc0) != 0x80 || (c & 0xc0) != 0x80) return 0;
        if ((a == 0xe0 && b < 0xa0) || (a == 0xed && b >= 0xa0)) return 0;
        *codepoint = ((DWORD)(a & 0x0f) << 12) | ((DWORD)(b & 0x3f) << 6) | (DWORD)(c & 0x3f);
    } else if (a >= 0xf0 && a <= 0xf4) {
        if (i + 2 >= length) return 0;
        b = data[i++];
        c = data[i++];
        d = data[i++];
        if ((b & 0xc0) != 0x80 || (c & 0xc0) != 0x80 || (d & 0xc0) != 0x80) return 0;
        if ((a == 0xf0 && b < 0x90) || (a == 0xf4 && b >= 0x90)) return 0;
        *codepoint = ((DWORD)(a & 0x07) << 18) | ((DWORD)(b & 0x3f) << 12)
            | ((DWORD)(c & 0x3f) << 6) | (DWORD)(d & 0x3f);
    } else {
        return 0;
    }
    *position = i;
    return 1;
}

static int utf8_valid(const unsigned char *data, SIZE_T length)
{
    SIZE_T position;
    DWORD codepoint;

    position = 0;
    while (position < length) {
        if (!utf8_next(data, length, &position, &codepoint)) return 0;
        if (codepoint == 0) return 0;
    }
    return 1;
}

static void json_skip_space(JsonParser *parser)
{
    unsigned char c;

    while (parser->pos < parser->length) {
        c = parser->data[parser->pos];
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
        ++parser->pos;
    }
}

static int json_fail(JsonParser *parser, const char *message)
{
    if (parser->error == NULL) parser->error = message;
    return 0;
}

static int json_hex4(JsonParser *parser, DWORD *value)
{
    DWORD result;
    int i;
    unsigned char c;

    result = 0;
    for (i = 0; i < 4; ++i) {
        if (parser->pos >= parser->length) return json_fail(parser, "short unicode escape");
        c = parser->data[parser->pos++];
        result <<= 4;
        if (c >= '0' && c <= '9') result |= (DWORD)(c - '0');
        else if (c >= 'a' && c <= 'f') result |= (DWORD)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') result |= (DWORD)(c - 'A' + 10);
        else return json_fail(parser, "invalid unicode escape");
    }
    *value = result;
    return 1;
}

static int json_append_codepoint(JsonParser *parser, WCHAR *output, SIZE_T capacity,
    SIZE_T *units, DWORD codepoint)
{
    SIZE_T needed;

    needed = codepoint <= 0xffff ? 1 : 2;
    if (output != NULL && *units + needed >= capacity) return json_fail(parser, "string is too long");
    if (codepoint <= 0xffff) {
        if (output != NULL) output[*units] = (WCHAR)codepoint;
        *units += 1;
    } else {
        codepoint -= 0x10000;
        if (output != NULL) {
            output[*units] = (WCHAR)(0xd800 + (codepoint >> 10));
            output[*units + 1] = (WCHAR)(0xdc00 + (codepoint & 0x3ff));
        }
        *units += 2;
    }
    return 1;
}

static int json_parse_string(JsonParser *parser, WCHAR *output, SIZE_T capacity, SIZE_T *unit_count)
{
    SIZE_T units;
    SIZE_T start;
    DWORD codepoint;
    DWORD first;
    DWORD second;
    unsigned char c;

    json_skip_space(parser);
    if (parser->pos >= parser->length || parser->data[parser->pos] != '"') {
        return json_fail(parser, "expected string");
    }
    ++parser->pos;
    units = 0;
    while (parser->pos < parser->length) {
        c = parser->data[parser->pos++];
        if (c == '"') {
            if (output != NULL) output[units] = L'\0';
            if (unit_count != NULL) *unit_count = units;
            return 1;
        }
        if (c < 0x20) return json_fail(parser, "unescaped control character");
        if (c == '\\') {
            if (parser->pos >= parser->length) return json_fail(parser, "short escape");
            c = parser->data[parser->pos++];
            if (c == '"' || c == '\\' || c == '/') codepoint = c;
            else if (c == 'b') codepoint = 0x08;
            else if (c == 'f') codepoint = 0x0c;
            else if (c == 'n') codepoint = 0x0a;
            else if (c == 'r') codepoint = 0x0d;
            else if (c == 't') codepoint = 0x09;
            else if (c == 'u') {
                if (!json_hex4(parser, &first)) return 0;
                if (first >= 0xd800 && first <= 0xdbff) {
                    if (parser->pos + 1 >= parser->length || parser->data[parser->pos] != '\\'
                        || parser->data[parser->pos + 1] != 'u') {
                        return json_fail(parser, "missing low surrogate");
                    }
                    parser->pos += 2;
                    if (!json_hex4(parser, &second)) return 0;
                    if (second < 0xdc00 || second > 0xdfff) return json_fail(parser, "invalid low surrogate");
                    codepoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
                } else {
                    if (first >= 0xdc00 && first <= 0xdfff) return json_fail(parser, "unpaired low surrogate");
                    codepoint = first;
                }
            } else {
                return json_fail(parser, "invalid escape");
            }
        } else if (c < 0x80) {
            codepoint = c;
        } else {
            start = parser->pos - 1;
            if (!utf8_next(parser->data, parser->length, &start, &codepoint)) {
                return json_fail(parser, "invalid UTF-8 in string");
            }
            parser->pos = start;
        }
        if (codepoint == 0) return json_fail(parser, "NUL is not allowed");
        if (!json_append_codepoint(parser, output, capacity, &units, codepoint)) return 0;
    }
    return json_fail(parser, "unterminated string");
}

static int json_expect(JsonParser *parser, unsigned char expected)
{
    json_skip_space(parser);
    if (parser->pos >= parser->length || parser->data[parser->pos] != expected) {
        return json_fail(parser, "unexpected JSON token");
    }
    ++parser->pos;
    return 1;
}

static int json_parse_uint64(JsonParser *parser, ULONGLONG *value)
{
    ULONGLONG result;
    unsigned char c;
    SIZE_T start;

    json_skip_space(parser);
    start = parser->pos;
    if (start >= parser->length || parser->data[start] < '0' || parser->data[start] > '9') {
        return json_fail(parser, "expected unsigned integer");
    }
    if (parser->data[start] == '0' && start + 1 < parser->length
        && parser->data[start + 1] >= '0' && parser->data[start + 1] <= '9') {
        return json_fail(parser, "leading zero in integer");
    }
    result = 0;
    while (parser->pos < parser->length) {
        c = parser->data[parser->pos];
        if (c < '0' || c > '9') break;
        if (result > 9007199254740991ULL / 10ULL) return json_fail(parser, "integer is too large");
        result = result * 10ULL + (ULONGLONG)(c - '0');
        if (result > 9007199254740991ULL) return json_fail(parser, "integer is too large");
        ++parser->pos;
    }
    *value = result;
    return 1;
}

static int json_skip_value(JsonParser *parser);

static int json_skip_number(JsonParser *parser)
{
    SIZE_T start;
    unsigned char c;

    json_skip_space(parser);
    start = parser->pos;
    if (parser->pos < parser->length && parser->data[parser->pos] == '-') ++parser->pos;
    if (parser->pos >= parser->length) return json_fail(parser, "invalid number");
    if (parser->data[parser->pos] == '0') {
        ++parser->pos;
    } else if (parser->data[parser->pos] >= '1' && parser->data[parser->pos] <= '9') {
        while (parser->pos < parser->length && parser->data[parser->pos] >= '0'
            && parser->data[parser->pos] <= '9') ++parser->pos;
    } else {
        return json_fail(parser, "invalid number");
    }
    if (parser->pos < parser->length && parser->data[parser->pos] == '.') {
        ++parser->pos;
        if (parser->pos >= parser->length || parser->data[parser->pos] < '0'
            || parser->data[parser->pos] > '9') return json_fail(parser, "invalid fraction");
        while (parser->pos < parser->length && parser->data[parser->pos] >= '0'
            && parser->data[parser->pos] <= '9') ++parser->pos;
    }
    if (parser->pos < parser->length) {
        c = parser->data[parser->pos];
        if (c == 'e' || c == 'E') {
            ++parser->pos;
            if (parser->pos < parser->length
                && (parser->data[parser->pos] == '+' || parser->data[parser->pos] == '-')) ++parser->pos;
            if (parser->pos >= parser->length || parser->data[parser->pos] < '0'
                || parser->data[parser->pos] > '9') return json_fail(parser, "invalid exponent");
            while (parser->pos < parser->length && parser->data[parser->pos] >= '0'
                && parser->data[parser->pos] <= '9') ++parser->pos;
        }
    }
    return parser->pos > start;
}

static int json_skip_literal(JsonParser *parser, const char *literal)
{
    SIZE_T length;

    length = strlen(literal);
    if (parser->pos + length > parser->length
        || memcmp(parser->data + parser->pos, literal, length) != 0) {
        return json_fail(parser, "invalid literal");
    }
    parser->pos += length;
    return 1;
}

static int json_skip_value(JsonParser *parser)
{
    unsigned char c;
    WCHAR key[128];

    json_skip_space(parser);
    if (++parser->depth > 32) return json_fail(parser, "JSON nesting is too deep");
    if (parser->pos >= parser->length) {
        --parser->depth;
        return json_fail(parser, "missing value");
    }
    c = parser->data[parser->pos];
    if (c == '"') {
        if (!json_parse_string(parser, NULL, 0, NULL)) {
            --parser->depth;
            return 0;
        }
    } else if (c == '{') {
        ++parser->pos;
        json_skip_space(parser);
        if (parser->pos < parser->length && parser->data[parser->pos] == '}') {
            ++parser->pos;
        } else {
            for (;;) {
                if (!json_parse_string(parser, key, sizeof(key) / sizeof(key[0]), NULL)
                    || !json_expect(parser, ':') || !json_skip_value(parser)) {
                    --parser->depth;
                    return 0;
                }
                json_skip_space(parser);
                if (parser->pos < parser->length && parser->data[parser->pos] == ',') {
                    ++parser->pos;
                    continue;
                }
                if (parser->pos < parser->length && parser->data[parser->pos] == '}') {
                    ++parser->pos;
                    break;
                }
                --parser->depth;
                return json_fail(parser, "invalid object");
            }
        }
    } else if (c == '[') {
        ++parser->pos;
        json_skip_space(parser);
        if (parser->pos < parser->length && parser->data[parser->pos] == ']') {
            ++parser->pos;
        } else {
            for (;;) {
                if (!json_skip_value(parser)) {
                    --parser->depth;
                    return 0;
                }
                json_skip_space(parser);
                if (parser->pos < parser->length && parser->data[parser->pos] == ',') {
                    ++parser->pos;
                    continue;
                }
                if (parser->pos < parser->length && parser->data[parser->pos] == ']') {
                    ++parser->pos;
                    break;
                }
                --parser->depth;
                return json_fail(parser, "invalid array");
            }
        }
    } else if (c == 't') {
        if (!json_skip_literal(parser, "true")) {
            --parser->depth;
            return 0;
        }
    } else if (c == 'f') {
        if (!json_skip_literal(parser, "false")) {
            --parser->depth;
            return 0;
        }
    } else if (c == 'n') {
        if (!json_skip_literal(parser, "null")) {
            --parser->depth;
            return 0;
        }
    } else {
        if (!json_skip_number(parser)) {
            --parser->depth;
            return 0;
        }
    }
    --parser->depth;
    return 1;
}

static int text_has_control(const WCHAR *text)
{
    SIZE_T i;

    for (i = 0; text[i] != L'\0'; ++i) {
        if (text[i] < 0x20 || text[i] == 0x7f) return 1;
    }
    return 0;
}

static int wide_ascii_copy(const WCHAR *source, char *destination, SIZE_T capacity)
{
    SIZE_T i;

    for (i = 0; source[i] != L'\0'; ++i) {
        if (i + 1 >= capacity || source[i] > 0x7f) return 0;
        destination[i] = (char)source[i];
    }
    destination[i] = '\0';
    return 1;
}

static int parse_students(JsonParser *parser)
{
    WCHAR students[20][21];
    WCHAR student[21];
    SIZE_T units;
    SIZE_T count;
    SIZE_T i;

    if (!json_expect(parser, '[')) return 0;
    json_skip_space(parser);
    count = 0;
    if (parser->pos < parser->length && parser->data[parser->pos] == ']') {
        ++parser->pos;
        return json_fail(parser, "students must not be empty");
    }
    for (;;) {
        if (count >= 20) return json_fail(parser, "too many students");
        if (!json_parse_string(parser, student, 21, &units)) return 0;
        if (units == 0 || units > 20 || text_has_control(student)) {
            return json_fail(parser, "invalid student name");
        }
        for (i = 0; i < count; ++i) {
            if (wcscmp(students[i], student) == 0) return json_fail(parser, "duplicate student name");
        }
        copy_wide(students[count], 21, student);
        ++count;
        json_skip_space(parser);
        if (parser->pos < parser->length && parser->data[parser->pos] == ',') {
            ++parser->pos;
            continue;
        }
        if (parser->pos < parser->length && parser->data[parser->pos] == ']') {
            ++parser->pos;
            return 1;
        }
        return json_fail(parser, "invalid students array");
    }
}

static int parse_payload_json(const unsigned char *json, SIZE_T length, PayloadInfo *info)
{
    JsonParser parser;
    WCHAR key[32];
    WCHAR value[64];
    WCHAR message[61];
    SIZE_T units;
    ULONGLONG number;
    unsigned int seen;
    unsigned int bit;

    memset(info, 0, sizeof(*info));
    memset(&parser, 0, sizeof(parser));
    parser.data = json;
    parser.length = length;
    if (!json_expect(&parser, '{')) goto invalid;
    json_skip_space(&parser);
    if (parser.pos < parser.length && parser.data[parser.pos] == '}') goto invalid;

    seen = 0;
    for (;;) {
        if (!json_parse_string(&parser, key, sizeof(key) / sizeof(key[0]), NULL)
            || !json_expect(&parser, ':')) goto invalid;
        bit = 0;
        if (wcscmp(key, L"version") == 0) {
            bit = 1U;
            if (!json_parse_uint64(&parser, &number) || number != 1) goto invalid;
        } else if (wcscmp(key, L"deliveryId") == 0) {
            bit = 2U;
            if (!json_parse_string(&parser, value, sizeof(value) / sizeof(value[0]), NULL)
                || !wide_ascii_copy(value, info->delivery_id, sizeof(info->delivery_id))) goto invalid;
        } else if (wcscmp(key, L"recordId") == 0) {
            bit = 4U;
            if (!json_parse_string(&parser, value, sizeof(value) / sizeof(value[0]), NULL)
                || !wide_ascii_copy(value, info->record_id, sizeof(info->record_id))) goto invalid;
        } else if (wcscmp(key, L"issuedAt") == 0) {
            bit = 8U;
            if (!json_parse_uint64(&parser, &info->issued_at)) goto invalid;
        } else if (wcscmp(key, L"students") == 0) {
            bit = 16U;
            if (!parse_students(&parser)) goto invalid;
        } else if (wcscmp(key, L"message") == 0) {
            bit = 32U;
            if (!json_parse_string(&parser, message, 61, &units)
                || units > 60 || text_has_control(message)) goto invalid;
        } else {
            parser.error = "unknown payload field";
            goto invalid;
        }
        if ((seen & bit) != 0) {
            parser.error = "duplicate payload field";
            goto invalid;
        }
        seen |= bit;
        json_skip_space(&parser);
        if (parser.pos < parser.length && parser.data[parser.pos] == ',') {
            ++parser.pos;
            continue;
        }
        if (parser.pos < parser.length && parser.data[parser.pos] == '}') {
            ++parser.pos;
            break;
        }
        parser.error = "invalid payload object";
        goto invalid;
    }
    json_skip_space(&parser);
    if (parser.pos != parser.length || seen != 63U
        || !uuid_v4_valid_ascii(info->delivery_id) || !uuid_v4_valid_ascii(info->record_id)
        || info->issued_at == 0) {
        parser.error = "payload fields are incomplete or invalid";
        goto invalid;
    }
    return 1;

invalid:
    fwprintf(stderr, L"classcaller-launcher: rejected payload JSON (%hs)\n",
        parser.error != NULL ? parser.error : "invalid schema");
    return 0;
}

static int validate_encoded_payload(const char *encoded, PayloadInfo *info)
{
    unsigned char *decoded;
    SIZE_T decoded_length;
    int valid;

    decoded = NULL;
    decoded_length = 0;
    if (!decode_base64url(encoded, &decoded, &decoded_length)) {
        fwprintf(stderr, L"classcaller-launcher: rejected non-canonical base64url payload\n");
        return 0;
    }
    if (!utf8_valid(decoded, decoded_length)) {
        fwprintf(stderr, L"classcaller-launcher: rejected payload with invalid UTF-8\n");
        free(decoded);
        return 0;
    }
    valid = parse_payload_json(decoded, decoded_length, info);
    free(decoded);
    return valid;
}

static ULONGLONG unix_time_milliseconds(void)
{
    FILETIME file_time;
    ULARGE_INTEGER ticks;

    GetSystemTimeAsFileTime(&file_time);
    ticks.LowPart = file_time.dwLowDateTime;
    ticks.HighPart = file_time.dwHighDateTime;
    if (ticks.QuadPart < 116444736000000000ULL) return 0;
    return (ticks.QuadPart - 116444736000000000ULL) / 10000ULL;
}

static int direct_payload_is_fresh(const Config *config, const PayloadInfo *info)
{
    ULONGLONG now;
    ULONGLONG deadline;

    now = unix_time_milliseconds();
    if (now == 0 || info->issued_at > now + CC_DIRECT_FUTURE_SKEW_MS) {
        fwprintf(stderr, L"classcaller-launcher: rejected payload issued in the future\n");
        return 0;
    }
    deadline = info->issued_at + (ULONGLONG)config->fresh_seconds * 1000ULL;
    if (deadline < info->issued_at || now > deadline) {
        fwprintf(stderr, L"classcaller-launcher: rejected stale payload\n");
        return 0;
    }
    return 1;
}

static unsigned long long state_path_hash(const WCHAR *path)
{
    unsigned long long hash;
    SIZE_T i;
    WCHAR c;

    hash = 1469598103934665603ULL;
    for (i = 0; path[i] != L'\0'; ++i) {
        c = path[i];
        if (c >= L'A' && c <= L'Z') c = (WCHAR)(c - L'A' + L'a');
        hash ^= (unsigned long long)(unsigned short)c;
        hash *= 1099511628211ULL;
    }
    return hash;
}

static int make_mutex_name(const WCHAR *state_path, WCHAR *name, SIZE_T capacity)
{
    unsigned long long hash;
    DWORD high;
    DWORD low;

    hash = state_path_hash(state_path);
    high = (DWORD)(hash >> 32);
    low = (DWORD)(hash & 0xffffffffULL);
    return SUCCEEDED(StringCchPrintfW(name, capacity,
        L"Local\\ClassCallerLauncherState-%08lX%08lX",
        (unsigned long)high, (unsigned long)low));
}

static int load_state(const WCHAR *path, StateData *state)
{
    HANDLE file;
    LARGE_INTEGER size;
    DWORD read_count;
    DWORD error;
    char *buffer;
    char *line;
    char *cursor;
    char *end;
    SIZE_T line_length;

    memset(state, 0, sizeof(*state));
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND) return 1;
        print_windows_error(L"open state", error);
        return 0;
    }
    if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > 16384) {
        CloseHandle(file);
        fwprintf(stderr, L"classcaller-launcher: state file is invalid or too large\n");
        return 0;
    }
    buffer = (char *)malloc((SIZE_T)size.QuadPart + 1);
    if (buffer == NULL) {
        CloseHandle(file);
        return 0;
    }
    read_count = 0;
    if (size.QuadPart > 0 && (!ReadFile(file, buffer, (DWORD)size.QuadPart, &read_count, NULL)
        || read_count != (DWORD)size.QuadPart)) {
        error = GetLastError();
        free(buffer);
        CloseHandle(file);
        print_windows_error(L"read state", error);
        return 0;
    }
    CloseHandle(file);
    buffer[read_count] = '\0';

    cursor = buffer;
    end = buffer + read_count;
    line = cursor;
    while (cursor < end && *cursor != '\n') ++cursor;
    line_length = (SIZE_T)(cursor - line);
    if (line_length > 0 && line[line_length - 1] == '\r') --line_length;
    if (line_length != strlen("classcaller-state-v1")
        || memcmp(line, "classcaller-state-v1", line_length) != 0) {
        free(buffer);
        fwprintf(stderr, L"classcaller-launcher: state file header is invalid\n");
        return 0;
    }
    if (cursor < end) ++cursor;

    while (cursor < end) {
        line = cursor;
        while (cursor < end && *cursor != '\n') ++cursor;
        line_length = (SIZE_T)(cursor - line);
        if (line_length > 0 && line[line_length - 1] == '\r') --line_length;
        if (cursor < end) ++cursor;
        if (line_length == 0) continue;
        if (line_length != CC_UUID_CHARS || state->count >= CC_MAX_STATE_IDS) {
            free(buffer);
            fwprintf(stderr, L"classcaller-launcher: state file entries are invalid\n");
            return 0;
        }
        memcpy(state->ids[state->count], line, CC_UUID_CHARS);
        state->ids[state->count][CC_UUID_CHARS] = '\0';
        if (!uuid_v4_valid_ascii(state->ids[state->count])) {
            free(buffer);
            fwprintf(stderr, L"classcaller-launcher: state file contains an invalid deliveryId\n");
            return 0;
        }
        ++state->count;
    }
    free(buffer);
    return 1;
}

static int write_state_atomic(const WCHAR *path, const StateData *state)
{
    WCHAR temporary[CC_PATH_CHARS];
    char buffer[16384];
    SIZE_T used;
    SIZE_T i;
    HANDLE file;
    DWORD written;
    DWORD error;

    if (FAILED(StringCchPrintfW(temporary, CC_PATH_CHARS, L"%ls.tmp.%lu.%lu",
        path, (unsigned long)GetCurrentProcessId(), (unsigned long)GetTickCount()))) {
        fwprintf(stderr, L"classcaller-launcher: state path is too long for atomic update\n");
        return 0;
    }
    used = strlen(CC_STATE_HEADER);
    memcpy(buffer, CC_STATE_HEADER, used);
    for (i = 0; i < state->count; ++i) {
        if (used + CC_UUID_CHARS + 1 > sizeof(buffer)) return 0;
        memcpy(buffer + used, state->ids[i], CC_UUID_CHARS);
        used += CC_UUID_CHARS;
        buffer[used++] = '\n';
    }

    file = CreateFileW(temporary, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS,
        FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        print_windows_error(L"create temporary state", GetLastError());
        return 0;
    }
    written = 0;
    if (!WriteFile(file, buffer, (DWORD)used, &written, NULL) || written != (DWORD)used
        || !FlushFileBuffers(file)) {
        error = GetLastError();
        CloseHandle(file);
        DeleteFileW(temporary);
        print_windows_error(L"write temporary state", error);
        return 0;
    }
    if (!CloseHandle(file)) {
        error = GetLastError();
        DeleteFileW(temporary);
        print_windows_error(L"close temporary state", error);
        return 0;
    }
    if (!MoveFileExW(temporary, path, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        error = GetLastError();
        DeleteFileW(temporary);
        print_windows_error(L"replace state", error);
        return 0;
    }
    return 1;
}

static int state_contains(const StateData *state, const char *delivery_id)
{
    SIZE_T i;

    for (i = 0; i < state->count; ++i) {
        if (_stricmp(state->ids[i], delivery_id) == 0) return 1;
    }
    return 0;
}

static void state_with_delivery(const StateData *old_state, const char *delivery_id,
    StateData *new_state)
{
    SIZE_T copy_count;
    SIZE_T i;

    memset(new_state, 0, sizeof(*new_state));
    memcpy(new_state->ids[0], delivery_id, CC_UUID_CHARS + 1);
    new_state->count = 1;
    copy_count = old_state->count;
    if (copy_count > CC_MAX_STATE_IDS - 1) copy_count = CC_MAX_STATE_IDS - 1;
    for (i = 0; i < copy_count; ++i) {
        memcpy(new_state->ids[i + 1], old_state->ids[i], CC_UUID_CHARS + 1);
    }
    new_state->count += copy_count;
}

static int launch_target(const Config *config, const char *encoded_payload)
{
    WCHAR *payload_wide;
    WCHAR *command_line;
    SIZE_T payload_length;
    SIZE_T command_capacity;
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    BOOL created;
    DWORD error;
    SIZE_T i;

    payload_length = strlen(encoded_payload);
    payload_wide = (WCHAR *)malloc((payload_length + 1) * sizeof(WCHAR));
    if (payload_wide == NULL) return 0;
    for (i = 0; i < payload_length; ++i) payload_wide[i] = (WCHAR)(unsigned char)encoded_payload[i];
    payload_wide[payload_length] = L'\0';

    command_capacity = wcslen(config->target_path) + payload_length + 40;
    if (command_capacity > 32767) {
        free(payload_wide);
        fwprintf(stderr, L"classcaller-launcher: target command line is too long\n");
        return 0;
    }
    command_line = (WCHAR *)malloc(command_capacity * sizeof(WCHAR));
    if (command_line == NULL) {
        free(payload_wide);
        return 0;
    }
    if (FAILED(StringCchPrintfW(command_line, command_capacity,
        L"\"%ls\" --class-caller-v1 \"%ls\"", config->target_path, payload_wide))) {
        free(command_line);
        free(payload_wide);
        return 0;
    }

    memset(&startup, 0, sizeof(startup));
    memset(&process, 0, sizeof(process));
    startup.cb = sizeof(startup);
    created = CreateProcessW(config->target_path, command_line, NULL, NULL, FALSE,
        CREATE_UNICODE_ENVIRONMENT, NULL, config->working_directory, &startup, &process);
    error = created ? ERROR_SUCCESS : GetLastError();
    free(command_line);
    free(payload_wide);
    if (!created) {
        print_windows_error(L"CreateProcessW target", error);
        return 0;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 1;
}

static int deliver_payload(const Config *config, const char *encoded_payload,
    const PayloadInfo *info)
{
    WCHAR mutex_name[96];
    HANDLE mutex;
    DWORD wait_result;
    StateData old_state;
    StateData new_state;
    int result;

    if (!make_mutex_name(config->state_path, mutex_name,
        sizeof(mutex_name) / sizeof(mutex_name[0]))) return CC_EXIT_STATE;
    mutex = CreateMutexW(NULL, FALSE, mutex_name);
    if (mutex == NULL) {
        print_windows_error(L"CreateMutexW", GetLastError());
        return CC_EXIT_STATE;
    }
    wait_result = WaitForSingleObject(mutex, 15000);
    if (wait_result != WAIT_OBJECT_0 && wait_result != WAIT_ABANDONED) {
        fwprintf(stderr, L"classcaller-launcher: could not acquire state mutex\n");
        CloseHandle(mutex);
        return CC_EXIT_STATE;
    }

    result = CC_EXIT_STATE;
    if (!load_state(config->state_path, &old_state)) goto done;
    if (state_contains(&old_state, info->delivery_id)) {
        fwprintf(stdout, L"classcaller-launcher: duplicate delivery ignored\n");
        result = CC_EXIT_OK;
        goto done;
    }
    state_with_delivery(&old_state, info->delivery_id, &new_state);
    if (!write_state_atomic(config->state_path, &new_state)) goto done;

    if (!launch_target(config, encoded_payload)) {
        if (!write_state_atomic(config->state_path, &old_state)) {
            fwprintf(stderr, L"classcaller-launcher: launch failed and state rollback also failed\n");
            result = CC_EXIT_STATE;
        } else {
            result = CC_EXIT_LAUNCH;
        }
        goto done;
    }
    fwprintf(stdout, L"classcaller-launcher: target started\n");
    result = CC_EXIT_OK;

done:
    ReleaseMutex(mutex);
    CloseHandle(mutex);
    return result;
}

static int register_value(HKEY key, const WCHAR *name, const WCHAR *value)
{
    LONG status;
    DWORD bytes;

    bytes = (DWORD)((wcslen(value) + 1) * sizeof(WCHAR));
    status = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)value, bytes);
    if (status != ERROR_SUCCESS) {
        print_windows_error(L"RegSetValueExW", (DWORD)status);
        return 0;
    }
    return 1;
}

static int register_subkey_value(HKEY root, const WCHAR *subkey, const WCHAR *value)
{
    HKEY key;
    LONG status;
    int ok;

    status = RegCreateKeyExW(root, subkey, 0, NULL, REG_OPTION_NON_VOLATILE,
        KEY_SET_VALUE, NULL, &key, NULL);
    if (status != ERROR_SUCCESS) {
        print_windows_error(L"RegCreateKeyExW", (DWORD)status);
        return 0;
    }
    ok = register_value(key, NULL, value);
    RegCloseKey(key);
    return ok;
}

static int register_protocol(const Config *config)
{
    const WCHAR *root_path;
    HKEY root;
    LONG status;
    WCHAR executable[CC_PATH_CHARS];
    WCHAR icon[CC_PATH_CHARS + 8];
    WCHAR command[CC_PATH_CHARS * 2 + 64];
    DWORD length;
    int ok;

    root_path = L"Software\\Classes\\classcaller";
    length = GetModuleFileNameW(NULL, executable, CC_PATH_CHARS);
    if (length == 0 || length >= CC_PATH_CHARS || wcschr(executable, L'"') != NULL) {
        fwprintf(stderr, L"classcaller-launcher: cannot determine launcher path\n");
        return CC_EXIT_REGISTRY;
    }
    status = RegCreateKeyExW(HKEY_CURRENT_USER, root_path, 0, NULL,
        REG_OPTION_NON_VOLATILE, KEY_SET_VALUE | KEY_CREATE_SUB_KEY, NULL, &root, NULL);
    if (status != ERROR_SUCCESS) {
        print_windows_error(L"RegCreateKeyExW protocol", (DWORD)status);
        return CC_EXIT_REGISTRY;
    }
    ok = register_value(root, NULL, L"URL:ClassCaller Protocol")
        && register_value(root, L"URL Protocol", L"");
    RegCloseKey(root);
    if (!ok) return CC_EXIT_REGISTRY;

    if (FAILED(StringCchPrintfW(icon, sizeof(icon) / sizeof(icon[0]), L"\"%ls\",0", executable))
        || FAILED(StringCchPrintfW(command, sizeof(command) / sizeof(command[0]),
            L"\"%ls\" --config \"%ls\" --uri \"%%1\"", executable, config->ini_path))) {
        fwprintf(stderr, L"classcaller-launcher: registry command is too long\n");
        return CC_EXIT_REGISTRY;
    }
    if (!register_subkey_value(HKEY_CURRENT_USER,
            L"Software\\Classes\\classcaller\\DefaultIcon", icon)
        || !register_subkey_value(HKEY_CURRENT_USER,
            L"Software\\Classes\\classcaller\\shell\\open\\command", command)) {
        return CC_EXIT_REGISTRY;
    }
    fwprintf(stdout, L"classcaller-launcher: classcaller protocol registered for current user\n");
    return CC_EXIT_OK;
}

static int unregister_protocol(void)
{
    LONG status;

    status = RegDeleteTreeW(HKEY_CURRENT_USER, L"Software\\Classes\\classcaller");
    if (status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND && status != ERROR_PATH_NOT_FOUND) {
        print_windows_error(L"RegDeleteTreeW protocol", (DWORD)status);
        return CC_EXIT_REGISTRY;
    }
    fwprintf(stdout, L"classcaller-launcher: classcaller protocol unregistered for current user\n");
    return CC_EXIT_OK;
}

static int uri_to_payload(const WCHAR *uri, char *payload, SIZE_T capacity)
{
    const WCHAR *prefix;
    const WCHAR *source;
    SIZE_T prefix_length;
    SIZE_T length;
    SIZE_T i;

    prefix = L"classcaller://v1/call?payload=";
    prefix_length = wcslen(prefix);
    if (_wcsnicmp(uri, prefix, prefix_length) != 0) {
        fwprintf(stderr, L"classcaller-launcher: URI must be classcaller://v1/call?payload=<base64url>\n");
        return 0;
    }
    source = uri + prefix_length;
    length = wcslen(source);
    if (length == 0 || length > CC_MAX_PAYLOAD_CHARS || length + 1 > capacity) return 0;
    for (i = 0; i < length; ++i) {
        if (source[i] > 0x7f || base64url_value((char)source[i]) < 0) {
            fwprintf(stderr, L"classcaller-launcher: URI payload must be unpadded base64url\n");
            return 0;
        }
        payload[i] = (char)source[i];
    }
    payload[length] = '\0';
    return 1;
}

static int parse_watch_envelope(const char *json_text, SIZE_T length, WatchEnvelope *envelope)
{
    JsonParser parser;
    WCHAR key[64];
    WCHAR wide_value[CC_MAX_PAYLOAD_CHARS + 1];
    unsigned int seen;
    unsigned int bit;

    memset(envelope, 0, sizeof(*envelope));
    memset(&parser, 0, sizeof(parser));
    parser.data = (const unsigned char *)json_text;
    parser.length = length;
    if (!utf8_valid(parser.data, parser.length) || !json_expect(&parser, '{')) goto malformed;
    json_skip_space(&parser);
    if (parser.pos < parser.length && parser.data[parser.pos] == '}') {
        ++parser.pos;
        return 0;
    }

    seen = 0;
    for (;;) {
        if (!json_parse_string(&parser, key, sizeof(key) / sizeof(key[0]), NULL)
            || !json_expect(&parser, ':')) goto malformed;
        bit = 0;
        if (wcscmp(key, L"type") == 0) {
            bit = 16U;
            if (!json_parse_string(&parser, wide_value,
                    sizeof(wide_value) / sizeof(wide_value[0]), NULL)
                || !wide_ascii_copy(wide_value, envelope->type,
                    sizeof(envelope->type))) goto malformed;
        } else if (wcscmp(key, L"deliveryId") == 0) {
            bit = 1U;
            if (!json_parse_string(&parser, wide_value,
                    sizeof(wide_value) / sizeof(wide_value[0]), NULL)
                || !wide_ascii_copy(wide_value, envelope->delivery_id,
                    sizeof(envelope->delivery_id))) goto malformed;
        } else if (wcscmp(key, L"launchValidUntil") == 0) {
            bit = 2U;
            if (!json_parse_uint64(&parser, &envelope->launch_valid_until)) goto malformed;
        } else if (wcscmp(key, L"launchPayload") == 0) {
            bit = 4U;
            if (!json_parse_string(&parser, wide_value,
                    sizeof(wide_value) / sizeof(wide_value[0]), NULL)
                || !wide_ascii_copy(wide_value, envelope->launch_payload,
                    sizeof(envelope->launch_payload))) goto malformed;
        } else if (wcscmp(key, L"serverTime") == 0) {
            bit = 8U;
            if (!json_parse_uint64(&parser, &envelope->server_time)) goto malformed;
        } else {
            if (!json_skip_value(&parser)) goto malformed;
        }
        if (bit != 0) {
            if ((seen & bit) != 0) goto malformed;
            seen |= bit;
        }
        json_skip_space(&parser);
        if (parser.pos < parser.length && parser.data[parser.pos] == ',') {
            ++parser.pos;
            continue;
        }
        if (parser.pos < parser.length && parser.data[parser.pos] == '}') {
            ++parser.pos;
            break;
        }
        goto malformed;
    }
    json_skip_space(&parser);
    if (parser.pos != parser.length) goto malformed;
    if (seen == 0) return 0;
    if ((seen & 16U) != 0 && strcmp(envelope->type, "clear") == 0) return 0;
    if (seen != 31U || strcmp(envelope->type, "call") != 0
        || !uuid_v4_valid_ascii(envelope->delivery_id)
        || envelope->launch_payload[0] == '\0') goto malformed;
    return 1;

malformed:
    fwprintf(stderr, L"classcaller-launcher: ignored malformed launcher SSE event\n");
    return -1;
}

static int handle_watch_frame(const Config *config, const char *data, SIZE_T length)
{
    WatchEnvelope envelope;
    PayloadInfo info;
    int parsed;
    ULONGLONG minimum_until;
    ULONGLONG maximum_until;

    parsed = parse_watch_envelope(data, length, &envelope);
    if (parsed <= 0) return parsed == 0 ? CC_EXIT_OK : CC_EXIT_INPUT;
    if (!validate_encoded_payload(envelope.launch_payload, &info)) return CC_EXIT_INPUT;
    if (_stricmp(info.delivery_id, envelope.delivery_id) != 0) {
        fwprintf(stderr, L"classcaller-launcher: SSE and payload deliveryId values differ\n");
        return CC_EXIT_INPUT;
    }
    minimum_until = info.issued_at + CC_MIN_FRESH_SECONDS * 1000ULL;
    maximum_until = info.issued_at + CC_MAX_FRESH_SECONDS * 1000ULL;
    if (minimum_until < info.issued_at || maximum_until < info.issued_at
        || envelope.server_time < info.issued_at
        || envelope.launch_valid_until < minimum_until
        || envelope.launch_valid_until > maximum_until
        || envelope.server_time > envelope.launch_valid_until) {
        fwprintf(stderr, L"classcaller-launcher: ignored stale or inconsistent launcher SSE event\n");
        return CC_EXIT_INPUT;
    }
    return deliver_payload(config, envelope.launch_payload, &info);
}

static void sse_reset_frame(SseParser *parser)
{
    parser->data_length = 0;
    parser->data[0] = '\0';
    parser->frame_invalid = 0;
}

static void sse_dispatch(SseParser *parser)
{
    if (parser->data_length != 0 && !parser->frame_invalid) {
        parser->data[parser->data_length] = '\0';
        handle_watch_frame(parser->config, parser->data, parser->data_length);
    }
    sse_reset_frame(parser);
}

static void sse_process_line(SseParser *parser)
{
    char *line;
    SIZE_T length;
    SIZE_T value_start;
    SIZE_T append_length;
    ULONGLONG retry;
    SIZE_T i;

    if (parser->line_overflow) {
        parser->frame_invalid = 1;
        parser->line_length = 0;
        parser->line_overflow = 0;
        return;
    }
    line = parser->line;
    length = parser->line_length;
    parser->line[length] = '\0';
    parser->line_length = 0;

    if (parser->first_line) {
        parser->first_line = 0;
        if (length >= 3 && (unsigned char)line[0] == 0xef
            && (unsigned char)line[1] == 0xbb && (unsigned char)line[2] == 0xbf) {
            line += 3;
            length -= 3;
        }
    }
    if (length == 0) {
        sse_dispatch(parser);
        return;
    }
    if (line[0] == ':') return;
    if (length >= 5 && memcmp(line, "data:", 5) == 0) {
        value_start = 5;
        if (value_start < length && line[value_start] == ' ') ++value_start;
        append_length = length - value_start;
        if (parser->data_length != 0) {
            if (parser->data_length + 1 > CC_MAX_SSE_DATA_BYTES) {
                parser->frame_invalid = 1;
                return;
            }
            parser->data[parser->data_length++] = '\n';
        }
        if (parser->data_length + append_length > CC_MAX_SSE_DATA_BYTES) {
            parser->frame_invalid = 1;
            return;
        }
        memcpy(parser->data + parser->data_length, line + value_start, append_length);
        parser->data_length += append_length;
    } else if (length >= 6 && memcmp(line, "retry:", 6) == 0) {
        value_start = 6;
        if (value_start < length && line[value_start] == ' ') ++value_start;
        if (value_start == length) return;
        retry = 0;
        for (i = value_start; i < length; ++i) {
            if (line[i] < '0' || line[i] > '9') return;
            retry = retry * 10ULL + (ULONGLONG)(line[i] - '0');
            if (retry > 60000ULL) return;
        }
        if (retry >= 1000ULL) parser->retry_ms = (DWORD)retry;
    }
}

static void sse_feed(SseParser *parser, const char *bytes, SIZE_T length)
{
    SIZE_T i;
    char c;

    for (i = 0; i < length; ++i) {
        c = bytes[i];
        if (parser->previous_was_cr) {
            parser->previous_was_cr = 0;
            if (c == '\n') continue;
        }
        if (c == '\r' || c == '\n') {
            sse_process_line(parser);
            if (c == '\r') parser->previous_was_cr = 1;
            continue;
        }
        if (parser->line_overflow) continue;
        if (parser->line_length >= CC_MAX_SSE_LINE_BYTES) {
            parser->line_overflow = 1;
            continue;
        }
        parser->line[parser->line_length++] = c;
    }
}

static int parse_watch_url(const WCHAR *url, WatchUrl *result)
{
    URL_COMPONENTSW components;
    SIZE_T url_length;
    SIZE_T object_length;

    memset(result, 0, sizeof(*result));
    url_length = wcslen(url);
    if (url_length == 0 || url_length > 2047 || wcschr(url, L'#') != NULL) return 0;
    memset(&components, 0, sizeof(components));
    components.dwStructSize = sizeof(components);
    components.dwSchemeLength = (DWORD)-1;
    components.dwHostNameLength = (DWORD)-1;
    components.dwUserNameLength = (DWORD)-1;
    components.dwPasswordLength = (DWORD)-1;
    components.dwUrlPathLength = (DWORD)-1;
    components.dwExtraInfoLength = (DWORD)-1;
    if (!WinHttpCrackUrl(url, 0, 0, &components)) return 0;
    if (components.nScheme != INTERNET_SCHEME_HTTP && components.nScheme != INTERNET_SCHEME_HTTPS) return 0;
    if (components.dwUserNameLength != 0 || components.dwPasswordLength != 0
        || components.dwHostNameLength == 0
        || components.dwHostNameLength >= sizeof(result->host) / sizeof(result->host[0])) return 0;
    memcpy(result->host, components.lpszHostName, components.dwHostNameLength * sizeof(WCHAR));
    result->host[components.dwHostNameLength] = L'\0';

    object_length = components.dwUrlPathLength + components.dwExtraInfoLength;
    if (object_length == 0) {
        copy_wide(result->object, sizeof(result->object) / sizeof(result->object[0]), L"/");
    } else {
        if (object_length >= sizeof(result->object) / sizeof(result->object[0])) return 0;
        if (components.dwUrlPathLength != 0) {
            memcpy(result->object, components.lpszUrlPath,
                components.dwUrlPathLength * sizeof(WCHAR));
        }
        if (components.dwExtraInfoLength != 0) {
            memcpy(result->object + components.dwUrlPathLength, components.lpszExtraInfo,
                components.dwExtraInfoLength * sizeof(WCHAR));
        }
        result->object[object_length] = L'\0';
    }
    result->port = components.nPort;
    result->secure = components.nScheme == INTERNET_SCHEME_HTTPS;
    return 1;
}

static int content_type_is_sse(HINTERNET request)
{
    WCHAR content_type[128];
    DWORD bytes;

    bytes = sizeof(content_type);
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
        content_type, &bytes, WINHTTP_NO_HEADER_INDEX)) return 0;
    content_type[(sizeof(content_type) / sizeof(content_type[0])) - 1] = L'\0';
    return _wcsnicmp(content_type, L"text/event-stream", 17) == 0;
}

static int watch_once(const Config *config, const WatchUrl *url, DWORD *retry_ms)
{
    HINTERNET session;
    HINTERNET connection;
    HINTERNET request;
    DWORD flags;
    DWORD secure_protocols;
    DWORD status;
    DWORD status_size;
    char buffer[4096];
    DWORD received;
    SseParser *parser;
    int result;

    session = NULL;
    connection = NULL;
    request = NULL;
    parser = NULL;
    result = 0;

    session = WinHttpOpen(L"ClassCallerLauncher/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (session == NULL) goto network_error;
    if (url->secure) {
        secure_protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        if (!WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS,
                &secure_protocols, sizeof(secure_protocols))) goto network_error;
    }
    WinHttpSetTimeouts(session, 30000, 30000, 30000, 45000);
    connection = WinHttpConnect(session, url->host, url->port, 0);
    if (connection == NULL) goto network_error;
    flags = url->secure ? WINHTTP_FLAG_SECURE : 0;
    request = WinHttpOpenRequest(connection, L"GET", url->object, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (request == NULL) goto network_error;
    if (!WinHttpAddRequestHeaders(request,
            L"Accept: text/event-stream\r\nCache-Control: no-cache\r\n",
            (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE)
        || !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request, NULL)) goto network_error;

    status = 0;
    status_size = sizeof(status);
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) {
        goto network_error;
    }
    if (status != 200 || !content_type_is_sse(request)) {
        fwprintf(stderr, L"classcaller-launcher: watcher expected HTTP 200 text/event-stream (got %lu)\n",
            (unsigned long)status);
        goto cleanup;
    }

    parser = (SseParser *)calloc(1, sizeof(*parser));
    if (parser == NULL) goto cleanup;
    parser->first_line = 1;
    parser->retry_ms = *retry_ms;
    parser->config = config;
    fwprintf(stdout, L"classcaller-launcher: watcher connected\n");
    while (InterlockedCompareExchange(&g_stop_requested, 0, 0) == 0) {
        DWORD available = 0;
        /* 同步 WinHttpReadData 会等到填满缓冲区才返回，SSE 小帧会被卡住：先查可读字节数再读 */
        if (!WinHttpQueryDataAvailable(request, &available)) goto network_error;
        if (available == 0) break;
        if (available > sizeof(buffer)) available = sizeof(buffer);
        received = 0;
        if (!WinHttpReadData(request, buffer, available, &received)) goto network_error;
        if (received == 0) break;
        sse_feed(parser, buffer, received);
    }
    *retry_ms = parser->retry_ms;
    result = 1;
    goto cleanup;

network_error:
    if (InterlockedCompareExchange(&g_stop_requested, 0, 0) == 0) {
        print_windows_error(L"WinHTTP watcher", GetLastError());
    }
cleanup:
    if (parser != NULL) {
        *retry_ms = parser->retry_ms;
        free(parser);
    }
    if (request != NULL) WinHttpCloseHandle(request);
    if (connection != NULL) WinHttpCloseHandle(connection);
    if (session != NULL) WinHttpCloseHandle(session);
    return result;
}

static BOOL WINAPI console_control_handler(DWORD control_type)
{
    if (control_type == CTRL_C_EVENT || control_type == CTRL_BREAK_EVENT
        || control_type == CTRL_CLOSE_EVENT || control_type == CTRL_LOGOFF_EVENT
        || control_type == CTRL_SHUTDOWN_EVENT) {
        InterlockedExchange(&g_stop_requested, 1);
        return TRUE;
    }
    return FALSE;
}

static void interruptible_sleep(DWORD milliseconds)
{
    DWORD slept;
    DWORD step;

    slept = 0;
    while (slept < milliseconds && InterlockedCompareExchange(&g_stop_requested, 0, 0) == 0) {
        step = milliseconds - slept;
        if (step > 100) step = 100;
        Sleep(step);
        slept += step;
    }
}

static int watch_stream(const Config *config, const WCHAR *url_text)
{
    WatchUrl url;
    DWORD retry_ms;

    if (!parse_watch_url(url_text, &url)) {
        fwprintf(stderr, L"classcaller-launcher: --watch requires an HTTP or HTTPS URL without credentials or fragment\n");
        return CC_EXIT_INPUT;
    }
    retry_ms = 2000;
    InterlockedExchange(&g_stop_requested, 0);
    SetConsoleCtrlHandler(console_control_handler, TRUE);
    while (InterlockedCompareExchange(&g_stop_requested, 0, 0) == 0) {
        watch_once(config, &url, &retry_ms);
        if (InterlockedCompareExchange(&g_stop_requested, 0, 0) == 0) {
            fwprintf(stderr, L"classcaller-launcher: watcher reconnecting in %lu ms\n",
                (unsigned long)retry_ms);
            interruptible_sleep(retry_ms);
        }
    }
    SetConsoleCtrlHandler(console_control_handler, FALSE);
    fwprintf(stdout, L"classcaller-launcher: watcher stopped\n");
    return CC_EXIT_OK;
}

static int payload_argument_ascii(const WCHAR *argument, char *payload, SIZE_T capacity)
{
    SIZE_T i;
    SIZE_T length;

    length = wcslen(argument);
    if (length == 0 || length > CC_MAX_PAYLOAD_CHARS || length + 1 > capacity) return 0;
    for (i = 0; i < length; ++i) {
        if (argument[i] > 0x7f || base64url_value((char)argument[i]) < 0) return 0;
        payload[i] = (char)argument[i];
    }
    payload[length] = '\0';
    return 1;
}

int wmain(int argc, WCHAR **argv)
{
    const WCHAR *config_path;
    const WCHAR *mode;
    const WCHAR *mode_argument;
    int i;
    Config config;
    char payload[CC_MAX_PAYLOAD_CHARS + 1];
    PayloadInfo info;

    config_path = NULL;
    mode = NULL;
    mode_argument = NULL;
    for (i = 1; i < argc; ++i) {
        if (wcscmp(argv[i], L"--config") == 0) {
            if (config_path != NULL || i + 1 >= argc) {
                print_usage();
                return CC_EXIT_INPUT;
            }
            config_path = argv[++i];
        } else if (mode == NULL) {
            mode = argv[i];
        } else if (mode_argument == NULL) {
            mode_argument = argv[i];
        } else {
            print_usage();
            return CC_EXIT_INPUT;
        }
    }
    if (mode == NULL) {
        print_usage();
        return CC_EXIT_INPUT;
    }

    if (wcscmp(mode, L"--unregister-protocol") == 0) {
        if (mode_argument != NULL) {
            print_usage();
            return CC_EXIT_INPUT;
        }
        return unregister_protocol();
    }
    if (!load_config(config_path, &config)) return CC_EXIT_INPUT;

    if (wcscmp(mode, L"--register-protocol") == 0) {
        if (mode_argument != NULL) {
            print_usage();
            return CC_EXIT_INPUT;
        }
        return register_protocol(&config);
    }
    if (wcscmp(mode, L"--watch") == 0) {
        if (mode_argument == NULL) {
            print_usage();
            return CC_EXIT_INPUT;
        }
        return watch_stream(&config, mode_argument);
    }
    if (wcscmp(mode, L"--uri") == 0) {
        if (mode_argument == NULL || !uri_to_payload(mode_argument, payload, sizeof(payload))) {
            return CC_EXIT_INPUT;
        }
    } else if (wcscmp(mode, L"--payload-v1") == 0) {
        if (mode_argument == NULL || !payload_argument_ascii(mode_argument, payload, sizeof(payload))) {
            fwprintf(stderr, L"classcaller-launcher: --payload-v1 requires unpadded base64url\n");
            return CC_EXIT_INPUT;
        }
    } else {
        print_usage();
        return CC_EXIT_INPUT;
    }

    if (!validate_encoded_payload(payload, &info) || !direct_payload_is_fresh(&config, &info)) {
        return CC_EXIT_INPUT;
    }
    return deliver_payload(&config, payload, &info);
}
