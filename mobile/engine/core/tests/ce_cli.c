/*
 * A command-line harness for the engine on a desktop, for working on the
 * engine itself; the phones run the self-test in example/ instead.
 *
 *   ce-cli run TOOL ARGS...                 one run: lines as they come, then its stdout
 *   ce-cli cancel MS TOOL ARGS...           cancel after MS; say how fast it stopped
 *   ce-cli parallel N TOOL ARGS...          N identical runs at once; check they agree
 */
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "cutalong_engine.h"

typedef struct {
    pthread_mutex_t lock;
    pthread_cond_t done;
    int finished;
    int code;
    char *out;
    size_t out_len;
    size_t err_len;
    int lines[2];
    int quiet;
    double ended;
} result;

static double now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec + ts.tv_nsec / 1e9;
}

static void on_line(void *user, const char *id, int stream, const char *line, size_t len)
{
    result *r = user;
    pthread_mutex_lock(&r->lock);
    r->lines[stream]++;
    pthread_mutex_unlock(&r->lock);
    if (!r->quiet)
        fprintf(stderr, "[%s %s] %.*s\n", id, stream == CE_STDOUT ? "out" : "err", (int)len, line);
}

static void on_exit_run(void *user, const char *id, int code, const char *out, size_t out_len,
                        const char *err, size_t err_len)
{
    result *r = user;
    (void)id;
    (void)err;
    pthread_mutex_lock(&r->lock);
    r->code = code;
    r->out = malloc(out_len + 1);
    memcpy(r->out, out, out_len);
    r->out[out_len] = 0;
    r->out_len = out_len;
    r->err_len = err_len;
    r->finished = 1;
    r->ended = now();
    pthread_cond_signal(&r->done);
    pthread_mutex_unlock(&r->lock);
}

static void wait_for(result *r)
{
    pthread_mutex_lock(&r->lock);
    while (!r->finished)
        pthread_cond_wait(&r->done, &r->lock);
    pthread_mutex_unlock(&r->lock);
}

static void init(result *r, int quiet)
{
    memset(r, 0, sizeof(*r));
    pthread_mutex_init(&r->lock, NULL);
    pthread_cond_init(&r->done, NULL);
    r->quiet = quiet;
}

