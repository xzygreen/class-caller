/*
 * ClassCaller 大屏 —— 32 位原生 Win32 应用（Windows 7 SP1 / Windows 10，x86 与 x64 均可运行）。
 *
 * 职责：
 *   1. 启动后按 display.ini 里的 class_id 连接服务器 /api/classes/<class_id>/public/stream?role=display
 *      （WinHTTP，TLS 1.2），断线自动重连；每块大屏永久绑定一个班，没有 class_id 就拒绝启动；
 *   2. 收到新的找人通知时：恢复窗口、置顶、前置，全屏显示姓名与附加消息，并播放提示音；
 *      快照里的 classId 与本机绑定不符时一律丢弃，服务端异常也不会串班显示；
 *   3. 画面上有醒目的「收到」按钮：同学点击后 POST /api/classes/<class_id>/public/ack，按钮变为「已收到」并禁用；
 *      也可以直接点某个名字只确认这一个人；确认状态随 SSE 广播同步到所有大屏与教师端；
 *   4. 按服务器下发的 expiresAt 显示倒计时进度条，到期自动回到待机；
 *   5. 待机显示时钟、日期与班级名称/编号，方便巡检设备绑定是否正确；
 *   6. 服务器上找不到该班级时显示醒目的「班级绑定错误」，不展示任何通知。
 *
 * 单文件、无第三方依赖，只用 user32/gdi32/msimg32/winhttp/advapi32。
 */

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef WINVER
#define WINVER 0x0601
#endif
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <shellapi.h>
#include <winhttp.h>
#include <strsafe.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifndef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2
#define WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 0x00000800
#endif

#ifdef _MSC_VER
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "msimg32.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")
#endif

/* ---------- 常量 ---------- */
#define CC_PATH_CHARS        MAX_PATH
#define CC_MAX_NAMES         20
#define CC_MAX_NAME_UNITS    20
#define CC_MAX_MESSAGE_UNITS 60
#define CC_CALLER_UNITS      40      /* 「数学老师 · 张老师」：职务 + 姓名 */
#define CC_TITLE_UNITS       30      /* 留言标题 */
#define CC_BODY_UNITS        300     /* 留言正文 */
#define CC_MAX_SSE_LINE      16384
#define CC_MAX_SSE_DATA      16384
#define CC_MAX_URL           2048
#define CC_CLASS_NAME_UNITS  64
#define CC_CLASS_ID_UNITS    32      /* 服务端 CLASS_ID_RE：[a-z0-9][a-z0-9-]{0,31} */
#define CC_CLASS_CODE_UNITS  4

#define CC_WINDOW_CLASS  L"ClassCallerDisplayWindow"
#define CC_MUTEX_NAME    L"Local\\ClassCallerDisplay-SingleInstance"
#define CC_USER_AGENT    L"ClassCallerDisplay/2.0"
#define CC_APP_TITLE     L"老师找人通知大屏"
#define CC_DEFAULT_CALLER L"老师"     /* 快照没带 caller（旧服务端）时的通用身份 */

#define WM_APP_EVENT   (WM_APP + 1)   /* lParam = DisplayEvent*（堆分配，UI 线程释放） */
#define WM_APP_CONN    (WM_APP + 2)   /* wParam = 1 已连接 / 0 断开；lParam = 断开原因（WinHTTP 错误码或 HTTP 状态） */
#define WM_APP_CONFIG  (WM_APP + 3)   /* lParam = ClassInfo*（堆分配）；wParam = 0 正常 / 1 班级不存在 */
#define WM_APP_SHOW    (WM_APP + 4)   /* 第二个实例请求：把已有窗口拉到前台 */
#define WM_APP_ACK     (WM_APP + 5)   /* 「收到」请求结果：wParam = 1 成功 / 0 失败；lParam = AckJob*（UI 线程释放） */

#define TIMER_CLOCK    1
#define TIMER_PROGRESS 2
#define TIMER_CURSOR   3
#define TIMER_EXPIRE   4

/* 颜色（对应 public/tokens.css 的墨色阶与强调色） */
#define C_INK_900   RGB(0x08, 0x0B, 0x14)
#define C_INK_800   RGB(0x0B, 0x10, 0x20)
#define C_INK_700   RGB(0x12, 0x1A, 0x2E)
#define C_INK_600   RGB(0x1B, 0x25, 0x40)
#define C_ON_STRONG RGB(0xF2, 0xF5, 0xFB)
#define C_ON_BODY   RGB(0xB4, 0xC0, 0xD6)
#define C_ON_MUTED  RGB(0x7C, 0x8A, 0xA6)
#define C_GOLD      RGB(0xF0, 0xB4, 0x29)
#define C_GOLD_DIM  RGB(0x8A, 0x6A, 0x1F)
#define C_LIVE      RGB(0x2F, 0xBF, 0x71)
#define C_ALERT     RGB(0xE0, 0x48, 0x3C)
#define C_ALERT_TXT RGB(0xFF, 0x9B, 0x92)
#define C_WHITE     RGB(0xFF, 0xFF, 0xFF)
#define C_LIVE_DIM  RGB(0x13, 0x3A, 0x2A)   /* 「已收到」按钮底色 */

static const WCHAR *CC_FONT = L"Microsoft YaHei";

/* ---------- 数据结构 ---------- */
typedef struct Config {
    WCHAR ini_path[CC_PATH_CHARS];
    WCHAR server[CC_MAX_URL];        /* 例如 https://caller.example.com（无尾部斜杠） */
    WCHAR class_id[CC_CLASS_ID_UNITS + 1];  /* 本机绑定的班级内部标识，如 class-a */
    WCHAR log_path[CC_PATH_CHARS];
    int topmost_when_active;         /* 通知期间置顶 */
    int always_topmost;              /* 任何时候都置顶（教室专用机建议 1） */
    int sound;
    int start_minimized;
    int hide_cursor;
    int fullscreen;                  /* 1 = 无边框铺满屏幕；0 = 普通窗口（标题栏三个按钮）最大化 */
} Config;

typedef struct ClassInfo {
    WCHAR class_id[CC_CLASS_ID_UNITS + 1];
    WCHAR name[CC_CLASS_NAME_UNITS + 1];
    WCHAR code[CC_CLASS_CODE_UNITS + 1];
} ClassInfo;

typedef struct DisplayEvent {
    int is_call;                     /* type == "call"：点人 */
    int is_announcement;             /* type == "announcement"：班级留言（没有「收到」流程） */
    int priority;                    /* 1 紧急 / 2 定时 / 3 手动 / 4 留言 */
    int queued;                      /* 服务端等待显示的内容条数 */
    WCHAR title[CC_TITLE_UNITS + 1];     /* 留言标题 */
    WCHAR body[CC_BODY_UNITS + 1];       /* 留言正文（可含换行） */
    ULONGLONG id;
    WCHAR class_id[CC_CLASS_ID_UNITS + 1];   /* 快照里的 classId；必须与绑定一致才会显示 */
    int name_count;
    WCHAR names[CC_MAX_NAMES][CC_MAX_NAME_UNITS + 1];
    WCHAR message[CC_MAX_MESSAGE_UNITS + 1];
    WCHAR caller[CC_CALLER_UNITS + 1];
    ULONGLONG created_at;
    ULONGLONG expires_at;            /* 0 = 不自动清屏 */
    ULONGLONG server_time;
    int acked[CC_MAX_NAMES];         /* 与 names 对齐：1 = 该同学已点「收到」 */
} DisplayEvent;

typedef struct AckJob {
    ULONGLONG event_id;
    int name_count;                  /* 0 = 当前显示的全部姓名 */
    WCHAR names[CC_MAX_NAMES][CC_MAX_NAME_UNITS + 1];
    DWORD error;                     /* 失败时的 WinHTTP 错误码或 HTTP 状态 */
} AckJob;

typedef struct JsonParser {
    const unsigned char *data;
    SIZE_T length;
    SIZE_T pos;
    int depth;
} JsonParser;

typedef struct SseParser {
    char line[CC_MAX_SSE_LINE + 1];
    SIZE_T line_length;
    int line_overflow;
    int previous_was_cr;
    int first_line;
    char data[CC_MAX_SSE_DATA + 1];
    SIZE_T data_length;
    int frame_invalid;
    DWORD retry_ms;
} SseParser;

typedef struct UrlParts {
    WCHAR host[256];
    WCHAR object[CC_MAX_URL];
    INTERNET_PORT port;
    int secure;
} UrlParts;

/* ---------- 全局状态（UI 线程持有） ---------- */
static Config g_config;
static HWND g_hwnd = NULL;
static HINSTANCE g_instance = NULL;
static volatile LONG g_stop = 0;
static HANDLE g_net_thread = NULL;

static DisplayEvent g_current;
static ULONGLONG g_last_id = 0;
static int g_connected = 0;
static int g_preview = 0;
static WCHAR g_class_name[CC_CLASS_NAME_UNITS + 1] = L"";
static WCHAR g_class_code[CC_CLASS_CODE_UNITS + 1] = L"";
static int g_bind_error = 0;                   /* 1 = 服务器上没有这个班级：只显示绑定错误，不显示任何通知 */
static WCHAR g_conn_text[64] = L"连接中";
static WCHAR g_conn_hint[160] = L"";
static DWORD g_conn_error = 0;
static ULONGLONG g_expiry_local = 0;   /* 本机时钟下的到期时刻（unix ms） */
static ULONGLONG g_total_ms = 0;
static int g_cursor_visible = 0;
static int g_is_topmost = 0;
static HANDLE g_log = INVALID_HANDLE_VALUE;
static int g_ack_busy = 0;
static RECT g_ack_rect;                        /* 「收到」按钮的命中区域（客户区坐标） */
static RECT g_name_rects[CC_MAX_NAMES];        /* 每个姓名的命中区域 */
static int g_name_rect_count = 0;
static WCHAR g_ack_note[96] = L"";
static ULONGLONG g_ack_note_until = 0;

/* ================= 工具 ================= */

static ULONGLONG unix_ms_now(void)
{
    FILETIME ft;
    ULARGE_INTEGER t;
    GetSystemTimeAsFileTime(&ft);
    t.LowPart = ft.dwLowDateTime;
    t.HighPart = ft.dwHighDateTime;
    if (t.QuadPart < 116444736000000000ULL) return 0;
    return (t.QuadPart - 116444736000000000ULL) / 10000ULL;
}

static void log_line(const WCHAR *format, ...)
{
    WCHAR text[1024];
    char utf8[3072];
    SYSTEMTIME st;
    va_list args;
    int bytes;
    DWORD written;
    size_t used;

    if (g_log == INVALID_HANDLE_VALUE) return;
    GetLocalTime(&st);
    StringCchPrintfW(text, 1024, L"%04u-%02u-%02u %02u:%02u:%02u ",
        st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
    used = wcslen(text);
    va_start(args, format);
    StringCchVPrintfW(text + used, 1024 - used, format, args);
    va_end(args);
    StringCchCatW(text, 1024, L"\r\n");
    bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof(utf8), NULL, NULL);
    if (bytes <= 1) return;
    WriteFile(g_log, utf8, (DWORD)(bytes - 1), &written, NULL);
}

static void log_windows_error(const WCHAR *operation, DWORD error)
{
    WCHAR message[512];
    DWORD count;

    message[0] = L'\0';
    count = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        NULL, error, 0, message, 512, NULL);
    while (count > 0 && (message[count - 1] == L'\r' || message[count - 1] == L'\n')) {
        message[--count] = L'\0';
    }
    log_line(L"%ls failed (%lu): %ls", operation, (unsigned long)error, message);
}

/* ================= 配置 ================= */

static int exe_directory(WCHAR *out, SIZE_T capacity)
{
    WCHAR path[CC_PATH_CHARS];
    WCHAR *slash;
    DWORD length;

    length = GetModuleFileNameW(NULL, path, CC_PATH_CHARS);
    if (length == 0 || length >= CC_PATH_CHARS) return 0;
    slash = wcsrchr(path, L'\\');
    if (slash == NULL) return 0;
    slash[1] = L'\0';
    return SUCCEEDED(StringCchCopyW(out, capacity, path));
}

static int read_ini_bool(const WCHAR *ini, const WCHAR *key, int fallback)
{
    return (int)GetPrivateProfileIntW(L"display", key, fallback, ini) != 0;
}

/* 与服务端 CLASS_ID_RE 一致：小写字母/数字开头，之后允许连字符，最多 32 位 */
static int class_id_valid(const WCHAR *id)
{
    SIZE_T i, n = wcslen(id);
    if (n == 0 || n > CC_CLASS_ID_UNITS) return 0;
    for (i = 0; i < n; ++i) {
        WCHAR c = id[i];
        int alnum = (c >= L'a' && c <= L'z') || (c >= L'0' && c <= L'9');
        if (i == 0 ? !alnum : !(alnum || c == L'-')) return 0;
    }
    return 1;
}

static void load_config(const WCHAR *requested_ini, const WCHAR *server_override, const WCHAR *class_override)
{
    WCHAR directory[CC_PATH_CHARS];
    SIZE_T length;

    memset(&g_config, 0, sizeof(g_config));
    if (!exe_directory(directory, CC_PATH_CHARS)) directory[0] = L'\0';

    if (requested_ini != NULL) {
        GetFullPathNameW(requested_ini, CC_PATH_CHARS, g_config.ini_path, NULL);
    } else {
        StringCchCopyW(g_config.ini_path, CC_PATH_CHARS, directory);
        StringCchCatW(g_config.ini_path, CC_PATH_CHARS, L"display.ini");
    }

    GetPrivateProfileStringW(L"display", L"server", L"", g_config.server, CC_MAX_URL, g_config.ini_path);
    if (server_override != NULL) StringCchCopyW(g_config.server, CC_MAX_URL, server_override);
    length = wcslen(g_config.server);
    while (length > 0 && g_config.server[length - 1] == L'/') g_config.server[--length] = L'\0';

    GetPrivateProfileStringW(L"display", L"class_id", L"", g_config.class_id, CC_CLASS_ID_UNITS + 1, g_config.ini_path);
    if (class_override != NULL) StringCchCopyW(g_config.class_id, CC_CLASS_ID_UNITS + 1, class_override);
    length = wcslen(g_config.class_id);
    while (length > 0 && (g_config.class_id[length - 1] == L' ' || g_config.class_id[length - 1] == L'\t')) {
        g_config.class_id[--length] = L'\0';
    }

    g_config.topmost_when_active = read_ini_bool(g_config.ini_path, L"topmost_when_active", 1);
    g_config.always_topmost = read_ini_bool(g_config.ini_path, L"always_topmost", 0);
    g_config.sound = read_ini_bool(g_config.ini_path, L"sound", 1);
    g_config.start_minimized = read_ini_bool(g_config.ini_path, L"start_minimized", 0);
    g_config.hide_cursor = read_ini_bool(g_config.ini_path, L"hide_cursor", 1);
    g_config.fullscreen = read_ini_bool(g_config.ini_path, L"fullscreen", 0);

    if (read_ini_bool(g_config.ini_path, L"log", 1) && directory[0] != L'\0') {
        StringCchCopyW(g_config.log_path, CC_PATH_CHARS, directory);
        StringCchCatW(g_config.log_path, CC_PATH_CHARS, L"display.log");
    }
}

