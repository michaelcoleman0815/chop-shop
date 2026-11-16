/*
 * The run manager. Each run is one of ffmpeg, ffprobe or whisper-cli on a
 * thread of its own, with its own copy of every global the tools keep (they
 * are thread-local), its own stdout and stderr, and its own exit code.
 *
 * Output reaches a run three ways:
 * - printf, fprintf(stderr, ...) and friends in the tools' sources, renamed
 *   by tool_stdio.h to the ce_tool_* functions here;
 * - ffmpeg's log (av_log) and whisper's (whisper_log_set), routed here;
 * - ffmpeg writing to its stdout as a file: "-progress pipe:1" and output
 *   files "-" or "pipe:1" are pointed at a pipe of the run's own, read back
 *   on a thread.
 * A thread the run started itself carries the run with it. Output from a
 * thread nobody started for a run (a codec's worker, Metal's queue) is
 * given to the run that is going when only one is, and dropped otherwise.
 *
 * Nothing here is compiled with tool_stdio.h, so the real printf, exit and
 * pthread_create are the ones called.
 */
#include "cutalong_engine.h"
#include "engine_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "libavcodec/avcodec.h"
#include "libavutil/avutil.h"
#include "libavutil/log.h"
#ifdef __ANDROID__
#include "libavcodec/jni.h"
#endif
#include "whisper.h"

/* All of stdout is kept, up to this; past it the rest is counted, not kept. */
#define STDOUT_MAX ((size_t)64 << 20)
/* The contract's stderr tail. */
#define STDERR_KEEP ((size_t)64 << 10)
/* A line longer than this goes out in pieces. */
#define LINE_MAX_BYTES ((size_t)16 << 10)
#define LOG_LINE 4096
/* A run's thread gets a main thread's stack: the tools were written for one. */
#define RUN_STACK ((size_t)8 << 20)

enum { TOOL_FFMPEG, TOOL_FFPROBE, TOOL_WHISPER };

typedef struct {
    char *data;
    size_t len, cap;
    int after_cr;
} line_buf;

struct ce_run_ctx {
    char *id;
    long session;
    int tool;
    int argc;
    char **argv;
    ce_line_fn on_line;
    ce_exit_fn on_exit;
    void *user;
    atomic_int cancelled;
    atomic_int worker_failed;

    pthread_mutex_t lock; /* the buffers and line state below */
    char *out;
    size_t out_len, out_cap, out_dropped;
    char *err;
    size_t err_len, err_cap;
    int err_cut;
    line_buf lines[2];

    /* ffmpeg's log, as this run set it with -loglevel */
    int log_level, log_flags;
    void (*log_cb)(void *, int, const char *, va_list);
    int print_prefix;
    char prev[LOG_LINE];
    int repeats;
    int whisper_quiet;

    /* ffmpeg's own stdout, read back from a pipe */
    int pipe_r, pipe_w;
    pthread_t pipe_thread;
    int has_pipe;
    atomic_int pipe_done;

    struct ce_run_ctx *next;
};

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER; /* g_runs, g_count, g_next_session */
static ce_run_ctx *g_runs;
static int g_count;
static long g_next_session = 1;
static pthread_once_t g_once = PTHREAD_ONCE_INIT;

static __thread ce_run_ctx *t_run;
static __thread int t_run_main;

/* What ffmpeg-kit's fftools expect from their host. */
__thread long globalSessionId;
__thread jmp_buf ex_buf__;
/* Signals are the app's: fftools never install a handler. */
volatile int handleSIGQUIT = 0;
volatile int handleSIGINT = 0;
volatile int handleSIGTERM = 0;
volatile int handleSIGXCPU = 0;
volatile int handleSIGPIPE = 0;

/* ------------------------------------------------------------------ */
/* Which run a thread's output belongs to */

/*
 * The run this thread belongs to. A thread no run started gets the one run
 * that is going, if only one is; g_lock is then held until release_run, so
 * the run cannot end while its output is written.
 */
