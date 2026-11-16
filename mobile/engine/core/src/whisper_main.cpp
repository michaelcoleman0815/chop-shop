/*
 * The whisper tool: whisper.cpp's own whisper-cli (examples/cli/cli.cpp from
 * the version in scripts/versions.env), compiled unchanged with
 * -Dmain=ce_whisper_cli_main and tool_stdio.h, so it takes the same flags and
 * writes the same files as on the Mac. This file supplies what tool_stdio.h
 * renames for it:
 *
 * - exit() throws back to ce_whisper_main instead of ending the app
 * - every transcription can be cancelled (cli.cpp's own abort callbacks
 *   never fire)
 * - -np quiets only this run's log, not every run's
 * - a model the run loaded is freed even when it ends early, which the
 *   command-line tool leaves to the process exiting
 *
 * It is compiled without tool_stdio.h, so the names here are whisper.cpp's own.
 */
#include <cstdio>
#include <cstring>
#include <exception>
#include <vector>

#include "whisper.h"

#include "engine_internal.h"

extern int ce_whisper_cli_main(int argc, char **argv);

namespace {

struct whisper_exit {
    int code;
};

/* Models this thread's run loaded and has not freed. */
thread_local std::vector<whisper_context *> t_contexts;

bool abort_if_cancelled(void *run)
{
    return ce_run_cancelled(static_cast<ce_run_ctx *>(run)) != 0;
}

bool encode_unless_cancelled(whisper_context *, whisper_state *, void *run)
{
    return ce_run_cancelled(static_cast<ce_run_ctx *>(run)) == 0;
}

void say(const char *text)
{
    ce_run_write(ce_current_run(), 1, text, std::strlen(text));
}

} // namespace

[[noreturn]] void ce_tool_whisper_exit(int code)
{
    throw whisper_exit{code};
}

extern "C" void ce_tool_whisper_log_set(ggml_log_callback callback, void *)
{
    /* cli.cpp only ever sets a callback to silence the log (-np). */
    ce_run_set_whisper_quiet(callback != nullptr);
}

extern "C" struct whisper_context *ce_tool_whisper_init_from_file_with_params(
    const char *path, struct whisper_context_params params)
{
    whisper_context *ctx = whisper_init_from_file_with_params(path, params);
    if (ctx)
        t_contexts.push_back(ctx);
    return ctx;
}

extern "C" void ce_tool_whisper_free(struct whisper_context *ctx)
{
    for (auto it = t_contexts.begin(); it != t_contexts.end(); ++it) {
        if (*it == ctx) {
            t_contexts.erase(it);
            break;
        }
    }
    whisper_free(ctx);
}

extern "C" int ce_tool_whisper_full_parallel(struct whisper_context *ctx,
                                             struct whisper_full_params params,
                                             const float *samples, int n_samples,
                                             int n_processors)
{
    /* The run itself, not this thread's: ggml checks it on its own threads. */
    void *run = ce_current_run();
    params.abort_callback = abort_if_cancelled;
    params.abort_callback_user_data = run;
    params.encoder_begin_callback = encode_unless_cancelled;
    params.encoder_begin_callback_user_data = run;
    return whisper_full_parallel(ctx, params, samples, n_samples, n_processors);
}

extern "C" int ce_whisper_main(int argc, char **argv)
{
    int code;
    try {
        code = ce_whisper_cli_main(argc, argv);
    } catch (const whisper_exit &e) {
        code = e.code;
    } catch (const std::exception &e) {
        say("whisper: ");
        say(e.what());
        say("\n");
        code = 1;
    } catch (...) {
        say("whisper: stopped by an unexpected error\n");
        code = 1;
    }
    for (whisper_context *ctx : t_contexts)
        whisper_free(ctx);
    t_contexts.clear();
    return code;
}