/* ================= 极简 JSON 解析（只解析服务端快照，拒绝一切异常输入） ================= */

static void json_skip_space(JsonParser *p)
{
    while (p->pos < p->length) {
        unsigned char c = p->data[p->pos];
        if (c != ' ' && c != '\t' && c != '\r' && c != '\n') break;
        ++p->pos;
    }
}

static int json_peek(JsonParser *p)
{
    json_skip_space(p);
    return p->pos < p->length ? p->data[p->pos] : -1;
}

static int json_expect(JsonParser *p, unsigned char expected)
{
    if (json_peek(p) != expected) return 0;
    ++p->pos;
    return 1;
}

static int json_hex4(JsonParser *p, DWORD *value)
{
    DWORD result = 0;
    int i;
    for (i = 0; i < 4; ++i) {
        unsigned char c;
        if (p->pos >= p->length) return 0;
        c = p->data[p->pos++];
        result <<= 4;
        if (c >= '0' && c <= '9') result |= (DWORD)(c - '0');
        else if (c >= 'a' && c <= 'f') result |= (DWORD)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') result |= (DWORD)(c - 'A' + 10);
        else return 0;
    }
    *value = result;
    return 1;
}

static int utf8_next(const unsigned char *data, SIZE_T length, SIZE_T *position, DWORD *codepoint)
{
    SIZE_T i = *position;
    unsigned char a, b, c, d;

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
        b = data[i++]; c = data[i++];
        if ((b & 0xc0) != 0x80 || (c & 0xc0) != 0x80) return 0;
        if ((a == 0xe0 && b < 0xa0) || (a == 0xed && b >= 0xa0)) return 0;
        *codepoint = ((DWORD)(a & 0x0f) << 12) | ((DWORD)(b & 0x3f) << 6) | (DWORD)(c & 0x3f);
    } else if (a >= 0xf0 && a <= 0xf4) {
        if (i + 2 >= length) return 0;
        b = data[i++]; c = data[i++]; d = data[i++];
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

/* 解析字符串到 UTF-16；output 为 NULL 时只跳过。超长直接判失败。 */
static int json_parse_string(JsonParser *p, WCHAR *output, SIZE_T capacity, SIZE_T *unit_count)
{
    SIZE_T units = 0;

    if (!json_expect(p, '"')) return 0;
    while (p->pos < p->length) {
        unsigned char c = p->data[p->pos++];
        DWORD codepoint;
        if (c == '"') {
            if (output != NULL) output[units] = L'\0';
            if (unit_count != NULL) *unit_count = units;
            return 1;
        }
        if (c < 0x20) return 0;
        if (c == '\\') {
            if (p->pos >= p->length) return 0;
            c = p->data[p->pos++];
            if (c == '"' || c == '\\' || c == '/') codepoint = c;
            else if (c == 'b') codepoint = 0x08;
            else if (c == 'f') codepoint = 0x0c;
            else if (c == 'n') codepoint = 0x0a;
            else if (c == 'r') codepoint = 0x0d;
            else if (c == 't') codepoint = 0x09;
            else if (c == 'u') {
                DWORD first, second;
                if (!json_hex4(p, &first)) return 0;
                if (first >= 0xd800 && first <= 0xdbff) {
                    if (p->pos + 1 >= p->length || p->data[p->pos] != '\\' || p->data[p->pos + 1] != 'u') return 0;
                    p->pos += 2;
                    if (!json_hex4(p, &second) || second < 0xdc00 || second > 0xdfff) return 0;
                    codepoint = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
                } else if (first >= 0xdc00 && first <= 0xdfff) {
                    return 0;
                } else {
                    codepoint = first;
                }
            } else {
                return 0;
            }
        } else if (c < 0x80) {
            codepoint = c;
        } else {
            SIZE_T start = p->pos - 1;
            if (!utf8_next(p->data, p->length, &start, &codepoint)) return 0;
            p->pos = start;
        }
        if (codepoint == 0) return 0;
        if (codepoint <= 0xffff) {
            if (output != NULL) {
                if (units + 1 >= capacity) return 0;
                output[units] = (WCHAR)codepoint;
            }
            units += 1;
        } else {
            if (output != NULL) {
                if (units + 2 >= capacity) return 0;
                codepoint -= 0x10000;
                output[units] = (WCHAR)(0xd800 + (codepoint >> 10));
                output[units + 1] = (WCHAR)(0xdc00 + (codepoint & 0x3ff));
            }
            units += 2;
        }
    }
    return 0;
}

static int json_parse_uint64(JsonParser *p, ULONGLONG *value)
{
    ULONGLONG result = 0;
    int digits = 0;

    json_skip_space(p);
    while (p->pos < p->length) {
        unsigned char c = p->data[p->pos];
        if (c < '0' || c > '9') break;
        if (result > 9007199254740991ULL / 10ULL) return 0;
        result = result * 10ULL + (ULONGLONG)(c - '0');
        ++p->pos;
        ++digits;
    }
    if (digits == 0) return 0;
    *value = result;
    return 1;
}

static int json_skip_value(JsonParser *p);

static int json_skip_container(JsonParser *p, unsigned char open, unsigned char close)
{
    if (!json_expect(p, open)) return 0;
    if (json_peek(p) == close) { ++p->pos; return 1; }
    for (;;) {
        if (open == '{') {
            if (!json_parse_string(p, NULL, 0, NULL) || !json_expect(p, ':')) return 0;
        }
        if (!json_skip_value(p)) return 0;
        if (json_peek(p) == ',') { ++p->pos; continue; }
        if (json_peek(p) == close) { ++p->pos; return 1; }
        return 0;
    }
}

static int json_skip_value(JsonParser *p)
{
    int c = json_peek(p);
    int ok;

    if (++p->depth > 32) { --p->depth; return 0; }
    if (c == '"') ok = json_parse_string(p, NULL, 0, NULL);
    else if (c == '{') ok = json_skip_container(p, '{', '}');
    else if (c == '[') ok = json_skip_container(p, '[', ']');
    else if (c == 't' && p->pos + 4 <= p->length && memcmp(p->data + p->pos, "true", 4) == 0) { p->pos += 4; ok = 1; }
    else if (c == 'f' && p->pos + 5 <= p->length && memcmp(p->data + p->pos, "false", 5) == 0) { p->pos += 5; ok = 1; }
    else if (c == 'n' && p->pos + 4 <= p->length && memcmp(p->data + p->pos, "null", 4) == 0) { p->pos += 4; ok = 1; }
    else {
        /* 数字：宽松跳过合法字符即可，值本身不用 */
        SIZE_T start = p->pos;
        while (p->pos < p->length) {
            unsigned char d = p->data[p->pos];
            if ((d >= '0' && d <= '9') || d == '-' || d == '+' || d == '.' || d == 'e' || d == 'E') ++p->pos;
            else break;
        }
        ok = p->pos > start;
    }
    --p->depth;
    return ok;
}

static int text_has_control(const WCHAR *text)
{
    SIZE_T i;
    for (i = 0; text[i] != L'\0'; ++i) {
        if (text[i] < 0x20 || text[i] == 0x7f) return 1;
    }
    return 0;
}

/* 留言正文允许换行，其它控制字符仍然拒绝 */
static int text_has_control_except_newline(const WCHAR *text)
{
    for (; *text != L'\0'; ++text) {
        if (*text == L'\n' || *text == L'\r') continue;
        if (*text < 0x20 || *text == 0x7f) return 1;
    }
    return 0;
}

static int parse_names(JsonParser *p, DisplayEvent *event)
{
    SIZE_T units;

    if (!json_expect(p, '[')) return 0;
    event->name_count = 0;
    if (json_peek(p) == ']') { ++p->pos; return 1; }
    for (;;) {
        if (event->name_count >= CC_MAX_NAMES) return 0;
        if (!json_parse_string(p, event->names[event->name_count], CC_MAX_NAME_UNITS + 1, &units)) return 0;
        if (units == 0 || text_has_control(event->names[event->name_count])) return 0;
        ++event->name_count;
        if (json_peek(p) == ',') { ++p->pos; continue; }
        if (json_peek(p) == ']') { ++p->pos; return 1; }
        return 0;
    }
}

/* acks: [{ name, at }, ...] —— 只取 name，暂存到 acked_names */
static int parse_acks(JsonParser *p, WCHAR acked_names[][CC_MAX_NAME_UNITS + 1], int *acked_count)
{
    WCHAR key[64];
    WCHAR name[CC_MAX_NAME_UNITS + 1];

    *acked_count = 0;
    if (!json_expect(p, '[')) return 0;
    if (json_peek(p) == ']') { ++p->pos; return 1; }
    for (;;) {
        int has_name = 0;
        if (!json_expect(p, '{')) return 0;
        if (json_peek(p) == '}') { ++p->pos; }
        else for (;;) {
            if (!json_parse_string(p, key, 64, NULL) || !json_expect(p, ':')) return 0;
            if (wcscmp(key, L"name") == 0) {
                if (!json_parse_string(p, name, CC_MAX_NAME_UNITS + 1, NULL)) return 0;
                has_name = 1;
            } else if (!json_skip_value(p)) {
                return 0;
            }
            if (json_peek(p) == ',') { ++p->pos; continue; }
            if (json_peek(p) == '}') { ++p->pos; break; }
            return 0;
        }
        if (has_name && *acked_count < CC_MAX_NAMES) {
            StringCchCopyW(acked_names[*acked_count], CC_MAX_NAME_UNITS + 1, name);
            ++*acked_count;
        }
        if (json_peek(p) == ',') { ++p->pos; continue; }
        if (json_peek(p) == ']') { ++p->pos; return 1; }
        return 0;
    }
}

/*
 * 解析 SSE 快照：{ type, id, names, message, caller, createdAt, expiresAt|null, serverTime, acks, ... }
 * 返回 1 表示 event 可用；其他字段一律跳过。
 */
static int parse_snapshot(const char *json, SIZE_T length, DisplayEvent *event)
{
    JsonParser p;
    WCHAR key[64];
    WCHAR type[16];
    WCHAR acked_names[CC_MAX_NAMES][CC_MAX_NAME_UNITS + 1];
    int seen_type = 0, seen_id = 0, acked_count = 0, i, j;

    memset(event, 0, sizeof(*event));
    memset(&p, 0, sizeof(p));
    p.data = (const unsigned char *)json;
    p.length = length;

    if (!json_expect(&p, '{')) return 0;
    if (json_peek(&p) == '}') return 0;
    for (;;) {
        if (!json_parse_string(&p, key, 64, NULL) || !json_expect(&p, ':')) return 0;
        if (wcscmp(key, L"type") == 0) {
            if (!json_parse_string(&p, type, 16, NULL)) return 0;
            seen_type = 1;
        } else if (wcscmp(key, L"id") == 0) {
            if (!json_parse_uint64(&p, &event->id)) return 0;
            seen_id = 1;
        } else if (wcscmp(key, L"classId") == 0) {
            if (!json_parse_string(&p, event->class_id, CC_CLASS_ID_UNITS + 1, NULL)) return 0;
        } else if (wcscmp(key, L"names") == 0) {
            if (!parse_names(&p, event)) return 0;
        } else if (wcscmp(key, L"message") == 0) {
            if (!json_parse_string(&p, event->message, CC_MAX_MESSAGE_UNITS + 1, NULL)) return 0;
            if (text_has_control(event->message)) return 0;
        } else if (wcscmp(key, L"caller") == 0) {
            /* clear 快照的 caller 是空串，不能当成畸形帧丢掉，否则老师手动清屏时 exe 不清 */
            if (!json_parse_string(&p, event->caller, CC_CALLER_UNITS + 1, NULL)) return 0;
            if (text_has_control(event->caller)) return 0;
        } else if (wcscmp(key, L"title") == 0) {
            if (!json_parse_string(&p, event->title, CC_TITLE_UNITS + 1, NULL)) return 0;
            if (text_has_control(event->title)) return 0;
        } else if (wcscmp(key, L"body") == 0) {
            if (!json_parse_string(&p, event->body, CC_BODY_UNITS + 1, NULL)) return 0;
            if (text_has_control_except_newline(event->body)) return 0;
        } else if (wcscmp(key, L"author") == 0) {
            /* 留言的发布人；点人快照没有这个字段，用 caller */
            if (!json_parse_string(&p, event->caller, CC_CALLER_UNITS + 1, NULL)) return 0;
            if (text_has_control(event->caller)) return 0;
        } else if (wcscmp(key, L"priority") == 0) {
            ULONGLONG v;
            if (!json_parse_uint64(&p, &v)) return 0;
            event->priority = (int)(v > 9 ? 9 : v);
        } else if (wcscmp(key, L"queued") == 0) {
            ULONGLONG v;
            if (!json_parse_uint64(&p, &v)) return 0;
            event->queued = (int)(v > 99 ? 99 : v);
        } else if (wcscmp(key, L"createdAt") == 0) {
            if (!json_parse_uint64(&p, &event->created_at)) return 0;
        } else if (wcscmp(key, L"serverTime") == 0) {
            if (!json_parse_uint64(&p, &event->server_time)) return 0;
        } else if (wcscmp(key, L"expiresAt") == 0) {
            if (json_peek(&p) == 'n') {
                if (!json_skip_value(&p)) return 0;
                event->expires_at = 0;
            } else if (!json_parse_uint64(&p, &event->expires_at)) {
                return 0;
            }
        } else if (wcscmp(key, L"acks") == 0) {
            if (!parse_acks(&p, acked_names, &acked_count)) return 0;
        } else if (!json_skip_value(&p)) {
            return 0;
        }
        if (json_peek(&p) == ',') { ++p.pos; continue; }
        if (json_peek(&p) == '}') { ++p.pos; break; }
        return 0;
    }
    json_skip_space(&p);
    if (p.pos != p.length || !seen_type || !seen_id) return 0;
    event->is_call = wcscmp(type, L"call") == 0;
    event->is_announcement = wcscmp(type, L"announcement") == 0;
    if (event->is_call && event->name_count == 0) return 0;
    if (event->is_announcement && event->title[0] == L'\0' && event->body[0] == L'\0') return 0;
    for (i = 0; i < acked_count; ++i) {
        for (j = 0; j < event->name_count; ++j) {
            if (wcscmp(acked_names[i], event->names[j]) == 0) event->acked[j] = 1;
        }
    }
    return 1;
}

/*
 * /api/classes/<id>/public/config：取 classId / className / code。
 * 返回 1 = 解析成功（*not_found 标记服务端明确回答该班级不存在），0 = 解析失败。
 */
static int parse_public_config(const char *json, SIZE_T length, ClassInfo *info, int *not_found)
{
    JsonParser p;
    WCHAR key[64];
    WCHAR value[64];

    memset(&p, 0, sizeof(p));
    p.data = (const unsigned char *)json;
    p.length = length;
    memset(info, 0, sizeof(*info));
    *not_found = 0;
    if (!json_expect(&p, '{')) return 0;
    if (json_peek(&p) == '}') return 1;
    for (;;) {
        if (!json_parse_string(&p, key, 64, NULL) || !json_expect(&p, ':')) return 0;
        if (wcscmp(key, L"className") == 0) {
            if (!json_parse_string(&p, info->name, CC_CLASS_NAME_UNITS + 1, NULL)) return 0;
        } else if (wcscmp(key, L"classId") == 0) {
            if (!json_parse_string(&p, info->class_id, CC_CLASS_ID_UNITS + 1, NULL)) return 0;
        } else if (wcscmp(key, L"code") == 0) {
            if (!json_parse_string(&p, info->code, CC_CLASS_CODE_UNITS + 1, NULL)) return 0;
        } else if (wcscmp(key, L"error") == 0) {
            if (!json_parse_string(&p, value, 64, NULL)) return 0;
            if (wcscmp(value, L"CLASS_NOT_FOUND") == 0) *not_found = 1;
        } else if (!json_skip_value(&p)) {
            return 0;
        }
        if (json_peek(&p) == ',') { ++p.pos; continue; }
        if (json_peek(&p) == '}') { ++p.pos; return 1; }
        return 0;
    }
}

/* ================= SSE 解析 ================= */

static void sse_dispatch(SseParser *parser)
{
    DisplayEvent *event;

    if (parser->data_length != 0 && !parser->frame_invalid) {
        parser->data[parser->data_length] = '\0';
        event = (DisplayEvent *)malloc(sizeof(*event));
        if (event != NULL) {
            if (!parse_snapshot(parser->data, parser->data_length, event)) {
                log_line(L"ignored malformed SSE frame (%lu bytes)", (unsigned long)parser->data_length);
                free(event);
            } else if (wcscmp(event->class_id, g_config.class_id) != 0) {
                /* 服务端即便出错发来别班的快照，也绝不能显示到本班大屏上 */
                log_line(L"rejected frame id=%I64u for class '%ls' (bound to '%ls')",
                    event->id, event->class_id, g_config.class_id);
                free(event);
            } else {
                log_line(L"frame id=%I64u type=%ls names=%d queued=%d", event->id,
                    event->is_call ? L"call" : (event->is_announcement ? L"announcement" : L"clear"),
                    event->name_count, event->queued);
                if (!PostMessageW(g_hwnd, WM_APP_EVENT, 0, (LPARAM)event)) free(event);
            }
        }
    }
    parser->data_length = 0;
    parser->frame_invalid = 0;
}

static void sse_process_line(SseParser *parser)
{
    char *line;
    SIZE_T length, value_start, append_length, i;
    ULONGLONG retry;

    if (parser->line_overflow) {
        parser->frame_invalid = 1;
        parser->line_length = 0;
        parser->line_overflow = 0;
        return;
    }
    line = parser->line;
    length = parser->line_length;
    line[length] = '\0';
    parser->line_length = 0;

    if (parser->first_line) {
        parser->first_line = 0;
        if (length >= 3 && (unsigned char)line[0] == 0xef && (unsigned char)line[1] == 0xbb
            && (unsigned char)line[2] == 0xbf) { line += 3; length -= 3; }
    }
    if (length == 0) { sse_dispatch(parser); return; }
    if (line[0] == ':') return;                       /* 心跳 */
    if (length >= 5 && memcmp(line, "data:", 5) == 0) {
        value_start = 5;
        if (value_start < length && line[value_start] == ' ') ++value_start;
        append_length = length - value_start;
        if (parser->data_length != 0) {
            if (parser->data_length + 1 > CC_MAX_SSE_DATA) { parser->frame_invalid = 1; return; }
            parser->data[parser->data_length++] = '\n';
        }
        if (parser->data_length + append_length > CC_MAX_SSE_DATA) { parser->frame_invalid = 1; return; }
        memcpy(parser->data + parser->data_length, line + value_start, append_length);
        parser->data_length += append_length;
    } else if (length >= 6 && memcmp(line, "event:", 6) == 0) {
        /* "event: bye" 表示服务端主动关闭，后面连接会自然结束并重连；这一帧不当作快照 */
        parser->frame_invalid = 1;
    } else if (length >= 6 && memcmp(line, "retry:", 6) == 0) {
        value_start = 6;
        if (value_start < length && line[value_start] == ' ') ++value_start;
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
    for (i = 0; i < length; ++i) {
        char c = bytes[i];
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
        if (parser->line_length >= CC_MAX_SSE_LINE) { parser->line_overflow = 1; continue; }
        parser->line[parser->line_length++] = c;
    }
}

/* ================= WinHTTP ================= */

static int parse_url(const WCHAR *url, UrlParts *result)
{
    URL_COMPONENTSW c;
    SIZE_T object_length;

    memset(result, 0, sizeof(*result));
    if (wcslen(url) == 0 || wcslen(url) >= CC_MAX_URL || wcschr(url, L'#') != NULL) return 0;
    memset(&c, 0, sizeof(c));
    c.dwStructSize = sizeof(c);
    c.dwSchemeLength = (DWORD)-1;
    c.dwHostNameLength = (DWORD)-1;
    c.dwUserNameLength = (DWORD)-1;
    c.dwPasswordLength = (DWORD)-1;
    c.dwUrlPathLength = (DWORD)-1;
    c.dwExtraInfoLength = (DWORD)-1;
    if (!WinHttpCrackUrl(url, 0, 0, &c)) return 0;
    if (c.nScheme != INTERNET_SCHEME_HTTP && c.nScheme != INTERNET_SCHEME_HTTPS) return 0;
    if (c.dwUserNameLength != 0 || c.dwPasswordLength != 0 || c.dwHostNameLength == 0
        || c.dwHostNameLength >= 256) return 0;
    memcpy(result->host, c.lpszHostName, c.dwHostNameLength * sizeof(WCHAR));
    result->host[c.dwHostNameLength] = L'\0';
    object_length = c.dwUrlPathLength + c.dwExtraInfoLength;
    if (object_length == 0) {
        StringCchCopyW(result->object, CC_MAX_URL, L"/");
    } else {
        if (object_length >= CC_MAX_URL) return 0;
        if (c.dwUrlPathLength != 0) memcpy(result->object, c.lpszUrlPath, c.dwUrlPathLength * sizeof(WCHAR));
        if (c.dwExtraInfoLength != 0) {
            memcpy(result->object + c.dwUrlPathLength, c.lpszExtraInfo, c.dwExtraInfoLength * sizeof(WCHAR));
        }
        result->object[object_length] = L'\0';
    }
    result->port = c.nPort;
    result->secure = c.nScheme == INTERNET_SCHEME_HTTPS;
    return 1;
}

/*
 * WinHTTP 默认不读 IE/系统代理设置，而学校机房常常只配置了 IE 代理。
 * 这里显式取当前用户的 IE 代理：有固定代理就用它，否则直连。
 */
static HINTERNET open_session(int secure)
{
    HINTERNET session;
    DWORD protocols;
    WINHTTP_CURRENT_USER_IE_PROXY_CONFIG ie;
    static int logged_proxy = 0;

    memset(&ie, 0, sizeof(ie));
    if (WinHttpGetIEProxyConfigForCurrentUser(&ie) && ie.lpszProxy != NULL && ie.lpszProxy[0] != L'\0') {
        session = WinHttpOpen(CC_USER_AGENT, WINHTTP_ACCESS_TYPE_NAMED_PROXY,
            ie.lpszProxy, ie.lpszProxyBypass != NULL ? ie.lpszProxyBypass : WINHTTP_NO_PROXY_BYPASS, 0);
        if (!logged_proxy) { log_line(L"using IE proxy: %ls", ie.lpszProxy); logged_proxy = 1; }
    } else {
        session = WinHttpOpen(CC_USER_AGENT, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
            WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    }
    if (ie.lpszProxy) GlobalFree(ie.lpszProxy);
    if (ie.lpszProxyBypass) GlobalFree(ie.lpszProxyBypass);
    if (ie.lpszAutoConfigUrl) GlobalFree(ie.lpszAutoConfigUrl);
    if (session == NULL) return NULL;
    if (secure) {
        /* Win7 未打 TLS 1.2 补丁时这个调用会失败；忽略失败让系统用默认协议再试一次，错误会体现在连接阶段 */
        protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        if (!WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols))) {
            log_windows_error(L"enable TLS 1.2", GetLastError());
        }
    }
    return session;
}

/* 一次性 GET，读取最多 max_bytes；用于班级 public/config。200 与 404 都读取正文（404 正文里有 CLASS_NOT_FOUND） */
static int http_get_small(const WCHAR *url, char *buffer, SIZE_T max_bytes, SIZE_T *received_total, DWORD *http_status)
{
    UrlParts parts;
    HINTERNET session = NULL, connection = NULL, request = NULL;
    DWORD status = 0, status_size = sizeof(status), received;
    int ok = 0;

    *received_total = 0;
    *http_status = 0;
    if (!parse_url(url, &parts)) return 0;
    session = open_session(parts.secure);
    if (session == NULL) goto done;
    WinHttpSetTimeouts(session, 10000, 10000, 10000, 15000);
    connection = WinHttpConnect(session, parts.host, parts.port, 0);
    if (connection == NULL) goto done;
    request = WinHttpOpenRequest(connection, L"GET", parts.object, NULL, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, parts.secure ? WINHTTP_FLAG_SECURE : 0);
    if (request == NULL) goto done;
    if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request, NULL)) goto done;
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) goto done;
    *http_status = status;
    if (status != 200 && status != 404) goto done;
    for (;;) {
        DWORD available = 0;
        received = 0;
        if (*received_total >= max_bytes - 1) break;
        if (!WinHttpQueryDataAvailable(request, &available)) goto done;
        if (available == 0) break;
        if (available > max_bytes - 1 - *received_total) available = (DWORD)(max_bytes - 1 - *received_total);
        if (!WinHttpReadData(request, buffer + *received_total, available, &received)) goto done;
        if (received == 0) break;
        *received_total += received;
    }
    buffer[*received_total] = '\0';
    ok = 1;