static ce_run_ctx *acquire_run(int *locked)
{
    *locked = 0;
    if (t_run)
        return t_run;
    pthread_mutex_lock(&g_lock);
    if (g_count == 1 && g_runs) {
        *locked = 1;
        return g_runs;
    }
    pthread_mutex_unlock(&g_lock);
    return NULL;
}

static void release_run(int locked)
{
    if (locked)
        pthread_mutex_unlock(&g_lock);
}

ce_run_ctx *ce_current_run(void)
{
    return t_run;
}

int ce_run_cancelled(const ce_run_ctx *r)
{
    return r ? atomic_load(&((ce_run_ctx *)r)->cancelled) : 0;
}

int cancelRequested(long session)
{
    ce_run_ctx *r = t_run;
    int cancelled = 0;
    if (r && r->session == session)
        return atomic_load(&r->cancelled);
    if (!session)
        return 0;
    pthread_mutex_lock(&g_lock);
    for (r = g_runs; r; r = r->next) {
        if (r->session == session) {
            cancelled = atomic_load(&r->cancelled);
            break;
        }
    }
    pthread_mutex_unlock(&g_lock);
    return cancelled;
}

void cancelSession(long session)
{
    pthread_mutex_lock(&g_lock);
    for (ce_run_ctx *r = g_runs; r; r = r->next)
        if (r->session == session)
            atomic_store(&r->cancelled, 1);
    pthread_mutex_unlock(&g_lock);
}

int ce_tool_on_run_thread(void)
{
    return t_run != NULL && t_run_main;
}

void ce_tool_fail_run(int code)
{
    if (t_run)
        atomic_store(&t_run->worker_failed, code ? code : 1);
}

/* ------------------------------------------------------------------ */
/* Keeping what a run writes, and handing it on line by line */

static void emit_line(ce_run_ctx *r, int stream, line_buf *b)
{
    b->data[b->len] = 0;
    if (r->on_line)
        r->on_line(r->user, r->id, stream, b->data, b->len);
    b->len = 0;
}

static void push_lines(ce_run_ctx *r, int stream, const char *buf, size_t len)
{
    line_buf *b = &r->lines[stream];
    for (size_t i = 0; i < len; i++) {
        char c = buf[i];
        if (c == '\n') {
            /* "\r\n": the line went out at the "\r" */
            if (b->after_cr && b->len == 0) {
                b->after_cr = 0;
                continue;
            }
            b->after_cr = 0;
            if (!b->data && !(b->data = malloc(b->cap = 256)))
                return;
            emit_line(r, stream, b);
            continue;
        }
        if (c == '\r') {
            /* ffmpeg's stats line returns to its start with "\r": each one is a line */
            if (b->len)
                emit_line(r, stream, b);
            b->after_cr = 1;
            continue;
        }
        b->after_cr = 0;
        if (b->len + 1 >= b->cap) {
            if (b->cap >= LINE_MAX_BYTES) {
                emit_line(r, stream, b);
            } else {
                size_t cap = b->cap ? b->cap * 2 : 256;
                char *data = realloc(b->data, cap);
                if (!data)
                    return;
                b->data = data;
                b->cap = cap;
            }
        }
        b->data[b->len++] = c;
    }
}

static void flush_line(ce_run_ctx *r, int stream)
{
    line_buf *b = &r->lines[stream];
    if (b->len)
        emit_line(r, stream, b);
}

static void keep_out(ce_run_ctx *r, const char *buf, size_t len)
{
    if (r->out_dropped || r->out_len + len > STDOUT_MAX) {
        r->out_dropped += len;
        return;
    }
    if (r->out_len + len + 1 > r->out_cap) {
        size_t cap = r->out_cap ? r->out_cap : 4096;
        while (cap < r->out_len + len + 1)
            cap *= 2;
        char *out = realloc(r->out, cap);
        if (!out) {
            r->out_dropped += len;
            return;
        }
        r->out = out;
        r->out_cap = cap;
    }
    memcpy(r->out + r->out_len, buf, len);
    r->out_len += len;
    r->out[r->out_len] = 0;
}

