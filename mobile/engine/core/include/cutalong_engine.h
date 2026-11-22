/*
 * Cutalong's engines in-process: ffmpeg 6.0, ffprobe and whisper.cpp's
 * whisper-cli, each run on its own thread with the arguments its
 * command-line tool takes, its own stdout and stderr, and its own exit code.
 * Runs can overlap. The iOS and Android plugins are thin layers over this.
 */
#ifndef CUTALONG_ENGINE_H
#define CUTALONG_ENGINE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* The library is built with hidden symbols; only these are exported. */
#if defined(__GNUC__) || defined(__clang__)
#define CE_EXPORT __attribute__((visibility("default")))
#else
#define CE_EXPORT
#endif

enum {
    CE_STDOUT = 0,
    CE_STDERR = 1
};

/* Exit code of a cancelled run, as the contract and ffmpeg's own Ctrl-C give. */
#define CE_CANCELLED 255

/*
 * One line a run printed, without its line ending, NUL-terminated. Called
 * on whichever thread printed it, in order for each run and stream.
 */
typedef void (*ce_line_fn)(void *user, const char *id, int stream,
                           const char *line, size_t len);

/*
 * The run has ended: its exit code, all it wrote to stdout and the last
 * 64 KB it wrote to stderr. Called once, after every line, on the run's
 * thread; the buffers are freed when it returns.
 */
typedef void (*ce_exit_fn)(void *user, const char *id, int code,
                           const char *out, size_t out_len,
                           const char *err, size_t err_len);

/*
 * Starts `tool` ("ffmpeg", "ffprobe" or "whisper") with `args`, as on the
 * command line without the program's name. Returns 0 when the run started,
 * CE_ERR_BUSY when a run with this id is still going, CE_ERR_TOOL for an
 * unknown tool and CE_ERR_THREAD when no thread could be started.
 */
CE_EXPORT int ce_run(const char *id, const char *tool, int argc, const char *const *args,
           ce_line_fn on_line, ce_exit_fn on_exit, void *user);

#define CE_ERR_BUSY   (-1)
#define CE_ERR_TOOL   (-2)
#define CE_ERR_THREAD (-3)

/* Asks the run to stop; it ends with CE_CANCELLED. Returns 1 if it was running. */
CE_EXPORT int ce_cancel(const char *id);

/* How many runs are going. */
CE_EXPORT int ce_running(void);

/* "6.0" */
CE_EXPORT const char *ce_ffmpeg_version(void);
/* "1.8.2" */
CE_EXPORT const char *ce_whisper_version(void);

/* The video encoders compiled into ffmpeg, comma-separated. Free with ce_free. */
CE_EXPORT char *ce_video_encoders(void);
CE_EXPORT void ce_free(void *p);

/* Android: hands ffmpeg the JavaVM, which its MediaCodec encoders need. */
CE_EXPORT void ce_set_java_vm(void *vm);

#ifdef __cplusplus
}
#endif

#endif