done:
    if (!ok) log_windows_error(L"GET config", GetLastError());
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    if (session) WinHttpCloseHandle(session);
    return ok;
}

/*
 * 拉本班的公开配置。返回 1 = 拿到了班级信息（已交给 UI 线程），0 = 暂时失败下次再试。
 * 服务端明确回答班级不存在时，向 UI 线程报告绑定错误，同样返回 1（不再重复请求）。
 */
static int fetch_public_config(void)
{
    WCHAR url[CC_MAX_URL];
    char body[8192];
    SIZE_T length;
    DWORD status;
    int not_found = 0;
    ClassInfo *info;

    if (FAILED(StringCchPrintfW(url, CC_MAX_URL, L"%ls/api/classes/%ls/public/config",
            g_config.server, g_config.class_id))) return 0;
    if (!http_get_small(url, body, sizeof(body), &length, &status)) return 0;
    info = (ClassInfo *)malloc(sizeof(*info));
    if (info == NULL) return 0;
    if (!parse_public_config(body, length, info, &not_found)) {
        free(info);
        return 0;
    }
    if (status == 404 || not_found) {
        log_line(L"class binding error: server has no class '%ls' (HTTP %lu)", g_config.class_id, (unsigned long)status);
        if (!PostMessageW(g_hwnd, WM_APP_CONFIG, 1, (LPARAM)info)) free(info);
        return 1;
    }
    /* 服务端返回的 classId 必须与本机绑定一致，否则同样视为绑定错误 */
    if (wcscmp(info->class_id, g_config.class_id) != 0) {
        log_line(L"class binding error: config classId '%ls' != bound '%ls'", info->class_id, g_config.class_id);
        if (!PostMessageW(g_hwnd, WM_APP_CONFIG, 1, (LPARAM)info)) free(info);
        return 1;
    }
    if (!PostMessageW(g_hwnd, WM_APP_CONFIG, 0, (LPARAM)info)) free(info);
    return 1;
}

static int content_type_is_sse(HINTERNET request)
{
    WCHAR content_type[128];
    DWORD bytes = sizeof(content_type);
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_CONTENT_TYPE, WINHTTP_HEADER_NAME_BY_INDEX,
        content_type, &bytes, WINHTTP_NO_HEADER_INDEX)) return 0;
    content_type[127] = L'\0';
    return _wcsnicmp(content_type, L"text/event-stream", 17) == 0;
}