static void keep_err(ce_run_ctx *r, const char *buf, size_t len)
{
    if (!r->err) {
        if (!(r->err = malloc(2 * STDERR_KEEP)))
            return;
        r->err_cap = 2 * STDERR_KEEP;
    }
    if (len >= STDERR_KEEP) {
        buf += len - STDERR_KEEP;
        len = STDERR_KEEP;
        r->err_len = 0;
        r->err_cut = 1;
    }
    if (r->err_len + len > r->err_cap) {
        size_t keep = STDERR_KEEP - len;
        if (keep > r->err_len)
            keep = r->err_len;
        memmove(r->err, r->err + r->err_len - keep, keep);
        r->err_len = keep;
        r->err_cut = 1;
    }
    memcpy(r->err + r->err_len, buf, len);
    r->err_len += len;
}

static void write_locked(ce_run_ctx *r, int stream, const char *buf, size_t len)
{
    if (stream == CE_STDOUT)
        keep_out(r, buf, len);
    else
        keep_err(r, buf, len);
    push_lines(r, stream, buf, len);
}

void ce_run_write(ce_run_ctx *r, int stream, const char *buf, size_t len)
{
    if (!r || !len)
        return;
    pthread_mutex_lock(&r->lock);
    write_locked(r, stream, buf, len);
    pthread_mutex_unlock(&r->lock);
}

/* The last 64 KB of stderr, starting on a line (or at least a character). */
static const char *err_tail(ce_run_ctx *r, size_t *len)
{
    const char *s = r->err ? r->err : "";
    size_t n = r->err_len;
    int cut = r->err_cut;
    if (n > STDERR_KEEP) {
        s += n - STDERR_KEEP;
        n = STDERR_KEEP;
        cut = 1;
    }
    if (cut && n) {
        const char *nl = memchr(s, '\n', n < 4096 ? n : 4096);
        if (nl) {
            n -= (size_t)(nl + 1 - s);
            s = nl + 1;
        } else {
            while (n && ((unsigned char)*s & 0xC0) == 0x80) {
                s++;
                n--;
            }
        }
    }
    *len = n;
    return s;
}

/* ------------------------------------------------------------------ */
/* stdio, as the tools' sources call it (tool_stdio.h) */

static int vwrite_stream(int stream, const char *fmt, va_list ap)
{
    int locked;
    ce_run_ctx *r = acquire_run(&locked);
    char small[1024];
    va_list again;
    int n;

    if (!r)
        return vfprintf(stream == CE_STDOUT ? stdout : stderr, fmt, ap);
    va_copy(again, ap);
    n = vsnprintf(small, sizeof(small), fmt, ap);
    if (n >= 0 && (size_t)n < sizeof(small)) {
        ce_run_write(r, stream, small, (size_t)n);
    } else if (n > 0) {
        char *big = malloc((size_t)n + 1);
        if (big) {
            vsnprintf(big, (size_t)n + 1, fmt, again);
            ce_run_write(r, stream, big, (size_t)n);
            free(big);
        }
    }
    va_end(again);
    release_run(locked);
    return n;
}

static int write_stream(int stream, const void *buf, size_t len)
{
    int locked;
    ce_run_ctx *r = acquire_run(&locked);
    if (!r) {
        fwrite(buf, 1, len, stream == CE_STDOUT ? stdout : stderr);
        return (int)len;
    }
    ce_run_write(r, stream, buf, len);
    release_run(locked);
    return (int)len;
}

static int stream_of(FILE *f)
{
    if (f == stdout)
        return CE_STDOUT;
    if (f == stderr)
        return CE_STDERR;
    return -1;
}

int ce_tool_vfprintf(FILE *f, const char *fmt, va_list ap)
{
    int s = stream_of(f);
    return s < 0 ? vfprintf(f, fmt, ap) : vwrite_stream(s, fmt, ap);
}

