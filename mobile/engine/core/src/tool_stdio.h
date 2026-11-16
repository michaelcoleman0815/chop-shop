/*
 * Included ahead of every ffmpeg, ffprobe and whisper-cli source the engine
 * compiles (-include tool_stdio.h), so the command-line tools behave in the
 * app as they do in a terminal, several at once:
 *
 * - what a tool prints to stdout or stderr goes to the run that printed it
 *   (core/src/engine.c keeps each run's output apart)
 * - exit() ends the run, not the app
 * - threads a tool starts belong to its run, so their output and their
 *   cancel checks find it
 * - ffmpeg's log level and log callback are the run's, not the process's
 *
 * Standard headers come first, so the names below only change the tools'
 * own code, never the declarations they rename.
 */
#ifndef CE_TOOL_STDIO_H
#define CE_TOOL_STDIO_H

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>

#ifdef __cplusplus
#include <algorithm>
#include <atomic>
#include <cfloat>
#include <cmath>
#include <codecvt>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <locale>
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <regex>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

/* whisper.h (and ggml.h) before the names below, so their declarations and
 * format attributes stay as they are; whisper-cli's calls are what change. */
#include "whisper.h"

extern "C" {
void ce_tool_whisper_log_set(ggml_log_callback callback, void *user_data);
struct whisper_context *ce_tool_whisper_init_from_file_with_params(const char *path,
                                                                  struct whisper_context_params params);
void ce_tool_whisper_free(struct whisper_context *ctx);
int ce_tool_whisper_full_parallel(struct whisper_context *ctx, struct whisper_full_params params,
                                  const float *samples, int n_samples, int n_processors);
}

extern "C" {
#endif

int ce_tool_printf(const char *fmt, ...);
int ce_tool_vprintf(const char *fmt, va_list ap);
int ce_tool_fprintf(FILE *f, const char *fmt, ...);
int ce_tool_vfprintf(FILE *f, const char *fmt, va_list ap);
int ce_tool_fputs(const char *s, FILE *f);
int ce_tool_puts(const char *s);
int ce_tool_putchar(int c);
int ce_tool_fputc(int c, FILE *f);
size_t ce_tool_fwrite(const void *ptr, size_t size, size_t n, FILE *f);
int ce_tool_fflush(FILE *f);
int ce_tool_pthread_create(pthread_t *thread, const pthread_attr_t *attr,
                           void *(*start)(void *), void *arg);

/* Whether this thread is a run's own (where exit_program can jump back). */
int ce_tool_on_run_thread(void);
/* A worker thread's failure, for the run to report. */
void ce_tool_fail_run(int code);

#ifdef __cplusplus
}
#endif

#define printf ce_tool_printf
#define vprintf ce_tool_vprintf
#define fprintf ce_tool_fprintf
#define vfprintf ce_tool_vfprintf
#define fputs ce_tool_fputs
#define puts ce_tool_puts
#define putchar ce_tool_putchar
#undef putc
#define putc ce_tool_fputc
#define fputc ce_tool_fputc
#define fwrite ce_tool_fwrite
#define fflush ce_tool_fflush
#define pthread_create ce_tool_pthread_create

#ifdef __cplusplus

/* whisper-cli: exit() unwinds to the run's entry point, the global log
 * callback becomes the run's own, every transcription can be cancelled, and
 * a model the run loaded is freed however it ends (core/src/whisper_main.cpp). */
[[noreturn]] void ce_tool_whisper_exit(int code);
#define exit(code) ce_tool_whisper_exit(code)
/* common-whisper.cpp's text-to-speech helper shells out, which iOS forbids
 * and no app can do; whisper-cli never calls it. */
int ce_tool_system(const char *command);
#define system(command) ce_tool_system(command)
#define whisper_log_set ce_tool_whisper_log_set
#define whisper_full_parallel ce_tool_whisper_full_parallel
#define whisper_init_from_file_with_params ce_tool_whisper_init_from_file_with_params
#define whisper_free ce_tool_whisper_free

#else

/* fftools: exit() is exit_program(), which jumps back to the run's entry. */
void exit_program(int ret);
#define exit(code) exit_program(code)

/* ffmpeg's log level, flags and callback per run. These rename the
 * declarations in libavutil/log.h too, which is what keeps them consistent:
 * the functions are the engine's, with the same signatures. */
#define av_log_set_level ce_tool_log_set_level
#define av_log_get_level ce_tool_log_get_level
#define av_log_set_flags ce_tool_log_set_flags
#define av_log_get_flags ce_tool_log_get_flags
#define av_log_set_callback ce_tool_log_set_callback
#define av_log_default_callback ce_tool_log_default_callback

#endif

#endif
