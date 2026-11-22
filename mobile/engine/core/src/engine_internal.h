/* What the whisper-cli glue needs from the run manager. */
#ifndef CE_ENGINE_INTERNAL_H
#define CE_ENGINE_INTERNAL_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct ce_run_ctx ce_run_ctx;

/* The run this thread belongs to, or NULL. */
ce_run_ctx *ce_current_run(void);
int ce_run_cancelled(const ce_run_ctx *r);
void ce_run_write(ce_run_ctx *r, int stream, const char *buf, size_t len);
/* whisper-cli's -np: the run's whisper and ggml log lines are dropped. */
void ce_run_set_whisper_quiet(int quiet);

/* Entry points, each called on the run's own thread. */
int ffmpeg_execute(int argc, char **argv);
int ffprobe_execute(int argc, char **argv);
int ce_whisper_main(int argc, char **argv);

#ifdef __cplusplus
}
#endif

#endif
