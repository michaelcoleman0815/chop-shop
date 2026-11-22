package app.cutalong.engine;

/**
 * The engine library's Java side (core/src/jni.c). Runs start on threads of
 * the engine's own; their lines and their end come back through the
 * listener, on those threads.
 */
public final class EngineNative {

    static {
        System.loadLibrary("cutalong_engine");
    }

    /** What a run says, and how it ends. */
    public interface Listener {
        /** A line it printed: stream 0 is stdout, 1 is stderr. */
        void onLine(String id, int stream, String line);

        /** Its exit code (255 when cancelled), all of stdout, the last 64 KB of stderr. */
        void onExit(String id, int code, String stdout, String stderr);
    }

    public static final int BUSY = -1;
    public static final int UNKNOWN_TOOL = -2;
    public static final int NO_THREAD = -3;

    private EngineNative() {}

    /** Starts ffmpeg, ffprobe or whisper. 0 when it started, or BUSY, UNKNOWN_TOOL, NO_THREAD. */
    public static native int run(String id, String tool, String[] args, Listener listener);

    /** Asks the run to stop. True if it was running. */
    public static native boolean cancel(String id);

    public static native String ffmpegVersion();

    public static native String whisperVersion();

    /** The video encoders compiled into ffmpeg, comma-separated. */
    public static native String videoEncoders();
}
