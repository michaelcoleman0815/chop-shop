package app.cutalong.engine;

import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Copies what the person picked into the app's own storage, a megabyte at a
 * time, so a 4K recording never sits whole in memory and stays readable
 * after the picker's permission to it lapses.
 */
public final class Importer {

    /** A copied file: where it is now, the name the person knows it by, and its size. */
    public static final class Picked {
        public final String path;
        public final String name;
        public final long bytes;

        Picked(String path, String name, long bytes) {
            this.path = path;
            this.name = name;
            this.bytes = bytes;
        }
    }

    private Importer() {}

    /** The folder picked files are copied into: Imported, in documents. */
    public static File folder(Context context) {
        return new File(context.getFilesDir(), "Imported");
    }

    public static Picked copyIn(Context context, Uri uri) throws IOException {
        ContentResolver resolver = context.getContentResolver();
        String name = displayName(resolver, uri);
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.trim().isEmpty()) name = "Imported";
        name = safeName(name);
        if (!hasExtension(name)) {
            String type = resolver.getType(uri);
            String ext = type == null ? null : MimeTypeMap.getSingleton().getExtensionFromMimeType(type);
            if (ext != null) name = name + "." + ext;
        }
        File dir = folder(context);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not make " + dir);
        File dest = unique(dir, name);
        File part = new File(dir, "." + dest.getName() + ".part");
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(part)) {
            if (in == null) throw new IOException("Could not open " + name);
            copy(in, out);
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw e;
        }
        if (!part.renameTo(dest)) {
            //noinspection ResultOfMethodCallIgnored
            part.delete();
            throw new IOException("Could not keep " + name);
        }
        return new Picked(dest.getAbsolutePath(), name, dest.length());
    }

    static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buf = new byte[1 << 20];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    }

    private static String displayName(ContentResolver resolver, Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor c = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (RuntimeException ignored) {
            // A provider that cannot say: the name comes from the address instead.
        }
        return null;
    }

    private static boolean hasExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 && dot < name.length() - 1;
    }

    /** A name a file can have: no folders in it, not hidden, not too long. */
    static String safeName(String name) {
        String s = name.replace('/', '-').replace('\\', '-').replace('\u0000', ' ').trim();
        while (s.startsWith(".")) s = s.substring(1);
        if (s.isEmpty()) s = "Imported";
        if (s.length() > 180) {
            int dot = s.lastIndexOf('.');
            String ext = dot > 0 && s.length() - dot <= 10 ? s.substring(dot) : "";
            s = s.substring(0, 180 - ext.length()) + ext;
        }
        return s;
    }

    /** name, or "name (2)", "name (3)" when it is taken. */
    static File unique(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 2;; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
    }
}
