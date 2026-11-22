#define CC_NATIVE_CONTRACT_TEST
#include "../../windows-display/src/display.c"

static void print_ascii(const WCHAR *text)
{
    for (; *text; ++text) putchar((int)*text);
}

/* UTF-16 units as hex, so the Node side can compare exact text without locale-dependent output. */
static void print_units(const WCHAR *text)
{
    putchar(' ');
    if (!*text) putchar('-');
    for (; *text; ++text) printf("%04x", (unsigned)*text);
}

static void print_calls(const StudentCall *calls, int count)
{
    int i;
    for (i = 0; i < count; ++i) {
        print_ascii(calls[i].id);
        printf(" %d %llu %d", calls[i].status, (unsigned long long)calls[i].created_at, calls[i].settled_local != 0);
        print_units(calls[i].student); print_units(calls[i].teacher);
        print_units(calls[i].message); print_units(calls[i].reply);
        putchar('\n');
    }
}

int main(int argc, char **argv)
{
    SIZE_T length;
    char *input = contract_input(&length);
    DisplayEvent event;
    ClassInfo info;
    WCHAR *wide = NULL, assigned[CC_CLASS_ID_UNITS + 1];
    int valid = 0, not_found = 0, i, acked = 0;
    if (argc != 2) return 64;
    if (strcmp(argv[1], "snapshot") == 0) {
        valid = parse_snapshot(input, length, &event);
        if (valid) {
            for (i = 0; i < event.name_count; ++i) acked += event.acked[i];
            printf("%s %llu %d %d %zu %zu\n", event.is_call ? "call" :
                event.is_announcement ? "announcement" : "clear",
                (unsigned long long)event.id, event.name_count, acked,
                wcslen(event.title), wcslen(event.body));
        }
    } else if (strcmp(argv[1], "config") == 0) {
        valid = parse_public_config(input, length, &info, &not_found);
        if (valid) puts(not_found ? "not-found" : "configured");
    } else if (strcmp(argv[1], "call-options") == 0) {
        static CallOptions options;
        valid = parse_call_options(input, length, &options);
        if (valid) {
            print_ascii(options.class_id);
            printf(" %d %d\n", options.window_open, options.teacher_count);
            for (i = 0; i < options.teacher_count; ++i) {
                print_ascii(options.teachers[i].id);
                print_units(options.teachers[i].name); print_units(options.teachers[i].title);
                putchar('\n');
            }
        }
    } else if (strcmp(argv[1], "call-reply") == 0 || strcmp(argv[1], "call-merge") == 0
        || strcmp(argv[1], "call-body") == 0) {
        static CallReply reply;
        valid = parse_call_reply(input, length, &reply);
        if (valid && strcmp(argv[1], "call-body") == 0) {
            /* Re-encode the parsed call as a request body; ids stand in for teacherId/requestId. */
            char body[1024];
            SIZE_T used = 0;
            valid = reply.ok && reply.call_count == 1 && build_call_body(body, sizeof(body), &used,
                reply.calls[0].student, reply.calls[0].id, reply.calls[0].message, reply.calls[0].id);
            if (valid) puts(body);
        } else if (valid && strcmp(argv[1], "call-merge") == 0) {
            /* Feed the calls one by one, as successive server responses would arrive. */
            static StudentCall kept[CC_MAX_RECEIPTS];
            int count = 0, replied = 0;
            for (i = 0; i < reply.call_count; ++i) replied += merge_call(kept, &count, &reply.calls[i], 1000);
            printf("%d %d\n", count, replied);
            print_calls(kept, count);
        } else if (valid && reply.ok) {
            printf("ok %d\n", reply.call_count);
            print_calls(reply.calls, reply.call_count);
        } else if (valid) {
            printf("error ");
            print_ascii(reply.error);
            print_units(reply.message);
            putchar('\n');
        }
    } else if (strcmp(argv[1], "class-cli") == 0 || strcmp(argv[1], "class-ini") == 0) {
        wide = contract_ascii(input);
        if (strcmp(argv[1], "class-ini") == 0) {
            /* Emulate only the documented read length/truncation boundary, NOT INI I/O. */
            if (length >= CC_CLASS_ID_UNITS + 1) length = CC_CLASS_ID_UNITS + 1;
            wide[length] = 0;
            valid = assign_class_id(assigned, wide, length, length >= CC_CLASS_ID_UNITS + 1);
        } else valid = assign_class_id(assigned, wide, length, 0);
        if (valid) valid = class_id_valid(assigned);
        if (valid) printf("%zu\n", wcslen(assigned));
    } else return 64;
    free(wide);
    free(input);
    return valid ? 0 : 2;
}