/* 保持一次 SSE 连接直到断开；返回时 *retry_ms 已按服务端 retry 更新 */
static void watch_once(const UrlParts *url, DWORD *retry_ms)
{
    HINTERNET session = NULL, connection = NULL, request = NULL;
    DWORD status = 0, status_size = sizeof(status), received;
    char buffer[4096];
    SseParser *parser = NULL;
    int announced = 0;

    session = open_session(url->secure);
    if (session == NULL) goto network_error;
    /* 接收超时要比服务端 25 秒心跳长，否则会把正常空闲当成断线 */
    WinHttpSetTimeouts(session, 15000, 15000, 15000, 60000);
    connection = WinHttpConnect(session, url->host, url->port, 0);
    if (connection == NULL) goto network_error;
    request = WinHttpOpenRequest(connection, L"GET", url->object, NULL, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, url->secure ? WINHTTP_FLAG_SECURE : 0);
    if (request == NULL) goto network_error;
    if (!WinHttpAddRequestHeaders(request, L"Accept: text/event-stream\r\nCache-Control: no-cache\r\n",
            (DWORD)-1, WINHTTP_ADDREQ_FLAG_ADD | WINHTTP_ADDREQ_FLAG_REPLACE)
        || !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request, NULL)) goto network_error;
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) goto network_error;
    if (status != 200 || !content_type_is_sse(request)) {
        log_line(L"stream: expected 200 text/event-stream, got %lu", (unsigned long)status);
        PostMessageW(g_hwnd, WM_APP_CONN, 0, (LPARAM)(status != 0 ? status : 1));
        goto cleanup;
    }

    parser = (SseParser *)calloc(1, sizeof(*parser));
    if (parser == NULL) goto cleanup;
    parser->first_line = 1;
    parser->retry_ms = *retry_ms;
    PostMessageW(g_hwnd, WM_APP_CONN, 1, 0);
    announced = 1;
    log_line(L"stream connected");

    while (InterlockedCompareExchange(&g_stop, 0, 0) == 0) {
        DWORD available = 0;
        /* 同步模式下 WinHttpReadData 会等到填满整个缓冲区才返回；SSE 每帧只有几百字节，
         * 必须先用 QueryDataAvailable 拿到当前可读字节数，再只读这么多。 */
        if (!WinHttpQueryDataAvailable(request, &available)) goto network_error;
        if (available == 0) break;                     /* 服务器关闭了连接 */
        if (available > sizeof(buffer)) available = sizeof(buffer);
        received = 0;
        if (!WinHttpReadData(request, buffer, available, &received)) goto network_error;
        if (received == 0) break;
        sse_feed(parser, buffer, received);
    }
    goto cleanup;

network_error:
    if (InterlockedCompareExchange(&g_stop, 0, 0) == 0) {
        DWORD error = GetLastError();
        log_windows_error(L"stream", error);
        PostMessageW(g_hwnd, WM_APP_CONN, 0, (LPARAM)error);
        announced = 0;
    }
cleanup:
    if (parser != NULL) { *retry_ms = parser->retry_ms; free(parser); }
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    if (session) WinHttpCloseHandle(session);
    if (announced) { PostMessageW(g_hwnd, WM_APP_CONN, 0, 0); log_line(L"stream disconnected"); }
}

static void interruptible_sleep(DWORD ms)
{
    DWORD slept = 0;
    while (slept < ms && InterlockedCompareExchange(&g_stop, 0, 0) == 0) {
        DWORD step = ms - slept;
        if (step > 100) step = 100;
        Sleep(step);
        slept += step;
    }
}

static DWORD WINAPI network_thread(LPVOID parameter)
{
    WCHAR stream_url[CC_MAX_URL];
    UrlParts url;
    DWORD retry_ms = 2000;
    int config_loaded = 0;

    (void)parameter;
    if (FAILED(StringCchPrintfW(stream_url, CC_MAX_URL, L"%ls/api/classes/%ls/public/stream?role=display",
            g_config.server, g_config.class_id))
        || !parse_url(stream_url, &url)) {
        log_line(L"invalid server URL: %ls", g_config.server);
        return 1;
    }
    while (InterlockedCompareExchange(&g_stop, 0, 0) == 0) {
        /* 班级信息决定顶栏与绑定校验：失败不阻塞 SSE，下次重连再试 */
        if (!config_loaded) config_loaded = fetch_public_config();
        watch_once(&url, &retry_ms);
        if (InterlockedCompareExchange(&g_stop, 0, 0) == 0) interruptible_sleep(retry_ms);
    }
    return 0;
}

/* ================= 「收到」确认：POST /api/classes/<class_id>/public/ack ================= */

/* 把 UTF-16 文本按 JSON 规则转义并以 UTF-8 追加到 out（姓名已经过校验，不含控制字符） */
static int json_append_string(char *out, SIZE_T capacity, SIZE_T *used, const WCHAR *text)
{
    WCHAR escaped[(CC_MAX_NAME_UNITS + 1) * 2];
    SIZE_T n = 0, i;
    int bytes;

    for (i = 0; text[i] != L'\0'; ++i) {
        WCHAR c = text[i];
        if (c < 0x20) continue;
        if (n + 3 >= sizeof(escaped) / sizeof(escaped[0])) return 0;
        if (c == L'"' || c == L'\\') escaped[n++] = L'\\';
        escaped[n++] = c;
    }
    escaped[n] = L'\0';
    if (*used + 1 >= capacity) return 0;
    out[(*used)++] = '"';
    bytes = WideCharToMultiByte(CP_UTF8, 0, escaped, -1, out + *used, (int)(capacity - *used), NULL, NULL);
    if (bytes <= 0) return 0;
    *used += (SIZE_T)bytes - 1;
    if (*used + 1 >= capacity) return 0;
    out[(*used)++] = '"';
    out[*used] = '\0';
    return 1;
}

static DWORD WINAPI ack_thread(LPVOID parameter)
{
    AckJob *job = (AckJob *)parameter;
    WCHAR url[CC_MAX_URL];
    UrlParts parts;
    HINTERNET session = NULL, connection = NULL, request = NULL;
    char body[4096];
    SIZE_T used = 0;
    DWORD status = 0, status_size = sizeof(status);
    int ok = 0, i;

    job->error = 0;
    if (FAILED(StringCchPrintfA(body, sizeof(body), "{\"eventId\":%I64u", job->event_id))) goto done;
    used = strlen(body);
    if (job->name_count > 0) {
        if (used + 9 >= sizeof(body)) goto done;
        memcpy(body + used, ",\"names\":[", 9); used += 9; body[used] = '\0';
        for (i = 0; i < job->name_count; ++i) {
            if (i > 0) { if (used + 1 >= sizeof(body)) goto done; body[used++] = ','; }
            if (!json_append_string(body, sizeof(body), &used, job->names[i])) goto done;
        }
        if (used + 1 >= sizeof(body)) goto done;
        body[used++] = ']';
    }
    if (used + 1 >= sizeof(body)) goto done;
    body[used++] = '}';
    body[used] = '\0';

    if (FAILED(StringCchPrintfW(url, CC_MAX_URL, L"%ls/api/classes/%ls/public/ack", g_config.server, g_config.class_id))
        || !parse_url(url, &parts)) goto done;
    session = open_session(parts.secure);
    if (session == NULL) goto network_error;
    WinHttpSetTimeouts(session, 10000, 10000, 10000, 15000);
    connection = WinHttpConnect(session, parts.host, parts.port, 0);
    if (connection == NULL) goto network_error;
    request = WinHttpOpenRequest(connection, L"POST", parts.object, NULL, WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES, parts.secure ? WINHTTP_FLAG_SECURE : 0);
    if (request == NULL) goto network_error;
    if (!WinHttpSendRequest(request, L"Content-Type: application/json; charset=utf-8\r\n", (DWORD)-1,
            body, (DWORD)used, (DWORD)used, 0)
        || !WinHttpReceiveResponse(request, NULL)) goto network_error;
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX)) goto network_error;
    if (status != 200) {
        job->error = status;
        log_line(L"ack rejected: HTTP %lu", (unsigned long)status);
        goto done;
    }
    ok = 1;
    log_line(L"ack sent id=%I64u names=%d", job->event_id, job->name_count);
    goto done;

network_error:
    job->error = GetLastError();
    log_windows_error(L"ack", job->error);
done:
    if (request) WinHttpCloseHandle(request);
    if (connection) WinHttpCloseHandle(connection);
    if (session) WinHttpCloseHandle(session);
    if (!PostMessageW(g_hwnd, WM_APP_ACK, (WPARAM)ok, (LPARAM)job)) free(job);
    return 0;
}

static void set_ack_note(const WCHAR *text)
{
    StringCchCopyW(g_ack_note, 96, text);
    g_ack_note_until = unix_ms_now() + 4000ULL;
}

static int all_acked(const DisplayEvent *event)
{
    int i;
    if (!event->is_call || event->name_count == 0) return 0;
    for (i = 0; i < event->name_count; ++i) if (!event->acked[i]) return 0;
    return 1;
}

/* name_index < 0 表示确认当前显示的全部姓名 */
static void send_ack(int name_index)
{
    AckJob *job;
    HANDLE thread;
    int i;

    if (!g_current.is_call || g_ack_busy || all_acked(&g_current)) return;
    if (name_index >= 0 && (name_index >= g_current.name_count || g_current.acked[name_index])) return;

    if (g_preview) {
        for (i = 0; i < g_current.name_count; ++i) {
            if (name_index < 0 || i == name_index) g_current.acked[i] = 1;
        }
        InvalidateRect(g_hwnd, NULL, FALSE);
        return;
    }

    job = (AckJob *)calloc(1, sizeof(*job));
    if (job == NULL) return;
    job->event_id = g_current.id;
    if (name_index >= 0) {
        job->name_count = 1;
        StringCchCopyW(job->names[0], CC_MAX_NAME_UNITS + 1, g_current.names[name_index]);
    }
    g_ack_busy = 1;
    InvalidateRect(g_hwnd, NULL, FALSE);
    thread = CreateThread(NULL, 0, ack_thread, job, 0, NULL);
    if (thread == NULL) { g_ack_busy = 0; free(job); return; }
    CloseHandle(thread);
}

/* ack 线程回来：成功就先把本地状态标成已收到（SSE 广播随后会再确认一次） */
static void finish_ack(int ok, AckJob *job)
{
    int i, j;

    g_ack_busy = 0;
    if (job != NULL) {
        if (ok && g_current.is_call && g_current.id == job->event_id) {
            for (i = 0; i < g_current.name_count; ++i) {
                if (job->name_count == 0) { g_current.acked[i] = 1; continue; }
                for (j = 0; j < job->name_count; ++j) {
                    if (wcscmp(job->names[j], g_current.names[i]) == 0) g_current.acked[i] = 1;
                }
            }
            if (all_acked(&g_current)) {
                WCHAR note[64];
                StringCchPrintfW(note, 64, L"已通知%ls", g_current.caller[0] ? g_current.caller : CC_DEFAULT_CALLER);
                set_ack_note(note);
            } else {
                set_ack_note(L"已记录");
            }
        } else if (!ok) {
            if (job->error == 409) set_ack_note(L"这条通知已结束");
            else if (job->error == 400) set_ack_note(L"服务器拒绝了这次确认");
            else set_ack_note(L"发送失败，请再点一次");
        }
        free(job);
    }
    InvalidateRect(g_hwnd, NULL, FALSE);
}

/* ================= 提示音 ================= */

static DWORD WINAPI chime_thread(LPVOID parameter)
{
    (void)parameter;
    Beep(880, 140);
    Beep(1175, 320);
    return 0;
}

static void chime(void)
{
    HANDLE thread;
    if (!g_config.sound) return;
    thread = CreateThread(NULL, 0, chime_thread, NULL, 0, NULL);
    if (thread != NULL) CloseHandle(thread);
}

/* ================= 窗口：全屏、置顶、前置 ================= */