int ce_tool_fprintf(FILE *f, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int n = ce_tool_vfprintf(f, fmt, ap);
    va_end(ap);
    return n;
}

int ce_tool_vprintf(const char *fmt, va_list ap)
{
    return vwrite_stream(CE_STDOUT, fmt, ap);
}

int ce_tool_printf(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int n = vwrite_stream(CE_STDOUT, fmt, ap);
    va_end(ap);
    return n;
}

int ce_tool_fputs(const char *s, FILE *f)
{
    int st = stream_of(f);
    if (st < 0)
        return fputs(s, f);
    write_stream(st, s, strlen(s));
    return 0;
}

int ce_tool_puts(const char *s)
{
    write_stream(CE_STDOUT, s, strlen(s));
    write_stream(CE_STDOUT, "\n", 1);
    return 0;
}

int ce_tool_fputc(int c, FILE *f)
{
    int st = stream_of(f);
    char ch = (char)c;
    if (st < 0)
        return fputc(c, f);
    write_stream(st, &ch, 1);
    return (unsigned char)c;
}

int ce_tool_putchar(int c)
{
    return ce_tool_fputc(c, stdout);
}

size_t ce_tool_fwrite(const void *ptr, size_t size, size_t n, FILE *f)
{
    int st = stream_of(f);
    if (st < 0)
        return fwrite(ptr, size, n, f);
    write_stream(st, ptr, size * n);
    return n;
}

int ce_tool_fflush(FILE *f)
{
    return stream_of(f) < 0 ? fflush(f) : 0;
}

/* Threads a tool starts carry its run, so their output and cancel checks find it. */
typedef struct {
    void *(*start)(void *);
    void *arg;
    ce_run_ctx *run;
    long session;
} thread_start;

static void *start_with_run(void *p)
{
    thread_start t = *(thread_start *)p;
    free(p);
    t_run = t.run;
    t_run_main = 0;
    globalSessionId = t.session;
    return t.start(t.arg);
}

int ce_tool_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                           void *(*start)(void *), void *arg)
{
    thread_start *t = malloc(sizeof(*t));
    int ret;
    if (!t)
        return ENOMEM;
    t->start = start;
    t->arg = arg;
    t->run = t_run;
    t->session = globalSessionId;
    ret = pthread_create(thread, attr, start_with_run, t);
    if (ret)
        free(t);
    return ret;
}

/* ------------------------------------------------------------------ */
/* ffmpeg's log, per run (tool_stdio.h renames av_log_set_level and the rest) */

static void log_to_run(ce_run_ctx *r, void *avcl, int level, const char *fmt, va_list vl)
{
    char line[LOG_LINE];
    int at_start;
    size_t n;

    if (level >= 0)
        level &= 0xff; /* a colour tint rides in the upper bits */
    if (level > r->log_level)
        return;
    pthread_mutex_lock(&r->lock);
    at_start = r->print_prefix;
    av_log_format_line2(avcl, level, fmt, vl, line, sizeof(line), &r->print_prefix);
    n = strlen(line);
    /* As ffmpeg's own callback does with AV_LOG_SKIP_REPEATED. */
    if (at_start && (r->log_flags & AV_LOG_SKIP_REPEATED) && n &&
        line[n - 1] != '\r' && !strcmp(line, r->prev)) {
        r->repeats++;
        pthread_mutex_unlock(&r->lock);
        return;
    }
    if (r->repeats > 0) {
        char said[64];
        int k = snprintf(said, sizeof(said), "    Last message repeated %d times\n", r->repeats);
        write_locked(r, CE_STDERR, said, (size_t)k);
        r->repeats = 0;
    }
    memcpy(r->prev, line, n + 1);
    write_locked(r, CE_STDERR, line, n);
    pthread_mutex_unlock(&r->lock);
}

