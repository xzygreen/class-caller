#define CC_NATIVE_CONTRACT_TEST
#include "../../windows-display/src/display.c"

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