static void set_topmost(int enable)
{
    if (g_is_topmost == enable) return;
    SetWindowPos(g_hwnd, enable ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    g_is_topmost = enable;
}

static const WCHAR *error_hint(DWORD error)
{
    switch (error) {
    case 0: return L"服务器主动断开，正在重连";
    case 1: return L"服务器返回的不是 SSE 流，检查 server= 地址是否正确";
    case 404: return L"HTTP 404：class_id 不是服务器上的班级，或 server= 地址不对 / Nginx 未反代 /api/classes/";
    case 502: case 503: case 504: return L"Nginx 能访问但 Node 服务没起来（systemctl status class-caller）";
    case 12002: return L"12002 连接超时：网络不通或被防火墙拦截";
    case 12007: return L"12007 域名解析失败：检查 DNS 或 server= 拼写";
    case 12029: return L"12029 无法连接服务器：网络/端口/防火墙";
    case 12030: return L"12030 连接被中断，正在重连";
    case 12037: return L"12037 证书日期无效：检查电脑系统时间";
    case 12038: return L"12038 证书域名不匹配：检查 server= 域名";
    case 12044: case 12045: return L"证书不受信任：Win7 需更新根证书";
    case 12152: return L"12152 响应格式无效：Nginx 或代理干扰";
    case 12175: return L"12175 TLS/证书错误：Win7 需安装 TLS 1.2 补丁与根证书更新";
    default: return L"查看 display.log 获取详细错误";
    }
}

static void apply_window_mode(void)
{
    LONG style;

    if (g_config.fullscreen) {
        style = WS_POPUP | WS_MINIMIZEBOX | WS_SYSMENU;
        SetWindowLongPtrW(g_hwnd, GWL_STYLE, style | (IsWindowVisible(g_hwnd) ? WS_VISIBLE : 0));
        if (IsZoomed(g_hwnd)) ShowWindow(g_hwnd, SW_RESTORE);
    } else {
        style = WS_OVERLAPPEDWINDOW;
        SetWindowLongPtrW(g_hwnd, GWL_STYLE, style | (IsWindowVisible(g_hwnd) ? WS_VISIBLE : 0));
        SetWindowPos(g_hwnd, NULL, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        if (IsWindowVisible(g_hwnd) && !IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_MAXIMIZE);
    }
}

static void fit_to_monitor(void)
{
    HMONITOR monitor;
    MONITORINFO info;

    if (!g_config.fullscreen) {
        if (!IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_MAXIMIZE);
        return;
    }
    monitor = MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTOPRIMARY);
    memset(&info, 0, sizeof(info));
    info.cbSize = sizeof(info);
    if (!GetMonitorInfoW(monitor, &info)) SystemParametersInfoW(SPI_GETWORKAREA, 0, &info.rcMonitor, 0);
    SetWindowPos(g_hwnd, NULL, info.rcMonitor.left, info.rcMonitor.top,
        info.rcMonitor.right - info.rcMonitor.left, info.rcMonitor.bottom - info.rcMonitor.top,
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

/*
 * Windows 不允许后台进程随意抢前台（Win7/Win10 都有 SetForegroundWindow 限制）。
 * 这里叠加几种公认可行的手段：恢复最小化 → 临时挂接前台线程输入 → 模拟一次 Alt 键
 * → SetForegroundWindow/BringWindowToTop → 置顶 → 若仍失败则闪烁任务栏提示。
 */
static void bring_to_front(void)
{
    HWND foreground;
    DWORD foreground_thread = 0, my_thread;
    int attached = 0;

    if (IsIconic(g_hwnd)) ShowWindow(g_hwnd, SW_RESTORE);
    ShowWindow(g_hwnd, SW_SHOW);
    fit_to_monitor();

    SetWindowPos(g_hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    g_is_topmost = 1;
    SetForegroundWindow(g_hwnd);

    if (GetForegroundWindow() != g_hwnd) {
        my_thread = GetCurrentThreadId();
        foreground = GetForegroundWindow();
        if (foreground != NULL) {
            foreground_thread = GetWindowThreadProcessId(foreground, NULL);
            if (foreground_thread != my_thread) attached = AttachThreadInput(foreground_thread, my_thread, TRUE);
        }
        /* 一次空的 Alt 按键让本进程成为“最近有输入”的进程，解除前台限制 */
        keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY, 0);
        keybd_event(VK_MENU, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(g_hwnd);
        BringWindowToTop(g_hwnd);
        SetActiveWindow(g_hwnd);
        SetFocus(g_hwnd);
        if (attached) AttachThreadInput(foreground_thread, my_thread, FALSE);
    }

    if (!g_config.always_topmost && !g_config.topmost_when_active) set_topmost(0);
    if (GetForegroundWindow() != g_hwnd) {
        FLASHWINFO flash;
        memset(&flash, 0, sizeof(flash));
        flash.cbSize = sizeof(flash);
        flash.hwnd = g_hwnd;
        flash.dwFlags = FLASHW_ALL | FLASHW_TIMERNOFG;
        flash.uCount = 0;
        FlashWindowEx(&flash);
        log_line(L"foreground denied by system; flashing taskbar instead");
    }
}

/* ================= 事件应用 ================= */

static void apply_event(const DisplayEvent *event)
{
    int is_new;
    ULONGLONG now;

    is_new = event->id > g_last_id;
    if (event->id > g_last_id) g_last_id = event->id;
    /* 绑定错误期间只记 id，不显示任何通知 */
    if (g_bind_error && (event->is_call || event->is_announcement)) {
        log_line(L"suppressed %ls id=%I64u while class binding is invalid",
            event->is_call ? L"call" : L"announcement", event->id);
        return;
    }
    g_current = *event;
    KillTimer(g_hwnd, TIMER_EXPIRE);

    if (!event->is_call && !event->is_announcement) {
        g_expiry_local = 0;
        g_total_ms = 0;
        KillTimer(g_hwnd, TIMER_PROGRESS);
        if (!g_config.always_topmost) set_topmost(0);
        InvalidateRect(g_hwnd, NULL, FALSE);
        return;
    }

    now = unix_ms_now();
    if (event->expires_at != 0 && event->server_time != 0) {
        LONGLONG skew = (LONGLONG)now - (LONGLONG)event->server_time;
        g_expiry_local = (ULONGLONG)((LONGLONG)event->expires_at + skew);
        g_total_ms = event->expires_at > event->created_at ? event->expires_at - event->created_at : 1;
        SetTimer(g_hwnd, TIMER_PROGRESS, 100, NULL);
        /* 服务端到期会推 clear；这里再兜底 1.5 秒，网络抖动时也不会一直挂着旧名字 */
        SetTimer(g_hwnd, TIMER_EXPIRE,
            (UINT)((g_expiry_local > now ? g_expiry_local - now : 0) + 1500), NULL);
    } else {
        g_expiry_local = 0;
        g_total_ms = 0;
        KillTimer(g_hwnd, TIMER_PROGRESS);
    }

    if (is_new) {
        if (event->is_call) log_line(L"call id=%I64u names=%d", event->id, event->name_count);
        else log_line(L"announcement id=%I64u priority=%d", event->id, event->priority);
        bring_to_front();
        chime();
    } else if (g_config.topmost_when_active || g_config.always_topmost) {
        set_topmost(1);
    }
    InvalidateRect(g_hwnd, NULL, FALSE);
}

/* ================= 绘制 ================= */

static HFONT make_font(int pixel_height, int weight)
{
    return CreateFontW(-pixel_height, 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, CC_FONT);
}

static void fill_rect(HDC dc, int left, int top, int right, int bottom, COLORREF color)
{
    RECT r;
    HBRUSH brush;
    r.left = left; r.top = top; r.right = right; r.bottom = bottom;
    brush = CreateSolidBrush(color);
    FillRect(dc, &r, brush);
    DeleteObject(brush);
}

static void fill_gradient_vertical(HDC dc, const RECT *r, COLORREF top, COLORREF bottom)
{
    TRIVERTEX vertices[2];
    GRADIENT_RECT rect;

    vertices[0].x = r->left; vertices[0].y = r->top;
    vertices[0].Red = (COLOR16)(GetRValue(top) << 8);
    vertices[0].Green = (COLOR16)(GetGValue(top) << 8);
    vertices[0].Blue = (COLOR16)(GetBValue(top) << 8);
    vertices[0].Alpha = 0;
    vertices[1].x = r->right; vertices[1].y = r->bottom;
    vertices[1].Red = (COLOR16)(GetRValue(bottom) << 8);
    vertices[1].Green = (COLOR16)(GetGValue(bottom) << 8);
    vertices[1].Blue = (COLOR16)(GetBValue(bottom) << 8);
    vertices[1].Alpha = 0;
    rect.UpperLeft = 0;
    rect.LowerRight = 1;
    GradientFill(dc, vertices, 2, &rect, 1, GRADIENT_FILL_RECT_V);
}

static void fill_circle(HDC dc, int cx, int cy, int radius, COLORREF color)
{
    HBRUSH brush = CreateSolidBrush(color);
    HPEN pen = CreatePen(PS_NULL, 0, 0);
    HGDIOBJ old_brush = SelectObject(dc, brush);
    HGDIOBJ old_pen = SelectObject(dc, pen);
    Ellipse(dc, cx - radius, cy - radius, cx + radius + 1, cy + radius + 1);
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(brush);
    DeleteObject(pen);
}

static SIZE measure(HDC dc, HFONT font, const WCHAR *text)
{
    SIZE size;
    HGDIOBJ old = SelectObject(dc, font);
    size.cx = 0; size.cy = 0;
    GetTextExtentPoint32W(dc, text, (int)wcslen(text), &size);
    SelectObject(dc, old);
    return size;
}

static void draw_text_at(HDC dc, HFONT font, COLORREF color, int x, int y, const WCHAR *text, UINT align)
{
    HGDIOBJ old = SelectObject(dc, font);
    SetTextColor(dc, color);
    SetTextAlign(dc, align | TA_TOP);
    TextOutW(dc, x, y, text, (int)wcslen(text));
    SelectObject(dc, old);
}

/* 两位补零 */
static void two_digits(WCHAR *out, int value)
{
    out[0] = (WCHAR)(L'0' + (value / 10) % 10);
    out[1] = (WCHAR)(L'0' + value % 10);
    out[2] = L'\0';
}

static void paint_rail(HDC dc, int w, int h, int *rail_bottom)
{
    SYSTEMTIME st;
    WCHAR hh[3], mm[3], clock_text[8];
    HFONT title_font, meta_font;
    int pad_x = w * 3 / 100, pad_top = h * 22 / 1000, pad_bottom = h * 16 / 1000;
    int title_px = w * 19 / 1000, meta_px = w * 135 / 10000;
    int mark_w, mark_h, row_h, y_center, x;
    SIZE size;

    if (title_px < 18) title_px = 18;
    if (meta_px < 13) meta_px = 13;
    title_font = make_font(title_px, FW_BOLD);
    meta_font = make_font(meta_px, FW_SEMIBOLD);
    row_h = title_px * 14 / 10;
    y_center = pad_top + row_h / 2;

    /* 左：金色标记 + 班级名 + 班级编号（编号永远和名称一起出现，颜色只是辅助） */
    mark_w = w / 200; if (mark_w < 6) mark_w = 6;
    mark_h = w * 22 / 1000; if (mark_h < 26) mark_h = 26;
    fill_rect(dc, pad_x, y_center - mark_h / 2, pad_x + mark_w, y_center + mark_h / 2, C_GOLD);
    x = pad_x + mark_w + w * 11 / 1000;
    draw_text_at(dc, title_font, g_bind_error ? C_ALERT_TXT : C_ON_STRONG, x, y_center - title_px * 6 / 10, g_class_name, TA_LEFT);
    if (g_class_code[0] != L'\0') {
        int chip_px = meta_px, chip_pad = chip_px * 6 / 10, chip_h = chip_px * 15 / 10;
        HFONT chip_font = make_font(chip_px, FW_BOLD);
        SIZE chip = measure(dc, chip_font, g_class_code);
        size = measure(dc, title_font, g_class_name);
        x += size.cx + w * 9 / 1000;
        fill_rect(dc, x, y_center - chip_h / 2, x + chip.cx + chip_pad * 2, y_center + chip_h / 2, C_GOLD);
        draw_text_at(dc, chip_font, C_INK_900, x + chip_pad, y_center - chip_px * 6 / 10, g_class_code, TA_LEFT);
        DeleteObject(chip_font);
    }

    /* 右：连接状态 + 时钟 */
    GetLocalTime(&st);
    two_digits(hh, st.wHour); two_digits(mm, st.wMinute);
    StringCchPrintfW(clock_text, 8, L"%ls:%ls", hh, mm);
    x = w - pad_x;
    size = measure(dc, meta_font, g_conn_text);
    draw_text_at(dc, meta_font, g_connected ? C_ON_MUTED : C_ALERT_TXT, x, y_center - meta_px * 6 / 10, g_conn_text, TA_RIGHT);
    x -= size.cx + w * 5 / 1000 + 6;
    fill_circle(dc, x, y_center, (w * 3 / 1000) > 4 ? w * 3 / 1000 : 4, g_connected ? C_LIVE : C_ALERT);
    x -= w * 14 / 1000 + 6;
    draw_text_at(dc, meta_font, C_ON_BODY, x, y_center - meta_px * 6 / 10, clock_text, TA_RIGHT);

    *rail_bottom = pad_top + row_h + pad_bottom;
    fill_rect(dc, 0, *rail_bottom, w, *rail_bottom + 1, C_INK_600);
    DeleteObject(title_font);
    DeleteObject(meta_font);
}

static void paint_idle(HDC dc, int w, int top, int bottom)
{
    static const WCHAR *WEEKDAYS[] = { L"星期日", L"星期一", L"星期二", L"星期三", L"星期四", L"星期五", L"星期六" };
    SYSTEMTIME st;
    WCHAR hh[3], mm[3], date_text[64];
    HFONT clock_font, colon_font, date_font;
    int clock_px, date_px, cy, total_h;
    SIZE size_h, size_colon, size_m;
    int x, y;
    HGDIOBJ old;

    GetLocalTime(&st);
    two_digits(hh, st.wHour); two_digits(mm, st.wMinute);
    StringCchPrintfW(date_text, 64, L"%u 月 %u 日 · %ls", st.wMonth, st.wDay, WEEKDAYS[st.wDayOfWeek]);

    clock_px = w * 17 / 100;
    if (clock_px > (bottom - top) * 60 / 100) clock_px = (bottom - top) * 60 / 100;
    date_px = w * 21 / 1000; if (date_px < 14) date_px = 14;
    clock_font = make_font(clock_px, FW_LIGHT);
    colon_font = make_font(clock_px, FW_LIGHT);
    date_font = make_font(date_px, FW_MEDIUM);

    size_h = measure(dc, clock_font, hh);
    size_colon = measure(dc, colon_font, L":");
    size_m = measure(dc, clock_font, mm);
    total_h = size_h.cy + (int)(date_px * 1.2) + date_px * 2;
    cy = (top + bottom) / 2;
    y = cy - total_h / 2;
    x = (w - (size_h.cx + size_colon.cx + size_m.cx)) / 2;

    draw_text_at(dc, clock_font, C_ON_STRONG, x, y, hh, TA_LEFT);
    x += size_h.cx;
    draw_text_at(dc, colon_font, C_ON_MUTED, x, y, L":", TA_LEFT);
    x += size_colon.cx;
    draw_text_at(dc, clock_font, C_ON_STRONG, x, y, mm, TA_LEFT);

    /* 日期行加宽字距，模拟 letter-spacing:.28em */
    old = SelectObject(dc, date_font);
    SetTextCharacterExtra(dc, date_px * 28 / 100);
    SetTextColor(dc, C_ON_MUTED);
    SetTextAlign(dc, TA_CENTER | TA_TOP);
    TextOutW(dc, w / 2 + date_px * 14 / 100, y + size_h.cy + date_px * 12 / 10, date_text, (int)wcslen(date_text));

    /* 待机也标明班级，巡检时一眼看出这台设备绑的是哪个班 */
    if (g_class_name[0] != L'\0') {
        WCHAR klass_text[CC_CLASS_NAME_UNITS + CC_CLASS_CODE_UNITS + 8];
        if (g_class_code[0] != L'\0') {
            StringCchPrintfW(klass_text, sizeof(klass_text) / sizeof(klass_text[0]), L"%ls · %ls", g_class_name, g_class_code);
        } else {
            StringCchCopyW(klass_text, sizeof(klass_text) / sizeof(klass_text[0]), g_class_name);
        }
        SetTextColor(dc, C_GOLD);
        TextOutW(dc, w / 2 + date_px * 14 / 100, y + size_h.cy + date_px * 12 / 10 + date_px * 2,
            klass_text, (int)wcslen(klass_text));
    }
    SetTextCharacterExtra(dc, 0);
    SelectObject(dc, old);

    DeleteObject(clock_font);
    DeleteObject(colon_font);
    DeleteObject(date_font);
}

/* 姓名区：按可用像素同时决定列数与字号（同 display.js 的 layout） */
static void paint_names(HDC dc, int w, int top, int bottom)
{
    int count = g_current.name_count;
    int max_len = 1, i, columns, best_columns = 1, rows;
    double best_size = 0, size;
    int area_w = w * 92 / 100, area_h = bottom - top;
    int gap_x = (int)(area_w * 0.045), gap_y = (int)(area_h * 0.06);
    int font_px, cell_w, cell_h, widest = 0, grid_w, grid_h, x0, y0, rule_h, r, c, index;
    HFONT font;
    SIZE size_px;

    if (count == 0 || area_w <= 0 || area_h <= 0) return;
    for (i = 0; i < count; ++i) {
        int len = (int)wcslen(g_current.names[i]);
        if (len > max_len) max_len = len;
    }
    for (columns = 1; columns <= (count < 6 ? count : 6); ++columns) {
        rows = (count + columns - 1) / columns;
        cell_w = (area_w - gap_x * (columns - 1)) / columns;
        cell_h = (area_h - gap_y * (rows - 1)) / rows;
        size = cell_w / (max_len * 1.08);
        if (cell_h / 1.52 < size) size = cell_h / 1.52;
        if (size > best_size) { best_size = size; best_columns = columns; }
    }
    if (best_size > area_h * 0.58) best_size = area_h * 0.58;
    font_px = (int)best_size;
    if (font_px < 16) font_px = 16;
    columns = best_columns;
    rows = (count + columns - 1) / columns;
    cell_w = (area_w - gap_x * (columns - 1)) / columns;

    /* 用真实字体实测最宽姓名，超出单元格就缩字号 */
    font = make_font(font_px, FW_HEAVY);
    for (i = 0; i < count; ++i) {
        size_px = measure(dc, font, g_current.names[i]);
        if (size_px.cx > widest) widest = size_px.cx;
    }
    if (widest > cell_w) {
        DeleteObject(font);
        font_px = (int)(font_px * (double)cell_w / widest);
        if (font_px < 16) font_px = 16;
        font = make_font(font_px, FW_HEAVY);
        widest = 0;
        for (i = 0; i < count; ++i) {
            size_px = measure(dc, font, g_current.names[i]);
            if (size_px.cx > widest) widest = size_px.cx;
        }
    }
    size_px = measure(dc, font, g_current.names[0]);
    rule_h = font_px * 45 / 1000; if (rule_h < 2) rule_h = 2;
    cell_h = size_px.cy + font_px * 16 / 100 + rule_h;
    grid_w = columns * widest + gap_x * (columns - 1);
    grid_h = rows * cell_h + gap_y * (rows - 1);
    x0 = (w - grid_w) / 2;
    y0 = top + (area_h - grid_h) / 2;

    index = 0;
    g_name_rect_count = count;
    for (r = 0; r < rows; ++r) {
        int in_row = count - r * columns;
        int row_x;
        if (in_row > columns) in_row = columns;
        /* 最后一行不满时居中 */
        row_x = x0 + ((columns - in_row) * (widest + gap_x)) / 2;
        for (c = 0; c < in_row; ++c, ++index) {
            const WCHAR *name = g_current.names[index];
            int cx = row_x + c * (widest + gap_x) + widest / 2;
            int y = y0 + r * (cell_h + gap_y);
            int acked = g_current.acked[index];
            SIZE s = measure(dc, font, name);
            draw_text_at(dc, font, acked ? C_ON_BODY : C_WHITE, cx, y, name, TA_CENTER);
            fill_rect(dc, cx - s.cx / 2, y + size_px.cy + font_px * 16 / 100,
                cx + s.cx / 2, y + size_px.cy + font_px * 16 / 100 + rule_h, acked ? C_LIVE : C_GOLD);
            if (acked) {
                /* 名字右上角落一枚绿色对勾 */
                HFONT tick_font = make_font(font_px * 42 / 100, FW_HEAVY);
                draw_text_at(dc, tick_font, C_LIVE, cx + s.cx / 2 + font_px * 6 / 100, y - font_px * 4 / 100, L"\u2713", TA_LEFT);
                DeleteObject(tick_font);
            }
            g_name_rects[index].left = cx - s.cx / 2 - gap_x / 4;
            g_name_rects[index].right = cx + s.cx / 2 + gap_x / 4;
            g_name_rects[index].top = y;
            g_name_rects[index].bottom = y + cell_h;
        }
    }
    DeleteObject(font);
}

/* 「收到」按钮：金色药丸；发送中变暗；全部确认后变成绿色描边的「已收到」并禁用 */
static void paint_ack_button(HDC dc, int w, int top, int bottom)
{
    HFONT font, note_font;
    const WCHAR *text;
    int px = w * 23 / 1000, pad_x, btn_w, btn_h, x, y, done, note_px;
    SIZE size;
    HBRUSH brush;
    HPEN pen;
    HGDIOBJ old_brush, old_pen;
    COLORREF fill, ink, border;

    if (px < 22) px = 22;
    done = all_acked(&g_current);
    text = done ? L"已收到" : (g_ack_busy ? L"发送中…" : L"收到");
    font = make_font(px, FW_HEAVY);
    size = measure(dc, font, text);
    pad_x = px * 22 / 10;
    btn_h = size.cy + px * 11 / 10;
    btn_w = size.cx + pad_x * 2 + px * 12 / 10;     /* 左侧留出对勾图标的位置 */
    if (btn_w < w * 14 / 100) btn_w = w * 14 / 100;
    x = (w - btn_w) / 2;
    y = top + ((bottom - top) - btn_h) / 2;
    if (y < top) y = top;

    if (done) { fill = C_LIVE_DIM; ink = C_LIVE; border = C_LIVE; }
    else if (g_ack_busy) { fill = C_GOLD_DIM; ink = C_INK_900; border = C_GOLD_DIM; }
    else { fill = C_GOLD; ink = C_INK_900; border = C_GOLD; }

    if (!done && !g_ack_busy) {
        /* 外圈柔光，让按钮在深色底上足够醒目 */
        HBRUSH glow = CreateSolidBrush(RGB(0x5A, 0x46, 0x16));
        HPEN nopen = CreatePen(PS_NULL, 0, 0);
        old_brush = SelectObject(dc, glow); old_pen = SelectObject(dc, nopen);
        RoundRect(dc, x - 8, y - 8, x + btn_w + 8, y + btn_h + 8, btn_h + 16, btn_h + 16);
        SelectObject(dc, old_brush); SelectObject(dc, old_pen);
        DeleteObject(glow); DeleteObject(nopen);
    }
    brush = CreateSolidBrush(fill);
    pen = CreatePen(PS_SOLID, 2, border);
    old_brush = SelectObject(dc, brush);
    old_pen = SelectObject(dc, pen);
    RoundRect(dc, x, y, x + btn_w, y + btn_h, btn_h, btn_h);
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(brush);
    DeleteObject(pen);

    /* 对勾 + 文字，整体居中 */
    {
        HFONT tick_font = make_font(px * 9 / 10, FW_HEAVY);
        SIZE tick = measure(dc, tick_font, L"\u2713");
        int total = tick.cx + px * 4 / 10 + size.cx;
        int tx = x + (btn_w - total) / 2;
        draw_text_at(dc, tick_font, ink, tx, y + (btn_h - tick.cy) / 2, L"\u2713", TA_LEFT);
        draw_text_at(dc, font, ink, tx + tick.cx + px * 4 / 10, y + (btn_h - size.cy) / 2, text, TA_LEFT);
        DeleteObject(tick_font);
    }
    DeleteObject(font);

    g_ack_rect.left = x; g_ack_rect.top = y; g_ack_rect.right = x + btn_w; g_ack_rect.bottom = y + btn_h;

    /* 按钮下方的短暂反馈文字（4 秒后自动消失） */
    if (g_ack_note[0] != L'\0' && unix_ms_now() < g_ack_note_until) {
        note_px = w * 11 / 1000; if (note_px < 13) note_px = 13;
        note_font = make_font(note_px, FW_MEDIUM);
        draw_text_at(dc, note_font, C_ON_MUTED, x + btn_w + px, y + (btn_h - note_px) / 2, g_ack_note, TA_LEFT);
        DeleteObject(note_font);
    }
}

static void paint_call(HDC dc, int w, int top, int bottom)
{
    HFONT label_font;
    WCHAR label[32];
    int label_px = w * 17 / 1000, line_w = w * 7 / 100, pad_top, pad_bottom, y, label_w;
    HGDIOBJ old;
    SIZE size;
    int names_top, names_bottom, x;

    if (label_px < 14) label_px = 14;
    StringCchPrintfW(label, 32, L"%ls正在找", g_current.caller[0] ? g_current.caller : CC_DEFAULT_CALLER);
    label_font = make_font(label_px, FW_SEMIBOLD);
    pad_top = (bottom - top) * 35 / 1000;
    pad_bottom = (bottom - top) * 30 / 1000;
    y = top + pad_top;

    old = SelectObject(dc, label_font);
    SetTextCharacterExtra(dc, label_px * 42 / 100);
    GetTextExtentPoint32W(dc, label, (int)wcslen(label), &size);
    label_w = size.cx;
    SetTextColor(dc, C_GOLD);
    SetTextAlign(dc, TA_CENTER | TA_TOP);
    TextOutW(dc, w / 2 + label_px * 21 / 100, y, label, (int)wcslen(label));
    SetTextCharacterExtra(dc, 0);
    SelectObject(dc, old);

    /* 两侧的渐隐金线 */
    x = w / 2 - label_w / 2 - w * 12 / 1000;
    {
        RECT left_r = { x - line_w, y + size.cy / 2 - 1, x, y + size.cy / 2 + 1 };
        RECT right_r = { w - x, y + size.cy / 2 - 1, w - x + line_w, y + size.cy / 2 + 1 };
        TRIVERTEX v[2]; GRADIENT_RECT gr = { 0, 1 };
        v[0].x = left_r.left; v[0].y = left_r.top; v[0].Red = (COLOR16)(GetRValue(C_INK_900) << 8);
        v[0].Green = (COLOR16)(GetGValue(C_INK_900) << 8); v[0].Blue = (COLOR16)(GetBValue(C_INK_900) << 8); v[0].Alpha = 0;
        v[1].x = left_r.right; v[1].y = left_r.bottom; v[1].Red = (COLOR16)(GetRValue(C_GOLD_DIM) << 8);
        v[1].Green = (COLOR16)(GetGValue(C_GOLD_DIM) << 8); v[1].Blue = (COLOR16)(GetBValue(C_GOLD_DIM) << 8); v[1].Alpha = 0;
        GradientFill(dc, v, 2, &gr, 1, GRADIENT_FILL_RECT_H);
        v[0].x = right_r.left; v[0].y = right_r.top; v[0].Red = v[1].Red; v[0].Green = v[1].Green; v[0].Blue = v[1].Blue;
        v[1].x = right_r.right; v[1].y = right_r.bottom; v[1].Red = (COLOR16)(GetRValue(C_INK_900) << 8);
        v[1].Green = (COLOR16)(GetGValue(C_INK_900) << 8); v[1].Blue = (COLOR16)(GetBValue(C_INK_900) << 8);
        GradientFill(dc, v, 2, &gr, 1, GRADIENT_FILL_RECT_H);
    }
    DeleteObject(label_font);

    names_top = y + size.cy + pad_bottom;
    {
        int ack_h = (bottom - top) * 15 / 100;
        if (ack_h < 64) ack_h = 64;
        names_bottom = bottom - ack_h - (bottom - top) * 2 / 100;
        paint_names(dc, w, names_top, names_bottom);
        paint_ack_button(dc, w, names_bottom, bottom - (bottom - top) * 2 / 100);
    }
}

static int paint_foot(HDC dc, int w, int h)
{
    int foot_top = h;
    int bar_h = 4;
    HFONT msg_font;
    int msg_px = w * 26 / 1000;
    SIZE size;

    if (!g_current.is_call && !g_current.is_announcement) return h;
    if (msg_px < 16) msg_px = 16;

    if (g_expiry_local != 0) {
        ULONGLONG now = unix_ms_now();
        ULONGLONG remain = g_expiry_local > now ? g_expiry_local - now : 0;
        int filled = (int)((double)w * (g_total_ms ? (double)remain / (double)g_total_ms : 0));
        foot_top -= bar_h;
        fill_rect(dc, 0, foot_top, w, h, C_INK_700);
        fill_rect(dc, 0, foot_top, filled, h, C_GOLD);
    }
    if (g_current.is_call && g_current.message[0] != L'\0') {
        msg_font = make_font(msg_px, FW_BOLD);
        size = measure(dc, msg_font, g_current.message);
        foot_top -= size.cy + h * 52 / 1000;
        fill_rect(dc, 0, foot_top, w, foot_top + 1, C_INK_600);
        draw_text_at(dc, msg_font, C_GOLD, w / 2, foot_top + h * 26 / 1000, g_current.message, TA_CENTER);
        DeleteObject(msg_font);
    }
    return foot_top;
}

static void paint_reconnect_notice(HDC dc, int w, int h)
{
    WCHAR text[256];
    HFONT font;
    int px = w * 105 / 10000;
    SIZE size;
    RECT r;
    HBRUSH brush;
    HPEN pen;
    HGDIOBJ old_brush, old_pen;

    if (g_connected || g_preview) return;
    if (g_conn_hint[0] != L'\0') StringCchPrintfW(text, 256, L"正在重新连接…  %ls", g_conn_hint);
    else StringCchCopyW(text, 256, L"正在连接服务器…");
    if (px < 14) px = 14;
    font = make_font(px, FW_SEMIBOLD);
    size = measure(dc, font, text);
    r.left = w / 2 - size.cx / 2 - 20; r.right = w / 2 + size.cx / 2 + 20;
    r.top = h * 24 / 1000 + 0; r.bottom = r.top + size.cy + 20;
    brush = CreateSolidBrush(RGB(0x36, 0x14, 0x18));
    pen = CreatePen(PS_SOLID, 1, RGB(0x80, 0x2E, 0x2A));
    old_brush = SelectObject(dc, brush);
    old_pen = SelectObject(dc, pen);
    RoundRect(dc, r.left, r.top, r.right, r.bottom, r.bottom - r.top, r.bottom - r.top);
    SelectObject(dc, old_brush);
    SelectObject(dc, old_pen);
    DeleteObject(brush);
    DeleteObject(pen);
    draw_text_at(dc, font, C_ALERT_TXT, w / 2, r.top + 10, text, TA_CENTER);
    DeleteObject(font);
}

/* 班级绑定错误：醒目提示，不画任何通知内容 */
static void paint_bind_error(HDC dc, int w, int top, int bottom)
{
    WCHAR detail[CC_CLASS_ID_UNITS + 96];
    HFONT title_font, detail_font;
    int title_px = w * 5 / 100, detail_px = w * 2 / 100, cy;
    SIZE size;

    if (title_px < 28) title_px = 28;
    if (detail_px < 14) detail_px = 14;
    title_font = make_font(title_px, FW_EXTRABOLD);
    detail_font = make_font(detail_px, FW_MEDIUM);
    StringCchPrintfW(detail, sizeof(detail) / sizeof(detail[0]),
        L"服务器上没有班级「%ls」，请检查 display.ini 的 class_id", g_config.class_id);
    cy = (top + bottom) / 2;
    size = measure(dc, title_font, L"班级绑定错误");
    draw_text_at(dc, title_font, C_ALERT_TXT, w / 2, cy - size.cy, L"班级绑定错误", TA_CENTER);
    draw_text_at(dc, detail_font, C_ON_BODY, w / 2, cy + size.cy / 3, detail, TA_CENTER);
    DeleteObject(title_font);
    DeleteObject(detail_font);
}

/* 班级留言版式：标题 + 正文 + 发布人。没有「收到」按钮，学生不需要做任何操作。 */
static void paint_announcement(HDC dc, int w, int top, int bottom)
{
    HFONT kind_font, title_font, body_font, author_font;
    const WCHAR *kind = g_current.priority == 1 ? L"紧急通知" : L"班级留言";
    COLORREF accent = g_current.priority == 1 ? C_ALERT_TXT : C_GOLD;
    int kind_px = w * 15 / 1000, title_px = w * 52 / 1000, body_px = w * 29 / 1000, author_px = w * 17 / 1000;
    int pad_top = (bottom - top) * 32 / 1000, y, line_w = w * 6 / 100, x, label_w;
    SIZE size;
    HGDIOBJ old;
    RECT body_rect;
    int body_h, rule_w;

    if (kind_px < 13) kind_px = 13;
    if (title_px < 28) title_px = 28;
    if (title_px > (bottom - top) * 9 / 100) title_px = (bottom - top) * 9 / 100;
    if (body_px < 20) body_px = 20;
    if (body_px > (bottom - top) * 6 / 100) body_px = (bottom - top) * 6 / 100;
    if (author_px < 14) author_px = 14;

    kind_font = make_font(kind_px, FW_SEMIBOLD);
    title_font = make_font(title_px, FW_BOLD);
    body_font = make_font(body_px, FW_NORMAL);
    author_font = make_font(author_px, FW_SEMIBOLD);

    /* 顶部小标签「班级留言」/「紧急通知」，两侧渐隐线 */
    y = top + pad_top;
    old = SelectObject(dc, kind_font);
    SetTextCharacterExtra(dc, kind_px * 42 / 100);
    GetTextExtentPoint32W(dc, kind, (int)wcslen(kind), &size);
    label_w = size.cx;
    SetTextColor(dc, accent);
    SetTextAlign(dc, TA_CENTER | TA_TOP);
    TextOutW(dc, w / 2 + kind_px * 21 / 100, y, kind, (int)wcslen(kind));
    SetTextCharacterExtra(dc, 0);
    SelectObject(dc, old);
    x = w / 2 - label_w / 2 - w * 12 / 1000;
    fill_rect(dc, x - line_w, y + size.cy / 2 - 1, x, y + size.cy / 2 + 1, g_current.priority == 1 ? C_ALERT : C_GOLD_DIM);
    fill_rect(dc, w - x, y + size.cy / 2 - 1, w - x + line_w, y + size.cy / 2 + 1, g_current.priority == 1 ? C_ALERT : C_GOLD_DIM);
    y += size.cy;

    /* 正文高度先量出来，再让标题 + 正文整体垂直居中 */
    body_rect.left = w * 9 / 100; body_rect.right = w - w * 9 / 100; body_rect.top = 0; body_rect.bottom = 0;
    old = SelectObject(dc, body_font);
    body_h = g_current.body[0] != L'\0'
        ? DrawTextW(dc, g_current.body, -1, &body_rect, DT_CALCRECT | DT_CENTER | DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL)
        : 0;
    SelectObject(dc, old);
    size = measure(dc, title_font, g_current.title[0] != L'\0' ? g_current.title : L" ");
    {
        int author_h = author_px * 2 + (bottom - top) * 3 / 100;
        int avail_top = y + (bottom - top) * 2 / 100;
        int avail_bottom = bottom - author_h;
        int total = size.cy + title_px * 45 / 100 + (body_h ? body_h + body_px * 12 / 10 : 0);
        int start = (avail_top + avail_bottom) / 2 - total / 2;
        if (start < avail_top) start = avail_top;

        if (g_current.title[0] != L'\0') {
            draw_text_at(dc, title_font, C_WHITE, w / 2, start, g_current.title, TA_CENTER);
        }
        rule_w = w * 18 / 100;
        fill_rect(dc, w / 2 - rule_w / 2, start + size.cy + title_px * 20 / 100,
            w / 2 + rule_w / 2, start + size.cy + title_px * 20 / 100 + (title_px * 6 / 100 < 3 ? 3 : title_px * 6 / 100), accent);
        if (body_h) {
            body_rect.top = start + size.cy + title_px * 45 / 100 + body_px * 12 / 10;
            body_rect.bottom = avail_bottom;
            old = SelectObject(dc, body_font);
            SetTextColor(dc, C_ON_STRONG);
            DrawTextW(dc, g_current.body, -1, &body_rect, DT_CENTER | DT_WORDBREAK | DT_NOPREFIX | DT_EDITCONTROL);
            SelectObject(dc, old);
        }
    }

    /* 发布人：右下角「—— 数学老师 · 张老师」 */
    if (g_current.caller[0] != L'\0') {
        WCHAR author[CC_CALLER_UNITS + 8];
        StringCchPrintfW(author, CC_CALLER_UNITS + 8, L"—— %ls", g_current.caller);
        draw_text_at(dc, author_font, C_ON_MUTED, w - w * 5 / 100, bottom - author_px * 2 - (bottom - top) * 2 / 100, author, TA_RIGHT);
    }

    DeleteObject(kind_font);
    DeleteObject(title_font);
    DeleteObject(body_font);
    DeleteObject(author_font);
}

/* 底部小提示：还有几条内容在服务端排队等待显示 */
static void paint_queue_hint(HDC dc, int w, int h)
{
    WCHAR text[48];
    HFONT font;
    int px = w * 11 / 1000;
    SIZE size;
    int pad, x, y;

    if (g_current.queued <= 0 || (!g_current.is_call && !g_current.is_announcement)) return;
    if (px < 12) px = 12;
    StringCchPrintfW(text, 48, L"还有 %d 条内容等待显示", g_current.queued);
    font = make_font(px, FW_SEMIBOLD);
    size = measure(dc, font, text);
    pad = px * 8 / 10;
    x = w / 2 - size.cx / 2 - pad;
    y = h - size.cy - pad * 2 - 14;
    fill_rect(dc, x, y, x + size.cx + pad * 2, y + size.cy + pad * 2, C_INK_700);
    draw_text_at(dc, font, C_ON_MUTED, w / 2, y + pad, text, TA_CENTER);
    DeleteObject(font);
}

static void paint(HWND hwnd)
{
    PAINTSTRUCT ps;
    HDC window_dc, dc;
    HBITMAP bitmap;
    HGDIOBJ old_bitmap;
    RECT client;
    int w, h, rail_bottom, foot_top;

    window_dc = BeginPaint(hwnd, &ps);
    GetClientRect(hwnd, &client);
    w = client.right; h = client.bottom;
    if (w <= 0 || h <= 0) { EndPaint(hwnd, &ps); return; }

    dc = CreateCompatibleDC(window_dc);
    bitmap = CreateCompatibleBitmap(window_dc, w, h);
    old_bitmap = SelectObject(dc, bitmap);
    SetBkMode(dc, TRANSPARENT);

    fill_gradient_vertical(dc, &client, C_INK_800, C_INK_900);
    paint_rail(dc, w, h, &rail_bottom);
    foot_top = paint_foot(dc, w, h);
    if (g_bind_error) {
        memset(&g_ack_rect, 0, sizeof(g_ack_rect));
        g_name_rect_count = 0;
        paint_bind_error(dc, w, rail_bottom, foot_top);
    } else if (g_current.is_call) {
        paint_call(dc, w, rail_bottom, foot_top);
    } else if (g_current.is_announcement) {
        memset(&g_ack_rect, 0, sizeof(g_ack_rect));
        g_name_rect_count = 0;
        paint_announcement(dc, w, rail_bottom, foot_top);
    } else {
        memset(&g_ack_rect, 0, sizeof(g_ack_rect));
        g_name_rect_count = 0;
        paint_idle(dc, w, rail_bottom, foot_top);
    }
    paint_queue_hint(dc, w, h);
    paint_reconnect_notice(dc, w, h);

    BitBlt(window_dc, 0, 0, w, h, dc, 0, 0, SRCCOPY);
    SelectObject(dc, old_bitmap);
    DeleteObject(bitmap);
    DeleteDC(dc);
    EndPaint(hwnd, &ps);
}

/* ================= 窗口过程 ================= */

static LRESULT CALLBACK window_proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
    switch (message) {
    case WM_CREATE:
        g_hwnd = hwnd;
        SetTimer(hwnd, TIMER_CLOCK, 1000, NULL);
        return 0;

    case WM_ERASEBKGND:
        return 1;

    case WM_PAINT:
        paint(hwnd);
        return 0;

    case WM_TIMER:
        if (wparam == TIMER_CLOCK || wparam == TIMER_PROGRESS) {
            InvalidateRect(hwnd, NULL, FALSE);
        } else if (wparam == TIMER_CURSOR) {
            KillTimer(hwnd, TIMER_CURSOR);
            g_cursor_visible = 0;
            SetCursor(NULL);
        } else if (wparam == TIMER_EXPIRE) {
            KillTimer(hwnd, TIMER_EXPIRE);
            if ((g_current.is_call || g_current.is_announcement) && g_expiry_local != 0 && unix_ms_now() >= g_expiry_local) {
                DisplayEvent clear;
                memset(&clear, 0, sizeof(clear));
                clear.id = g_last_id;
                log_line(L"local expiry fallback cleared display");
                apply_event(&clear);
            }
        }
        return 0;

    case WM_APP_EVENT: {
        DisplayEvent *event = (DisplayEvent *)lparam;
        if (event != NULL) { apply_event(event); free(event); }
        return 0;
    }

    case WM_APP_CONN:
        g_connected = wparam != 0;
        if (g_connected) {
            g_conn_error = 0;
            StringCchCopyW(g_conn_text, 64, L"已连接");
            g_conn_hint[0] = L'\0';
        } else {
            g_conn_error = (DWORD)lparam;
            if (g_conn_error != 0) StringCchPrintfW(g_conn_text, 64, L"未连接 · 错误 %lu", (unsigned long)g_conn_error);
            else StringCchCopyW(g_conn_text, 64, L"未连接");
            StringCchCopyW(g_conn_hint, 160, error_hint(g_conn_error));
        }
        InvalidateRect(hwnd, NULL, FALSE);
        return 0;

    case WM_APP_CONFIG: {
        ClassInfo *info = (ClassInfo *)lparam;
        if (info != NULL) {
            if (wparam != 0) {
                DisplayEvent clear;
                g_bind_error = 1;
                StringCchCopyW(g_class_name, CC_CLASS_NAME_UNITS + 1, L"班级绑定错误");
                g_class_code[0] = L'\0';
                /* 绑定错误期间不展示任何通知：清掉可能已经画上去的内容 */
                memset(&clear, 0, sizeof(clear));
                clear.id = g_last_id;
                apply_event(&clear);
                SetWindowTextW(hwnd, L"班级绑定错误 · " CC_APP_TITLE);
            } else {
                WCHAR title[CC_CLASS_NAME_UNITS + 40];
                g_bind_error = 0;
                StringCchCopyW(g_class_name, CC_CLASS_NAME_UNITS + 1, info->name);
                StringCchCopyW(g_class_code, CC_CLASS_CODE_UNITS + 1, info->code);
                StringCchPrintfW(title, sizeof(title) / sizeof(title[0]), L"%ls · " CC_APP_TITLE, info->name);
                SetWindowTextW(hwnd, title);
            }
            free(info);
            InvalidateRect(hwnd, NULL, FALSE);
        }
        return 0;
    }

    case WM_APP_SHOW:
        bring_to_front();
        return 0;

    case WM_APP_ACK:
        finish_ack(wparam != 0, (AckJob *)lparam);
        return 0;

    case WM_LBUTTONDOWN: {
        POINT pt;
        int i;
        pt.x = (short)LOWORD(lparam);
        pt.y = (short)HIWORD(lparam);
        if (!g_current.is_call) return 0;
        if (PtInRect(&g_ack_rect, pt)) { send_ack(-1); return 0; }
        for (i = 0; i < g_name_rect_count; ++i) {
            if (PtInRect(&g_name_rects[i], pt)) { send_ack(i); return 0; }
        }
        return 0;
    }

    case WM_DISPLAYCHANGE:
        fit_to_monitor();
        return 0;

    case WM_NCHITTEST: {
        /* 窗口模式下禁止拖动改大小/移动：始终保持最大化，标题栏按钮照常可用 */
        LRESULT hit = DefWindowProcW(hwnd, message, wparam, lparam);
        if (!g_config.fullscreen && hit >= HTLEFT && hit <= HTBOTTOMRIGHT) return HTBORDER;
        return hit;
    }

    case WM_SETCURSOR:
        if (LOWORD(lparam) == HTCLIENT && g_config.hide_cursor && !g_cursor_visible) {
            SetCursor(NULL);
            return TRUE;
        }
        break;

    case WM_MOUSEMOVE: {
        POINT pt;
        int over = 0, i;
        pt.x = (short)LOWORD(lparam);
        pt.y = (short)HIWORD(lparam);
        if (g_current.is_call) {
            over = PtInRect(&g_ack_rect, pt);
            for (i = 0; !over && i < g_name_rect_count; ++i) over = PtInRect(&g_name_rects[i], pt);
        }
        if (g_config.hide_cursor) {
            g_cursor_visible = 1;
            SetTimer(hwnd, TIMER_CURSOR, 2600, NULL);
        }
        SetCursor(LoadCursorW(NULL, over ? IDC_HAND : IDC_ARROW));
        return 0;
    }

    case WM_KEYDOWN:
        if (wparam == VK_ESCAPE) {
            ShowWindow(hwnd, SW_MINIMIZE);           /* 不退出：下一次通知会自动恢复 */
        } else if (wparam == 'Q' && (GetKeyState(VK_CONTROL) & 0x8000)) {
            DestroyWindow(hwnd);
        } else if (wparam == VK_RETURN || wparam == VK_SPACE) {
            send_ack(-1);                            /* 键盘/遥控器也能确认收到 */
        } else if (wparam == 'M') {
            g_config.sound = !g_config.sound;
        } else if (wparam == VK_F11) {
            g_config.fullscreen = !g_config.fullscreen;
            apply_window_mode();
            fit_to_monitor();
        } else if (wparam == 'T') {
            g_config.always_topmost = !g_config.always_topmost;
            set_topmost(g_config.always_topmost || ((g_current.is_call || g_current.is_announcement) && g_config.topmost_when_active));
        }
        return 0;

    case WM_SYSCOMMAND:
        if ((wparam & 0xFFF0) == SC_SCREENSAVE || (wparam & 0xFFF0) == SC_MONITORPOWER) {
            if (g_current.is_call || g_current.is_announcement) return 0;     /* 显示通知时阻止屏保/关屏 */
        }
        break;

    case WM_CLOSE:
        if (GetKeyState(VK_CONTROL) & 0x8000) DestroyWindow(hwnd);
        else ShowWindow(hwnd, SW_MINIMIZE);
        return 0;

    case WM_DESTROY:
        InterlockedExchange(&g_stop, 1);
        KillTimer(hwnd, TIMER_CLOCK);
        KillTimer(hwnd, TIMER_PROGRESS);
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, message, wparam, lparam);
}

/* ================= 入口 ================= */

typedef BOOL (WINAPI *SetProcessDPIAwareFn)(void);

static void enable_dpi_awareness(void)
{
    HMODULE user32 = GetModuleHandleW(L"user32.dll");
    SetProcessDPIAwareFn fn;
    if (user32 == NULL) return;
    fn = (SetProcessDPIAwareFn)(void *)GetProcAddress(user32, "SetProcessDPIAware");
    if (fn != NULL) fn();
}

/* 开机自启：写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run，指向本 exe 的绝对路径 */
static int set_autostart(int enable)
{
    HKEY key;
    WCHAR exe[CC_PATH_CHARS];
    WCHAR command[CC_PATH_CHARS + 16];
    LONG status;

    if (GetModuleFileNameW(NULL, exe, CC_PATH_CHARS) == 0) return 0;
    status = RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        0, NULL, REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, NULL, &key, NULL);
    if (status != ERROR_SUCCESS) return 0;
    if (enable) {
        StringCchPrintfW(command, CC_PATH_CHARS + 16, L"\"%ls\" --minimized", exe);
        status = RegSetValueExW(key, L"ClassCallerDisplay", 0, REG_SZ, (const BYTE *)command,
            (DWORD)((wcslen(command) + 1) * sizeof(WCHAR)));
    } else {
        status = RegDeleteValueW(key, L"ClassCallerDisplay");
        if (status == ERROR_FILE_NOT_FOUND) status = ERROR_SUCCESS;
    }
    RegCloseKey(key);
    return status == ERROR_SUCCESS;
}

static void split_preview_names(const WCHAR *list, DisplayEvent *event)
{
    const WCHAR *start = list;
    SIZE_T n;

    memset(event, 0, sizeof(*event));
    event->is_call = 1;
    event->id = 1;
    while (*start != L'\0' && event->name_count < CC_MAX_NAMES) {
        const WCHAR *end = wcschr(start, L',');
        if (end == NULL) end = start + wcslen(start);
        n = (SIZE_T)(end - start);
        if (n > CC_MAX_NAME_UNITS) n = CC_MAX_NAME_UNITS;
        if (n > 0) {
            memcpy(event->names[event->name_count], start, n * sizeof(WCHAR));
            event->names[event->name_count][n] = L'\0';
            ++event->name_count;
        }
        start = *end == L',' ? end + 1 : end;
    }
    if (event->name_count == 0) event->is_call = 0;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show)
{
    int argc = 0, i;
    WCHAR **argv;
    const WCHAR *ini_arg = NULL, *server_arg = NULL, *class_arg = NULL, *preview_arg = NULL, *msg_arg = NULL;
    const WCHAR *notice_arg = NULL;
    int minimized_arg = 0;
    HANDLE mutex;
    WNDCLASSEXW wc;
    MSG msg;
    DisplayEvent preview_event;

    (void)previous; (void)command_line; (void)show;
    g_instance = instance;

    argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (i = 1; argv != NULL && i < argc; ++i) {
        if (wcscmp(argv[i], L"--config") == 0 && i + 1 < argc) ini_arg = argv[++i];
        else if (wcscmp(argv[i], L"--server") == 0 && i + 1 < argc) server_arg = argv[++i];
        else if (wcscmp(argv[i], L"--class") == 0 && i + 1 < argc) class_arg = argv[++i];
        else if (wcscmp(argv[i], L"--preview") == 0 && i + 1 < argc) preview_arg = argv[++i];
        else if (wcscmp(argv[i], L"--preview-notice") == 0 && i + 1 < argc) notice_arg = argv[++i];
        else if (wcscmp(argv[i], L"--msg") == 0 && i + 1 < argc) msg_arg = argv[++i];
        else if (wcscmp(argv[i], L"--minimized") == 0) minimized_arg = 1;
        else if (wcscmp(argv[i], L"--install-autostart") == 0 || wcscmp(argv[i], L"--uninstall-autostart") == 0) {
            int enable = wcscmp(argv[i], L"--install-autostart") == 0;
            int done = set_autostart(enable);
            MessageBoxW(NULL,
                done ? (enable ? L"已设置开机自启：下次登录 Windows 时自动最小化启动大屏。" : L"已取消开机自启。")
                     : L"写入注册表失败，请用有权限的账号重试。",
                CC_APP_TITLE, done ? (MB_ICONINFORMATION | MB_OK) : (MB_ICONERROR | MB_OK));
            return done ? 0 : 3;
        } else {
            MessageBoxW(NULL,
                L"用法：\n"
                L"  display.exe [--config D:\\class-caller\\display.ini] [--server https://域名] [--class class-a]\n"
                L"  display.exe --preview 张三,李四 [--msg 请到办公室]\n"
                L"  display.exe --preview-notice 标题|正文    （离线预览班级留言版式）\n"
                L"  display.exe --minimized\n"
                L"  display.exe --install-autostart | --uninstall-autostart\n\n"
                L"再次运行 display.exe 会把已经在运行的大屏窗口拉到最前。",
                CC_APP_TITLE, MB_ICONINFORMATION | MB_OK);
            return 2;
        }
    }

    /* 单实例：第二次启动只负责把已有窗口拉到前台，可作为“唤醒”脚本使用 */
    mutex = CreateMutexW(NULL, TRUE, CC_MUTEX_NAME);
    if (mutex != NULL && GetLastError() == ERROR_ALREADY_EXISTS) {
        HWND existing = FindWindowW(CC_WINDOW_CLASS, NULL);
        if (existing != NULL) {
            AllowSetForegroundWindow(ASFW_ANY);
            PostMessageW(existing, WM_APP_SHOW, 0, 0);
        }
        return 0;
    }

    load_config(ini_arg, server_arg, class_arg);
    if (g_config.log_path[0] != L'\0') {
        g_log = CreateFileW(g_config.log_path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS,
            FILE_ATTRIBUTE_NORMAL, NULL);
    }
    log_line(L"display starting; server=%ls class_id=%ls ini=%ls", g_config.server, g_config.class_id, g_config.ini_path);

    if (notice_arg != NULL) {
        g_preview = 1;
        if (preview_arg == NULL) preview_arg = L"";
    }
    if (preview_arg != NULL) {
        g_preview = 1;
        StringCchCopyW(g_conn_text, 64, L"预览模式");
        g_connected = 1;
        StringCchCopyW(g_class_name, CC_CLASS_NAME_UNITS + 1, L"预览班级");
        StringCchCopyW(g_class_code, CC_CLASS_CODE_UNITS + 1, L"00");
    } else if (g_config.server[0] == L'\0') {
        MessageBoxW(NULL,
            L"没有配置服务器地址。\n\n请在 display.exe 旁边的 display.ini 中写入：\n\n"
            L"[display]\nserver=https://你的域名\nclass_id=class-a\n\n或用 --server / --class 参数启动。",
            CC_APP_TITLE, MB_ICONERROR | MB_OK);
        return 2;
    } else if (g_config.class_id[0] == L'\0') {
        /* 没有绑定班级绝不能默认进入任何班：直接拒绝启动 */
        log_line(L"refusing to start: class_id is not configured");
        MessageBoxW(NULL,
            L"此设备尚未绑定班级。\n\n请在 display.exe 旁边的 display.ini 中写入本教室的班级标识，例如：\n\n"
            L"[display]\nserver=https://你的域名\nclass_id=class-a\n\n"
            L"班级标识以服务器 students.json 里各班的 id 为准。不会默认进入任何班级。",
            CC_APP_TITLE L" · 未绑定班级", MB_ICONERROR | MB_OK);
        return 2;
    } else if (!class_id_valid(g_config.class_id)) {
        log_line(L"refusing to start: class_id '%ls' is not a valid class id", g_config.class_id);
        MessageBoxW(NULL,
            L"display.ini 里的 class_id 格式不正确。\n\n只能使用小写字母、数字和连字符（1–32 位），例如 class-a。",
            CC_APP_TITLE L" · 班级绑定错误", MB_ICONERROR | MB_OK);
        return 2;
    }

    enable_dpi_awareness();
    memset(&wc, 0, sizeof(wc));
    wc.cbSize = sizeof(wc);
    wc.style = CS_HREDRAW | CS_VREDRAW;
    wc.lpfnWndProc = window_proc;
    wc.hInstance = instance;
    wc.hIcon = LoadIconW(NULL, IDI_APPLICATION);
    wc.hCursor = NULL;
    wc.hbrBackground = NULL;
    wc.lpszClassName = CC_WINDOW_CLASS;
    if (!RegisterClassExW(&wc)) return 1;

    g_hwnd = CreateWindowExW(WS_EX_APPWINDOW, CC_WINDOW_CLASS,
        CC_APP_TITLE,
        g_config.fullscreen ? (WS_POPUP | WS_MINIMIZEBOX | WS_SYSMENU) : WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT, CW_USEDEFAULT, 1024, 640, NULL, NULL, instance, NULL);
    if (g_hwnd == NULL) return 1;
    if (g_config.always_topmost) set_topmost(1);
    if (minimized_arg || g_config.start_minimized) {
        ShowWindow(g_hwnd, SW_SHOWMINIMIZED);
    } else if (g_config.fullscreen) {
        fit_to_monitor();
        ShowWindow(g_hwnd, SW_SHOW);
    } else {
        ShowWindow(g_hwnd, SW_SHOWMAXIMIZED);
    }
    UpdateWindow(g_hwnd);

    if (g_preview && notice_arg != NULL) {
        /* --preview-notice "标题|正文"：离线预览留言版式 */
        const WCHAR *bar = wcschr(notice_arg, L'|');
        memset(&preview_event, 0, sizeof(preview_event));
        preview_event.is_announcement = 1;
        preview_event.priority = 4;
        preview_event.id = 1;
        if (bar != NULL) {
            size_t n = (size_t)(bar - notice_arg);
            if (n > CC_TITLE_UNITS) n = CC_TITLE_UNITS;
            wcsncpy(preview_event.title, notice_arg, n);
            preview_event.title[n] = L'\0';
            StringCchCopyW(preview_event.body, CC_BODY_UNITS + 1, bar + 1);
        } else {
            StringCchCopyW(preview_event.title, CC_TITLE_UNITS + 1, notice_arg);
        }
        StringCchCopyW(preview_event.caller, CC_CALLER_UNITS + 1, L"数学老师 · 张老师");
        preview_event.created_at = unix_ms_now();
        preview_event.server_time = preview_event.created_at;
        preview_event.expires_at = preview_event.created_at + 60000ULL;
        apply_event(&preview_event);
    } else if (g_preview) {
        split_preview_names(preview_arg, &preview_event);
        StringCchCopyW(preview_event.caller, CC_CALLER_UNITS + 1, CC_DEFAULT_CALLER);
        if (msg_arg != NULL) StringCchCopyW(preview_event.message, CC_MAX_MESSAGE_UNITS + 1, msg_arg);
        preview_event.created_at = unix_ms_now();
        preview_event.server_time = preview_event.created_at;
        preview_event.expires_at = preview_event.created_at + 60000ULL;
        apply_event(&preview_event);
    } else {
        g_net_thread = CreateThread(NULL, 0, network_thread, NULL, 0, NULL);
    }

    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    InterlockedExchange(&g_stop, 1);
    if (g_net_thread != NULL) {
        /* 阻塞中的 WinHttpReadData 最长等一个接收超时；不必为它拖延退出 */
        WaitForSingleObject(g_net_thread, 1500);
        CloseHandle(g_net_thread);
    }
    if (g_log != INVALID_HANDLE_VALUE) CloseHandle(g_log);
    if (mutex != NULL) CloseHandle(mutex);
    return (int)msg.wParam;
}
