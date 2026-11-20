/* Negative controls; no keychain queries or directory enumeration. */
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;
static int failures;
static void check(const char *name, int ok) {
    printf("%s: %s\n", name, ok ? "pass" : "FAIL");
    failures += !ok;
}
static int denied(const char *path, int flags) {
    int fd = open(path, flags);
    if (fd >= 0) { close(fd); return 0; }
    return errno == EPERM || errno == EACCES;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int count = 0;
    for (char **p = environ; *p; p++) count++;
    check("clean environment", count == 3 && getenv("HOME") && getenv("TMPDIR") && getenv("CLAUDE_CONFIG_DIR"));
    check("outside read denied", denied(argv[1], O_RDONLY));
    check("outside write denied", denied(argv[1], O_WRONLY));
    check("Users denied", denied("/Users", O_RDONLY));
    check("Keychains denied", denied("/Library/Keychains", O_RDONLY));
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t kr = bootstrap_look_up(bootstrap_port, "com.apple.securityd", &port);
    printf("securityd bootstrap lookup: %d\n", kr);
    check("keychain IPC unavailable", kr != KERN_SUCCESS && port == MACH_PORT_NULL);
    int s = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_len = sizeof(a), .sin_family = AF_INET,
        .sin_port = htons(9), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    int rc = s < 0 ? -1 : connect(s, (struct sockaddr *)&a, sizeof(a));
    check("network denied", rc < 0 && (errno == EPERM || errno == EACCES));
    if (s >= 0) close(s);
    int fd = open("fixture-write", O_WRONLY | O_CREAT | O_EXCL, 0600);
    check("fixture writable", fd >= 0 && write(fd, "ok", 2) == 2);
    if (fd >= 0) close(fd);
    return !!failures;
}
