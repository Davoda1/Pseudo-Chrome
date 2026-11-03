/* Pseudo-Chrome PHP runtime bootstrap. SPDX-License-Identifier: AGPL-3.0-only */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void join(char *out, size_t size, const char *directory, const char *tail) {
    int n = snprintf(out, size, "%s/%s", directory, tail);
    if (n < 0 || (size_t)n >= size) {
        fputs("PHP runtime path is too long.\n", stderr);
        exit(126);
    }
}

int main(int argc, char **argv) {
    char executable[PATH_MAX], loader[PATH_MAX], libraries[PATH_MAX];
    char program[PATH_MAX], configuration[PATH_MAX], certificates[PATH_MAX];
    ssize_t n = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
    if (n < 0 || (size_t)n >= sizeof(executable) - 1) {
        perror("Cannot locate PHP runtime");
        return 126;
    }
    executable[n] = '\0';
    char *slash = strrchr(executable, '/');
    if (!slash) return 126;
    *slash = '\0';
    join(loader, sizeof(loader), executable, "lib/ld-linux-x86-64.so.2");
    join(libraries, sizeof(libraries), executable, "lib");
    join(program, sizeof(program), executable, "php-cgi.real");
    join(configuration, sizeof(configuration), executable, "php.ini");
    join(certificates, sizeof(certificates), executable, "cacert.pem");
    if (!getenv("PHPRC")) setenv("PHPRC", configuration, 1);
    if (!getenv("PHP_INI_SCAN_DIR")) setenv("PHP_INI_SCAN_DIR", "", 1);
    if (!getenv("PSEUDO_PHP_CA")) setenv("PSEUDO_PHP_CA", certificates, 1);
    char **child = calloc((size_t)argc + 5, sizeof(char *));
    if (!child) return 126;
    child[0] = loader;
    child[1] = "--library-path";
    child[2] = libraries;
    child[3] = program;
    for (int i = 1; i < argc; ++i) child[i + 3] = argv[i];
    child[argc + 3] = NULL;
    execv(loader, child);
    fprintf(stderr, "Cannot start bundled PHP runtime: %s\n", strerror(errno));
    free(child);
    return 126;
}