int main(int argc, char **argv)
{
    if (argc >= 3 && !strcmp(argv[1], "run")) {
        result r;
        init(&r, 0);
        int rc = ce_run("one", argv[2], argc - 3, (const char *const *)argv + 3, on_line, on_exit_run, &r);
        if (rc) {
            fprintf(stderr, "ce_run: %d\n", rc);
            return 2;
        }
        wait_for(&r);
        fwrite(r.out, 1, r.out_len, stdout);
        fprintf(stderr, "exit=%d stdout=%zu bytes, %d lines; stderr tail=%zu bytes, %d lines\n", r.code,
                r.out_len, r.lines[0], r.err_len, r.lines[1]);
        return r.code;
    }
    if (argc >= 4 && !strcmp(argv[1], "cancel")) {
        result r;
        init(&r, 1);
        int ms = atoi(argv[2]);
        double t0 = now();
        if (ce_run("long", argv[3], argc - 4, (const char *const *)argv + 4, on_line, on_exit_run, &r))
            return 2;
        usleep((useconds_t)ms * 1000);
        double asked = now();
        int found = ce_cancel("long");
        wait_for(&r);
        printf("cancel found=%d exit=%d stopped %.3f s after the cancel (ran %.3f s)\n", found, r.code,
               r.ended - asked, r.ended - t0);
        return r.code == CE_CANCELLED && r.ended - asked < 1.5 ? 0 : 1;
    }
    if (argc >= 4 && !strcmp(argv[1], "parallel")) {
        int n = atoi(argv[2]);
        result *rs = calloc((size_t)n, sizeof(result));
        char id[32];
        double t0 = now();
        for (int i = 0; i < n; i++) {
            init(&rs[i], 1);
            snprintf(id, sizeof(id), "p%d", i);
            if (ce_run(id, argv[3], argc - 4, (const char *const *)argv + 4, on_line, on_exit_run, &rs[i]))
                return 2;
        }
        int bad = 0;
        for (int i = 0; i < n; i++) {
            wait_for(&rs[i]);
            int same = rs[i].out_len == rs[0].out_len && !memcmp(rs[i].out, rs[0].out, rs[0].out_len);
            printf("run %d: exit=%d stdout=%zu bytes (%s), %d stdout lines, %d stderr lines\n", i, rs[i].code,
                   rs[i].out_len, same ? "same as run 0" : "DIFFERS", rs[i].lines[0], rs[i].lines[1]);
            bad |= rs[i].code != 0 || !same;
        }
        printf("%d runs in %.3f s; %d still running\n", n, now() - t0, ce_running());
        return bad;
    }
    if (argc == 3 && !strcmp(argv[1], "batch")) {
        /* Each line of the file is a run, "TOOL ARG ARG..." split on spaces.
         * All run at once, then each alone; their stdout must match. */
        FILE *f = fopen(argv[2], "r");
        char line[8192];
        char **cmds[64];
        int ncmd[64], n = 0, bad = 0;
        if (!f)
            return 2;
        while (n < 64 && fgets(line, sizeof(line), f)) {
            char *save, *tok;
            line[strcspn(line, "\n")] = 0;
            if (!line[0] || line[0] == '#')
                continue;
            cmds[n] = calloc(256, sizeof(char *));
            ncmd[n] = 0;
            for (tok = strtok_r(line, " ", &save); tok && ncmd[n] < 255; tok = strtok_r(NULL, " ", &save))
                cmds[n][ncmd[n]++] = strdup(tok);
            n++;
        }
        fclose(f);
        result *together = calloc((size_t)n, sizeof(result));
        char id[32];
        for (int i = 0; i < n; i++) {
            init(&together[i], 1);
            snprintf(id, sizeof(id), "b%d", i);
            if (ce_run(id, cmds[i][0], ncmd[i] - 1, (const char *const *)cmds[i] + 1, on_line, on_exit_run,
                       &together[i]))
                return 2;
        }
        for (int i = 0; i < n; i++)
            wait_for(&together[i]);
        for (int i = 0; i < n; i++) {
            result alone;
            init(&alone, 1);
            if (ce_run("alone", cmds[i][0], ncmd[i] - 1, (const char *const *)cmds[i] + 1, on_line, on_exit_run,
                       &alone))
                return 2;
            wait_for(&alone);
            int same = alone.code == together[i].code && alone.out_len == together[i].out_len &&
                       !memcmp(alone.out, together[i].out, alone.out_len);
            printf("%-8s exit %d/%d stdout %zu/%zu bytes: %s\n", cmds[i][0], together[i].code, alone.code,
                   together[i].out_len, alone.out_len, same ? "same together as alone" : "DIFFERS");
            bad |= !same;
        }
        return bad;
    }
    if (argc >= 4 && !strcmp(argv[1], "repeat")) {
        /* The same run N times in a row: memory and open files must not grow. */
        int n = atoi(argv[2]);
        long rss0 = 0, rss1 = 0;
        int fds0 = 0, fds1 = 0, failed = 0, last_code = 0;
        for (int i = 0; i < n; i++) {
            result r;
            init(&r, 1);
            if (ce_run("rep", argv[3], argc - 4, (const char *const *)argv + 4, on_line, on_exit_run, &r))
                return 2;
            wait_for(&r);
            free(r.out);
            failed += r.code != 0;
            last_code = r.code;
            if (i == 4 || i == n - 1) {
                long pages = 0, resident = 0;
                FILE *f = fopen("/proc/self/statm", "r");
                if (f) {
                    if (fscanf(f, "%ld %ld", &pages, &resident) != 2)
                        resident = 0;
                    fclose(f);
                }
                int fds = 0;
                for (int fd = 0; fd < 4096; fd++)
                    if (fcntl(fd, F_GETFD) != -1)
                        fds++;
                if (i == 4) {
                    rss0 = resident * 4;
                    fds0 = fds;
                } else {
                    rss1 = resident * 4;
                    fds1 = fds;
                }
            }
        }
        printf("%d runs (%d failed, last exit %d): resident %ld KB after 5, %ld KB after %d; open files %d then %d\n",
               n, failed, last_code, rss0, rss1, n, fds0, fds1);
        return fds1 > fds0 || rss1 > rss0 + 16384;
    }
    fprintf(stderr, "usage: ce-cli run|cancel MS|parallel N|batch FILE|repeat N TOOL ARGS...\n");
    return 2;
}