void ce_tool_log_default_callback(void *avcl, int level, const char *fmt, va_list vl)
{
    int locked;
    ce_run_ctx *r = acquire_run(&locked);
    if (r)
        log_to_run(r, avcl, level, fmt, vl);
    release_run(locked);
}

static void av_log_router(void *avcl, int level, const char *fmt, va_list vl)
{
    int locked;
    ce_run_ctx *r = acquire_run(&locked);
    if (r) {
        /* A callback the tool set (help text, -report, ffprobe's -show_log), on its own threads. */
        if (r->log_cb && t_run == r)
            r->log_cb(avcl, level, fmt, vl);
        else
            log_to_run(r, avcl, level, fmt, vl);
    }
    release_run(locked);
}

void ce_tool_log_set_level(int level)
{
    if (t_run)
        t_run->log_level = level;
}

int ce_tool_log_get_level(void)
{
    return t_run ? t_run->log_level : av_log_get_level();
}

void ce_tool_log_set_flags(int flags)
{
    if (t_run)
        t_run->log_flags = flags;
}

int ce_tool_log_get_flags(void)
{
    return t_run ? t_run->log_flags : av_log_get_flags();
}

void ce_tool_log_set_callback(void (*callback)(void *, int, const char *, va_list))
{
    if (t_run)
        t_run->log_cb = callback == ce_tool_log_default_callback ? NULL : callback;
}

/* whisper.cpp's and ggml's log: whisper-cli prints it to stderr, and so does a run. */
static void whisper_log_router(enum ggml_log_level level, const char *text, void *user)
{
    int locked;
    ce_run_ctx *r;
    (void)user;
    if (level == GGML_LOG_LEVEL_DEBUG || !text)
        return;
    r = acquire_run(&locked);
    if (r && !r->whisper_quiet)
        ce_run_write(r, CE_STDERR, text, strlen(text));
    release_run(locked);
}

void ce_run_set_whisper_quiet(int quiet)
{
    if (t_run)
        t_run->whisper_quiet = quiet;
}

static void engine_init(void)
{
    av_log_set_callback(av_log_router);
    whisper_log_set(whisper_log_router, NULL);
}

/* ------------------------------------------------------------------ */
/* Runs */

static int names_stdout(const char *arg)
{
    return !strcmp(arg, "pipe:1") || !strcmp(arg, "pipe:") ||
           !strcmp(arg, "/dev/stdout") || !strcmp(arg, "-");
}

/*
 * ffmpeg writes "-progress pipe:1" and an output named "-" or "pipe:1" to
 * the process's stdout, which in an app is nobody's. They are pointed at a
 * pipe of this run's own instead, read back as the run's stdout.
 */
static void route_ffmpeg_stdout(ce_run_ctx *r)
{
    int fds[2];
    int wanted = 0;
    for (int i = 1; i < r->argc; i++)
        if (strcmp(r->argv[i - 1], "-i") && names_stdout(r->argv[i]))
            wanted = 1;
    if (!wanted || pipe(fds))
        return;
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[1], F_SETFD, FD_CLOEXEC);
    fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK);
    r->pipe_r = fds[0];
    r->pipe_w = fds[1];
    r->has_pipe = 1;
    for (int i = 1; i < r->argc; i++) {
        if (!strcmp(r->argv[i - 1], "-i") || !names_stdout(r->argv[i]))
            continue;
        char url[32];
        snprintf(url, sizeof(url), "pipe:%d", fds[1]);
        free(r->argv[i]);
        r->argv[i] = strdup(url);
    }
}

/*
 * Reads the run's stdout pipe until the run has returned and the pipe is
 * empty. It does not wait for end-of-file: a writer ffmpeg leaves open on a
 * failure (the command line relies on the process ending) would hold it
 * open, and once ffmpeg has returned nothing more can be written anyway.
 */
