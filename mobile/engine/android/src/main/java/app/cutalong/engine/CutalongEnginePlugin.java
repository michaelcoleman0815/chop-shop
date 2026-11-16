package app.cutalong.engine;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.net.Uri;
import android.os.Build;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;

/**
 * Cutalong's engines on Android: ffmpeg, ffprobe and whisper in-process (see
 * src/definitions.ts for the contract), the system photo picker and the
 * document picker, and saving to the gallery.
 */
@CapacitorPlugin(
    name = "CutalongEngine",
    permissions = { @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = CutalongEnginePlugin.PHOTOS) }
)
public class CutalongEnginePlugin extends Plugin {

    static final String PHOTOS = "photos";

    /** The most one pick returns from the photo picker. */
    private static final int MAX_PICKS = 50;

    /** Copying picked files and saving to the gallery, off the main thread. */
    private final ExecutorService io = Executors.newCachedThreadPool();

    @PluginMethod
    public void run(final PluginCall call) {
        final String id = call.getString("id");
        final String tool = call.getString("tool");
        if (id == null || id.isEmpty()) {
            call.reject("A run needs an id.");
            return;
        }
        if (tool == null) {
            call.reject("A run needs a tool: ffmpeg, ffprobe or whisper.");
            return;
        }
        String[] args;
        try {
            JSArray list = call.getArray("args", new JSArray());
            args = new String[list.length()];
            for (int i = 0; i < args.length; i++) args[i] = list.getString(i);
        } catch (JSONException e) {
            call.reject("args must be a list of strings.");
            return;
        }
        int started = EngineNative.run(
            id,
            tool,
            args,
            new EngineNative.Listener() {
                @Override
                public void onLine(String runId, int stream, String line) {
                    JSObject event = new JSObject();
                    event.put("id", runId);
                    event.put("stream", stream == 0 ? "stdout" : "stderr");
                    event.put("line", line);
                    notifyListeners("line", event);
                }

                @Override
                public void onExit(String runId, int code, String stdout, String stderr) {
                    JSObject result = new JSObject();
                    result.put("code", code);
                    result.put("stdout", stdout);
                    result.put("stderr", stderr);
                    call.resolve(result);
                }
            }
        );
        if (started == EngineNative.BUSY) call.reject("A run named " + id + " is still going.", "BUSY");
        else if (started == EngineNative.UNKNOWN_TOOL) call.reject("There is no tool named " + tool + ": ffmpeg, ffprobe or whisper.", "TOOL");
        else if (started != 0) call.reject("The run could not start.", "START");
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("cancel needs the run's id.");
            return;
        }
        EngineNative.cancel(id);
        call.resolve();
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject info = new JSObject();
        info.put("platform", "android");
        info.put("documents", getContext().getFilesDir().getAbsolutePath());
        info.put("cache", getContext().getCacheDir().getAbsolutePath());
        info.put("ffmpegVersion", EngineNative.ffmpegVersion());
        info.put("whisperVersion", EngineNative.whisperVersion());
        Set<String> mediaTypes = deviceEncoderTypes();
        JSArray encoders = new JSArray();
        for (String name : EngineNative.videoEncoders().split(",")) {
            if (name.isEmpty()) continue;
            // A MediaCodec encoder is only there if the phone has one for its type, at 1080p.
            if (name.equals("h264_mediacodec") && !mediaTypes.contains("video/avc")) continue;
            if (name.equals("hevc_mediacodec") && !mediaTypes.contains("video/hevc")) continue;
            encoders.put(name);
        }
        info.put("encoders", encoders);
        call.resolve(info);
    }

    /**
     * The video types this phone has an encoder for at 1080p, either way up.
     * Some have one only for small pictures (the emulator's HEVC encoder
     * stops at 512x512), which an export cannot use.
     */
    private static Set<String> deviceEncoderTypes() {
        Set<String> types = new HashSet<>();
        for (MediaCodecInfo codec : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
            if (!codec.isEncoder()) continue;
            for (String type : codec.getSupportedTypes()) {
                try {
                    MediaCodecInfo.VideoCapabilities video = codec.getCapabilitiesForType(type).getVideoCapabilities();
                    if (video != null && (video.isSizeSupported(1920, 1080) || video.isSizeSupported(1080, 1920))) {
                        types.add(type.toLowerCase(Locale.ROOT));
                    }
                } catch (IllegalArgumentException e) {
                    // A type it cannot describe: not one to offer.
                }
            }
        }
        return types;
    }

    @PluginMethod
    public void pick(PluginCall call) {
        boolean multiple = Boolean.TRUE.equals(call.getBoolean("multiple", false));
        Set<String> kinds = new HashSet<>();
        try {
            JSArray list = call.getArray("kinds", new JSArray());
            for (int i = 0; i < list.length(); i++) kinds.add(list.getString(i));
        } catch (JSONException e) {
            call.reject("kinds must be a list of video, audio and image.");
            return;
        }
        if (kinds.isEmpty()) {
            kinds.add("video");
            kinds.add("image");
        }
        boolean videos = kinds.contains("video");
        boolean images = kinds.contains("image");
        Intent intent;
        if (kinds.contains("audio")) {
            // Sound is not in the photo picker: the document picker has it, and
            // whatever else was asked for.
            List<String> types = new ArrayList<>();
            types.add("audio/*");
            if (videos) types.add("video/*");
            if (images) types.add("image/*");
            intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType(types.size() == 1 ? types.get(0) : "*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple);
        } else {
            ActivityResultContracts.PickVisualMedia.VisualMediaType type = videos && images
                ? ActivityResultContracts.PickVisualMedia.ImageAndVideo.INSTANCE
                : videos
                    ? ActivityResultContracts.PickVisualMedia.VideoOnly.INSTANCE
                    : ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE;
            PickVisualMediaRequest request = new PickVisualMediaRequest.Builder().setMediaType(type).build();
            intent = multiple
                ? new ActivityResultContracts.PickMultipleVisualMedia(MAX_PICKS).createIntent(getContext(), request)
                : new ActivityResultContracts.PickVisualMedia().createIntent(getContext(), request);
        }
        startActivityForResult(call, intent, "picked");
    }

    @ActivityCallback
    private void picked(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        final List<Uri> uris = new ArrayList<>();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) uris.add(clip.getItemAt(i).getUri());
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        io.execute(() -> {
            JSArray files = new JSArray();
            try {
                for (Uri uri : uris) {
                    Importer.Picked p = Importer.copyIn(getContext(), uri);
                    JSObject file = new JSObject();
                    file.put("path", p.path);
                    file.put("name", p.name);
                    file.put("bytes", p.bytes);
                    files.put(file);
                }
            } catch (Exception e) {
                call.reject("Could not copy what was picked: " + e.getMessage(), "COPY", e);
                return;
            }
            JSObject out = new JSObject();
            out.put("files", files);
            call.resolve(out);
        });
    }

    @PluginMethod
    public void saveToPhotos(PluginCall call) {
        String path = call.getString("path");
        if (path == null || !new File(path).isFile()) {
            JSObject out = new JSObject();
            out.put("saved", false);
            out.put("message", "There is no file at " + path + ".");
            call.resolve(out);
            return;
        }
        if (Build.VERSION.SDK_INT < 29 && getPermissionState(PHOTOS) != PermissionState.GRANTED) {
            requestPermissionForAlias(PHOTOS, call, "photosAnswered");
            return;
        }
        save(call, new File(path));
    }

    @PermissionCallback
    private void photosAnswered(PluginCall call) {
        if (getPermissionState(PHOTOS) == PermissionState.GRANTED) {
            save(call, new File(call.getString("path")));
        } else {
            JSObject out = new JSObject();
            out.put("saved", false);
            out.put("message", "Cutalong saves your exports to Photos, and needs your permission to.");
            call.resolve(out);
        }
    }

    private void save(final PluginCall call, final File file) {
        io.execute(() -> {
            JSObject out = new JSObject();
            try {
                PhotoSaver.save(getContext(), file);
                out.put("saved", true);
            } catch (Exception e) {
                out.put("saved", false);
                out.put("message", e.getMessage() != null ? e.getMessage() : "The gallery did not take it.");
            }
            call.resolve(out);
        });
    }
}
