/* SPDX-License-Identifier: AGPL-3.0-only */
/* Pseudo-Chrome's installed native entry point.
 * The actual Electron engine and its private assets are in /usr/lib/pseudo-chrome.
 * This is a real ELF executable: no symlink or shell launcher is installed.
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
    const char *engine = "/usr/lib/pseudo-chrome/pseudo-chrome-runtime";
    char **args = calloc((size_t)argc + 1, sizeof(*args));
    if (!args) { perror("Pseudo-Chrome"); return 127; }
    args[0] = (char *)engine;
    for (int i = 1; i < argc; i++) args[i] = argv[i];
    execv(engine, args);
    fprintf(stderr, "Pseudo-Chrome: cannot start %s: %s\n", engine, strerror(errno));
    free(args);
    return 127;
}