static void *read_pipe(void *arg)
{
    ce_run_ctx *r = arg;
    char buf[16384];
    for (;;) {
        struct pollfd p = {r->pipe_r, POLLIN, 0};
        int done = atomic_load(&r->pipe_done);
        int n = poll(&p, 1, done ? 0 : 100);
        if (n > 0) {
            ssize_t got = read(r->pipe_r, buf, sizeof(buf));
            if (got > 0) {
                ce_run_write(r, CE_STDOUT, buf, (size_t)got);
                continue;
            }
            if (got < 0 && (errno == EINTR || errno == EAGAIN))
                continue;
            break; /* end of file */
        }
        if (n < 0 && errno == EINTR)
            continue;
        if (done || n < 0)
            break;
    }
    return NULL;
}

static void free_run(ce_run_ctx *r)
{
    for (int i = 0; i < r->argc; i++)
        free(r->argv[i]);
    free(r->argv);
    free(r->lines[0].data);
    free(r->lines[1].data);
    free(r->out);
    free(r->err);
    free(r->id);
    pthread_mutex_destroy(&r->lock);
    free(r);
}

static void unlink_run(ce_run_ctx *r)
{
    pthread_mutex_lock(&g_lock);
    for (ce_run_ctx **p = &g_runs; *p; p = &(*p)->next) {
        if (*p == r) {
            *p = r->next;
            g_count--;
            break;
        }
    }
    pthread_mutex_unlock(&g_lock);
}

static void finish(ce_run_ctx *r, int code)
{
    const char *tail;
    size_t tail_len;

    pthread_mutex_lock(&r->lock);
    if (r->out_dropped) {
        char said[160];
        int k = snprintf(said, sizeof(said),
                         "\n[engine] stdout ran past %zu MB; the last %zu bytes were not kept\n",
                         STDOUT_MAX >> 20, r->out_dropped);
        write_locked(r, CE_STDERR, said, (size_t)k);
    }
    flush_line(r, CE_STDOUT);
    flush_line(r, CE_STDERR);
    pthread_mutex_unlock(&r->lock);

    /* Out of the list before it is reported, so its id is free again at once. */
    unlink_run(r);
    tail = err_tail(r, &tail_len);
    if (r->on_exit)
        r->on_exit(r->user, r->id, code, r->out ? r->out : "", r->out_len, tail, tail_len);
    free_run(r);
}

static void *run_main(void *arg)
{
    ce_run_ctx *r = arg;
    int code = 1;

    t_run = r;
    t_run_main = 1;
    globalSessionId = r->session;

    if (r->has_pipe && pthread_create(&r->pipe_thread, NULL, read_pipe, r)) {
        close(r->pipe_r);
        close(r->pipe_w);
        r->has_pipe = 0;
    }

    switch (r->tool) {
    case TOOL_FFMPEG:
        code = ffmpeg_execute(r->argc, r->argv);
        break;
    case TOOL_FFPROBE:
        code = ffprobe_execute(r->argc, r->argv);
        break;
    case TOOL_WHISPER:
        code = ce_whisper_main(r->argc, r->argv);
        break;
    }

    if (r->has_pipe) {
        close(r->pipe_w);
        atomic_store(&r->pipe_done, 1);
        pthread_join(r->pipe_thread, NULL);
        close(r->pipe_r);
    }
    if (!code && atomic_load(&r->worker_failed))
        code = atomic_load(&r->worker_failed);
    if (atomic_load(&r->cancelled))
        code = CE_CANCELLED;

    finish(r, code);
    t_run = NULL;
    t_run_main = 0;
    return NULL;
}

