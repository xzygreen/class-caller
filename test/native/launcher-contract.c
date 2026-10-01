#define CC_NATIVE_CONTRACT_TEST
#include "../../windows-launcher/src/win7-launcher.c"

int main(int argc, char **argv)
{
    SIZE_T length;
    char *input = contract_input(&length);
    char payload[CC_MAX_PAYLOAD_CHARS + 1];
    WCHAR *wide = NULL;
    PayloadInfo info;
    WatchEnvelope envelope;
    int valid = 0;
    if (argc != 2) return 64;
    if (strcmp(argv[1], "watch") == 0) {
        valid = validate_watch_payload(input, length, &envelope, &info);
        if (!valid) { puts("ignored"); free(input); return 0; }
        valid = valid > 0;
    } else if (strcmp(argv[1], "payload") == 0 || strcmp(argv[1], "uri") == 0) {
        wide = contract_ascii(input);
        valid = strcmp(argv[1], "uri") == 0
            ? uri_to_payload(wide, payload, sizeof(payload))
            : payload_argument_ascii(wide, payload, sizeof(payload));
        if (valid) valid = validate_encoded_payload(payload, &info);
    } else return 64;
    if (valid) printf("%s %s %s %llu\n", info.class_id, info.delivery_id,
        info.record_id, (unsigned long long)info.issued_at);
    free(wide);
    free(input);
    return valid ? 0 : 2;
}
