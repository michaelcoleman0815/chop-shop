package app.cutalong.engine.example;

import android.app.ActivityManager;
import android.content.Context;
import android.content.res.AssetManager;
import android.net.Uri;
import android.os.Build;
import app.cutalong.engine.Importer;
import app.cutalong.engine.PhotoSaver;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * What only the test app needs (see src/plugins.ts): its launch flag, its
 * media as files, small text files, the process's memory, and the engine
 * plugin's importer and gallery saver without their pickers.
 */
@CapacitorPlugin(name = "SelfTestHost")
public class SelfTestHostPlugin extends Plugin {

    /** Set by MainActivity from the launch intent. */
    static boolean selftest;

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void launch(PluginCall call) {
        JSObject out = new JSObject();
        out.put("selftest", selftest);
        call.resolve(out);
    }

    /** Copies the media bundled in the app (public/media) into the cache, as files. */
    @PluginMethod
    public void prepareMedia(PluginCall call) {
        io.execute(() -> {
            try {
                File dir = new File(getContext().getCacheDir(), "selftest-media");
                deleteTree(dir);
                copyAssets(getContext().getAssets(), "public/media", dir);
                if (!new File(dir, "expect.json").isFile()) throw new IOException("the app was built without its media");
                JSObject out = new JSObject();
                out.put("dir", dir.getAbsolutePath());
                call.resolve(out);
            } catch (IOException e) {
                call.reject("Could not copy the media: " + e.getMessage());
            }
        });
    }

    private static void copyAssets(AssetManager assets, String path, File dest) throws IOException {
        String[] names = assets.list(path);
        if (names == null || names.length == 0) {
            try (InputStream in = assets.open(path); OutputStream out = new FileOutputStream(dest)) {
                copy(in, out);
            }
            return;
        }
        if (!dest.isDirectory() && !dest.mkdirs()) throw new IOException("Could not make " + dest);
        for (String name : names) copyAssets(assets, path + "/" + name, new File(dest, name));
    }

    @PluginMethod
    public void readText(PluginCall call) {
        try (InputStream in = new FileInputStream(call.getString("path", ""))) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            copy(in, bytes);
            JSObject out = new JSObject();
            out.put("text", new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            call.resolve(out);
        } catch (IOException e) {
            call.reject("Could not read " + call.getString("path") + ": " + e.getMessage());
        }
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        File file = new File(call.getString("path", ""));
        File parent = file.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            call.reject("Could not make " + parent);
            return;
        }
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException e) {
            call.reject("Could not write " + file + ": " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        deleteTree(new File(call.getString("path", "")));
        call.resolve();
    }

    @PluginMethod
    public void fileSize(PluginCall call) {
        File file = new File(call.getString("path", ""));
        JSObject out = new JSObject();
        out.put("exists", file.isFile());
        out.put("bytes", file.isFile() ? file.length() : 0);
        call.resolve(out);
    }

    /** Resident memory now (VmRSS) and its peak (VmHWM), from /proc/self/status. */
    @PluginMethod
    public void memory(PluginCall call) {
        long rss = 0;
        long hwm = 0;
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/self/status"))) {
            for (String line; (line = r.readLine()) != null;) {
                if (line.startsWith("VmRSS:")) rss = kilobytes(line);
                else if (line.startsWith("VmHWM:")) hwm = kilobytes(line);
            }
        } catch (IOException e) {
            call.reject("Could not read /proc/self/status: " + e.getMessage());
            return;
        }
        JSObject out = new JSObject();
        out.put("residentBytes", rss);
        out.put("peakBytes", hwm);
        call.resolve(out);
    }

    private static long kilobytes(String line) {
        String digits = line.replaceAll("[^0-9]", "");
        return digits.isEmpty() ? 0 : Long.parseLong(digits) * 1024;
    }

    /** Starts the peak (VmHWM) afresh, where the kernel allows it. */
    @PluginMethod
    public void resetPeakMemory(PluginCall call) {
        boolean reset;
        try (OutputStream out = new FileOutputStream("/proc/self/clear_refs")) {
            out.write("5".getBytes(StandardCharsets.US_ASCII));
            reset = true;
        } catch (IOException | SecurityException e) {
            reset = false;
        }
        JSObject out = new JSObject();
        out.put("reset", reset);
        call.resolve(out);
    }

    /** Copies a file in with the engine plugin's importer, as a picked file is. */
    @PluginMethod
    public void importFile(PluginCall call) {
        io.execute(() -> {
            try {
                Importer.Picked p = Importer.copyIn(getContext(), Uri.fromFile(new File(call.getString("path", ""))));
                call.resolve(picked(p, null));
            } catch (IOException e) {
                call.reject("Could not import: " + e.getMessage());
            }
        });
    }

    /**
     * Saves a file to the gallery with the engine plugin's saver, then copies
     * it back in from the gallery's content:// address with its importer:
     * the path a video picked from the gallery takes.
     */
    @PluginMethod
    public void galleryRoundTrip(PluginCall call) {
        io.execute(() -> {
            try {
                Uri uri = PhotoSaver.save(getContext(), new File(call.getString("path", "")));
                Importer.Picked p = Importer.copyIn(getContext(), uri);
                call.resolve(picked(p, uri));
            } catch (IOException e) {
                call.reject("Could not go through the gallery: " + e.getMessage());
            }
        });
    }

    private static JSObject picked(Importer.Picked p, Uri uri) {
        JSObject out = new JSObject();
        out.put("path", p.path);
        out.put("name", p.name);
        out.put("bytes", p.bytes);
        if (uri != null) out.put("uri", uri.toString());
        return out;
    }

    @PluginMethod
    public void device(PluginCall call) {
        ActivityManager.MemoryInfo mem = new ActivityManager.MemoryInfo();
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am != null) am.getMemoryInfo(mem);
        JSObject out = new JSObject();
        out.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        out.put("os", "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + ")");
        out.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "");
        out.put("cpus", Runtime.getRuntime().availableProcessors());
        out.put("memoryBytes", mem.totalMem);
        out.put(
            "simulator",
            Build.FINGERPRINT.contains("generic") || Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish")
        );
        out.put("cpuFlags", cpuFlags());
        call.resolve(out);
    }

    /** The x86 instruction sets the CPU has (empty on arm64), for reading whisper's speed. */
    private static String cpuFlags() {
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
            for (String line; (line = r.readLine()) != null;) {
                if (line.startsWith("flags") || line.startsWith("Features")) {
                    StringBuilder keep = new StringBuilder();
                    for (String f : line.substring(line.indexOf(':') + 1).trim().split("\\s+")) {
                        if (f.matches("sse4_2|avx|avx2|fma|f16c|bmi2|avx512f|asimd|asimddp|fphp|asimdhp|i8mm|sve")) {
                            keep.append(keep.length() == 0 ? "" : " ").append(f);
                        }
                    }
                    return keep.toString();
                }
            }
        } catch (IOException ignored) {
            // Not there: nothing to say.
        }
        return "";
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static void deleteTree(File f) {
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
