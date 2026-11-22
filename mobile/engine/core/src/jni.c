/*
 * Android's way in: app.cutalong.engine.EngineNative, whose static native
 * methods start and cancel runs and whose Listener hears their lines and
 * their end. Lines and the end arrive on the engine's own threads, which
 * are attached to the VM while they call Java and detached when they end.
 *
 * Strings cross by hand in both directions: JNI's "modified UTF-8" would
 * turn an emoji in a file name into bytes no file has, and it aborts the
 * app on the invalid UTF-8 a tool can print (whisper writes tokens that
 * split a character).
 */
#include <jni.h>
#include <pthread.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "cutalong_engine.h"

static JavaVM *g_vm;
static jmethodID g_on_line;
static jmethodID g_on_exit;
static pthread_key_t g_detach_key;

typedef struct {
    jobject listener;
} java_run;

static void detach_thread(void *unused)
{
    (void)unused;
    (*g_vm)->DetachCurrentThread(g_vm);
}

static JNIEnv *thread_env(void)
{
    JNIEnv *env = NULL;
    if ((*g_vm)->GetEnv(g_vm, (void **)&env, JNI_VERSION_1_6) == JNI_OK)
        return env;
    if ((*g_vm)->AttachCurrentThread(g_vm, &env, NULL) != JNI_OK)
        return NULL;
    pthread_setspecific(g_detach_key, env);
    return env;
}

/* UTF-8 to a Java string; anything that is not UTF-8 becomes U+FFFD. */
static jstring new_string(JNIEnv *env, const char *s, size_t len)
{
    const unsigned char *p = (const unsigned char *)s;
    jchar stack[512];
    jchar *u = len <= 512 ? stack : malloc(len * sizeof(jchar));
    size_t n = 0, i = 0;
    jstring out;

    if (!u)
        return (*env)->NewStringUTF(env, "");
    while (i < len) {
        uint32_t c = p[i];
        size_t extra;
        uint32_t min;
        if (c < 0x80) {
            u[n++] = (jchar)c;
            i++;
            continue;
        } else if ((c & 0xE0) == 0xC0) {
            extra = 1; min = 0x80; c &= 0x1F;
        } else if ((c & 0xF0) == 0xE0) {
            extra = 2; min = 0x800; c &= 0x0F;
        } else if ((c & 0xF8) == 0xF0) {
            extra = 3; min = 0x10000; c &= 0x07;
        } else {
            u[n++] = 0xFFFD;
            i++;
            continue;
        }
        size_t k;
        for (k = 1; k <= extra; k++) {
            if (i + k >= len || (p[i + k] & 0xC0) != 0x80)
                break;
            c = (c << 6) | (p[i + k] & 0x3F);
        }
        if (k <= extra || c < min || c > 0x10FFFF || (c >= 0xD800 && c <= 0xDFFF)) {
            u[n++] = 0xFFFD;
            i++;
            continue;
        }
        i += extra + 1;
        if (c >= 0x10000) {
            /* Four bytes make two units, so `len` units always suffice. */
            c -= 0x10000;
            u[n++] = (jchar)(0xD800 + (c >> 10));
            u[n++] = (jchar)(0xDC00 + (c & 0x3FF));
        } else {
            u[n++] = (jchar)c;
        }
    }
    out = (*env)->NewString(env, u, (jsize)n);
    if (u != stack)
        free(u);
    return out;
}

/* A Java string as UTF-8, surrogate pairs and all. */
static char *utf8_of(JNIEnv *env, jstring str)
{
    const jchar *u;
    jsize n;
    char *s, *o;
    if (!str)
        return strdup("");
    n = (*env)->GetStringLength(env, str);
    u = (*env)->GetStringChars(env, str, NULL);
    if (!u)
        return NULL;
    s = malloc((size_t)n * 3 + 1);
    if (!s) {
        (*env)->ReleaseStringChars(env, str, u);
        return NULL;
    }
    o = s;
    for (jsize i = 0; i < n; i++) {
        uint32_t c = u[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF) {
            c = 0x10000 + ((c - 0xD800) << 10) + (u[i + 1] - 0xDC00);
            i++;
        } else if (c >= 0xD800 && c <= 0xDFFF) {
            c = 0xFFFD;
        }
        if (c < 0x80) {
            *o++ = (char)c;
        } else if (c < 0x800) {
            *o++ = (char)(0xC0 | (c >> 6));
            *o++ = (char)(0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            *o++ = (char)(0xE0 | (c >> 12));
            *o++ = (char)(0x80 | ((c >> 6) & 0x3F));
            *o++ = (char)(0x80 | (c & 0x3F));
        } else {
            *o++ = (char)(0xF0 | (c >> 18));
            *o++ = (char)(0x80 | ((c >> 12) & 0x3F));
            *o++ = (char)(0x80 | ((c >> 6) & 0x3F));
            *o++ = (char)(0x80 | (c & 0x3F));
        }
    }
    *o = 0;
    (*env)->ReleaseStringChars(env, str, u);
    return s;
}

static void clear_exception(JNIEnv *env)
{
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionDescribe(env);
        (*env)->ExceptionClear(env);
    }
}