int ce_run(const char *id, const char *tool, int argc, const char *const *args,
           ce_line_fn on_line, ce_exit_fn on_exit, void *user)
{
    ce_run_ctx *r;
    const char *program;
    int kind;
    pthread_attr_t attr;
    pthread_t thread;

    pthread_once(&g_once, engine_init);

    if (!strcmp(tool, "ffmpeg")) {
        kind = TOOL_FFMPEG;
        program = "ffmpeg";
    } else if (!strcmp(tool, "ffprobe")) {
        kind = TOOL_FFPROBE;
        program = "ffprobe";
    } else if (!strcmp(tool, "whisper")) {
        kind = TOOL_WHISPER;
        program = "whisper-cli";
    } else {
        return CE_ERR_TOOL;
    }

    if (!(r = calloc(1, sizeof(*r))))
        return CE_ERR_THREAD;
    r->id = strdup(id);
    r->tool = kind;
    r->on_line = on_line;
    r->on_exit = on_exit;
    r->user = user;
    r->log_level = AV_LOG_INFO;
    r->print_prefix = 1;
    r->pipe_r = r->pipe_w = -1;
    atomic_init(&r->cancelled, 0);
    atomic_init(&r->worker_failed, 0);
    atomic_init(&r->pipe_done, 0);
    pthread_mutex_init(&r->lock, NULL);
    r->argc = argc + 1;
    r->argv = calloc((size_t)argc + 2, sizeof(char *));
    if (!r->id || !r->argv) {
        r->argc = 0;
        free_run(r);
        return CE_ERR_THREAD;
    }
    r->argv[0] = strdup(program);
    for (int i = 0; i < argc; i++)
        r->argv[i + 1] = strdup(args[i] ? args[i] : "");

    pthread_mutex_lock(&g_lock);
    for (ce_run_ctx *x = g_runs; x; x = x->next) {
        if (!strcmp(x->id, id)) {
            pthread_mutex_unlock(&g_lock);
            free_run(r);
            return CE_ERR_BUSY;
        }
    }
    r->session = g_next_session++;
    r->next = g_runs;
    g_runs = r;
    g_count++;
    pthread_mutex_unlock(&g_lock);

    if (kind == TOOL_FFMPEG)
        route_ffmpeg_stdout(r);

    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, RUN_STACK);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&thread, &attr, run_main, r)) {
        pthread_attr_destroy(&attr);
        unlink_run(r);
        if (r->has_pipe) {
            close(r->pipe_r);
            close(r->pipe_w);
        }
        free_run(r);
        return CE_ERR_THREAD;
    }
    pthread_attr_destroy(&attr);
    return 0;
}

int ce_cancel(const char *id)
{
    int found = 0;
    pthread_mutex_lock(&g_lock);
    for (ce_run_ctx *r = g_runs; r; r = r->next) {
        if (!strcmp(r->id, id)) {
            atomic_store(&r->cancelled, 1);
            found = 1;
        }
    }
    pthread_mutex_unlock(&g_lock);
    return found;
}

int ce_running(void)
{
    int n;
    pthread_mutex_lock(&g_lock);
    n = g_count;
    pthread_mutex_unlock(&g_lock);
    return n;
}

/* ------------------------------------------------------------------ */
/* What the build has */

const char *ce_ffmpeg_version(void)
{
    return av_version_info();
}

const char *ce_whisper_version(void)
{
    return whisper_version();
}

char *ce_video_encoders(void)
{
    size_t len = 0, cap = 4096;
    char *s = malloc(cap);
    void *it = NULL;
    const AVCodec *c;
    if (!s)
        return NULL;
    s[0] = 0;
    while ((c = av_codec_iterate(&it))) {
        size_t n;
        if (!av_codec_is_encoder(c) || c->type != AVMEDIA_TYPE_VIDEO)
            continue;
        n = strlen(c->name);
        if (len + n + 2 > cap) {
            char *t;
            while (len + n + 2 > cap)
                cap *= 2;
            if (!(t = realloc(s, cap)))
                break;
            s = t;
        }
        if (len)
            s[len++] = ',';
        memcpy(s + len, c->name, n + 1);
        len += n;
    }
    return s;
}

void ce_free(void *p)
{
    free(p);
}

void ce_set_java_vm(void *vm)
{
#ifdef __ANDROID__
    av_jni_set_java_vm(vm, NULL);
#else
    (void)vm;
#endif
}