static void on_line(void *user, const char *id, int stream, const char *line, size_t len)
{
    java_run *jr = user;
    JNIEnv *env = thread_env();
    jstring jid, jline;
    if (!env)
        return;
    jid = new_string(env, id, strlen(id));
    jline = new_string(env, line, len);
    (*env)->CallVoidMethod(env, jr->listener, g_on_line, jid, (jint)stream, jline);
    clear_exception(env);
    (*env)->DeleteLocalRef(env, jid);
    (*env)->DeleteLocalRef(env, jline);
}

static void on_exit_run(void *user, const char *id, int code, const char *out, size_t out_len,
                        const char *err, size_t err_len)
{
    java_run *jr = user;
    JNIEnv *env = thread_env();
    if (env) {
        jstring jid = new_string(env, id, strlen(id));
        jstring jout = new_string(env, out, out_len);
        jstring jerr = new_string(env, err, err_len);
        (*env)->CallVoidMethod(env, jr->listener, g_on_exit, jid, (jint)code, jout, jerr);
        clear_exception(env);
        (*env)->DeleteLocalRef(env, jid);
        (*env)->DeleteLocalRef(env, jout);
        (*env)->DeleteLocalRef(env, jerr);
        (*env)->DeleteGlobalRef(env, jr->listener);
    }
    free(jr);
}

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved)
{
    JNIEnv *env;
    jclass listener;
    (void)reserved;
    g_vm = vm;
    if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK)
        return JNI_ERR;
    if (pthread_key_create(&g_detach_key, detach_thread))
        return JNI_ERR;
    listener = (*env)->FindClass(env, "app/cutalong/engine/EngineNative$Listener");
    if (!listener)
        return JNI_ERR;
    g_on_line = (*env)->GetMethodID(env, listener, "onLine", "(Ljava/lang/String;ILjava/lang/String;)V");
    g_on_exit = (*env)->GetMethodID(env, listener, "onExit",
                                    "(Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;)V");
    if (!g_on_line || !g_on_exit)
        return JNI_ERR;
    ce_set_java_vm(vm);
    return JNI_VERSION_1_6;
}

JNIEXPORT jint JNICALL Java_app_cutalong_engine_EngineNative_run(JNIEnv *env, jclass cls, jstring id,
                                                                 jstring tool, jobjectArray args,
                                                                 jobject listener)
{
    jsize n = args ? (*env)->GetArrayLength(env, args) : 0;
    char **argv = calloc((size_t)n + 1, sizeof(char *));
    char *cid = utf8_of(env, id);
    char *ctool = utf8_of(env, tool);
    java_run *jr = malloc(sizeof(*jr));
    int rc = CE_ERR_THREAD;
    (void)cls;

    if (argv && cid && ctool && jr) {
        int ok = 1;
        for (jsize i = 0; i < n && ok; i++) {
            jstring a = (*env)->GetObjectArrayElement(env, args, i);
            argv[i] = utf8_of(env, a);
            ok = argv[i] != NULL;
            (*env)->DeleteLocalRef(env, a);
        }
        if (ok) {
            jr->listener = (*env)->NewGlobalRef(env, listener);
            rc = ce_run(cid, ctool, (int)n, (const char *const *)argv, on_line, on_exit_run, jr);
            if (rc) {
                (*env)->DeleteGlobalRef(env, jr->listener);
                free(jr);
            }
            jr = NULL;
        }
    }
    free(jr);
    if (argv)
        for (jsize i = 0; i < n; i++)
            free(argv[i]);
    free(argv);
    free(cid);
    free(ctool);
    return rc;
}

JNIEXPORT jboolean JNICALL Java_app_cutalong_engine_EngineNative_cancel(JNIEnv *env, jclass cls, jstring id)
{
    char *cid = utf8_of(env, id);
    int found = cid ? ce_cancel(cid) : 0;
    (void)cls;
    free(cid);
    return found ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL Java_app_cutalong_engine_EngineNative_ffmpegVersion(JNIEnv *env, jclass cls)
{
    (void)cls;
    return (*env)->NewStringUTF(env, ce_ffmpeg_version());
}

JNIEXPORT jstring JNICALL Java_app_cutalong_engine_EngineNative_whisperVersion(JNIEnv *env, jclass cls)
{
    (void)cls;
    return (*env)->NewStringUTF(env, ce_whisper_version());
}

JNIEXPORT jstring JNICALL Java_app_cutalong_engine_EngineNative_videoEncoders(JNIEnv *env, jclass cls)
{
    char *list = ce_video_encoders();
    jstring s = (*env)->NewStringUTF(env, list ? list : "");
    (void)cls;
    ce_free(list);
    return s;
}
