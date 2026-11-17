package app.cutalong.engine;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Adds an export to the phone's gallery: videos to Movies/Cutalong, pictures
 * to Pictures/Cutalong. From Android 10 this needs no permission at all;
 * before, the plugin asks for storage first.
 */
public final class PhotoSaver {

    private PhotoSaver() {}

    /** Saves the file; returns where the gallery keeps it. */
    public static Uri save(Context context, File file) throws IOException {
        String mime = mimeOf(file.getName());
        boolean picture = mime.startsWith("image/");
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver resolver = context.getContentResolver();
            Uri collection = picture
                ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                : MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            ContentValues values = new ContentValues();
            values.put(MediaStore.MediaColumns.DISPLAY_NAME, file.getName());
            values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
            values.put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                (picture ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES) + "/Cutalong"
            );
            values.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri item = resolver.insert(collection, values);
            if (item == null) throw new IOException("The gallery would not take " + file.getName() + ".");
            try (InputStream in = new FileInputStream(file); OutputStream out = resolver.openOutputStream(item)) {
                if (out == null) throw new IOException("The gallery would not take " + file.getName() + ".");
                Importer.copy(in, out);
            } catch (IOException e) {
                resolver.delete(item, null, null);
                throw e;
            }
            values.clear();
            values.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(item, values, null, null);
            return item;
        }
        File dir = new File(
            Environment.getExternalStoragePublicDirectory(picture ? Environment.DIRECTORY_PICTURES : Environment.DIRECTORY_MOVIES),
            "Cutalong"
        );
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Could not make " + dir);
        File dest = Importer.unique(dir, file.getName());
        try (InputStream in = new FileInputStream(file); OutputStream out = new FileOutputStream(dest)) {
            Importer.copy(in, out);
        }
        MediaScannerConnection.scanFile(context, new String[] { dest.getAbsolutePath() }, new String[] { mime }, null);
        return Uri.fromFile(dest);
    }

    static String mimeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".mov")) return "video/quicktime";
        if (n.endsWith(".m4v")) return "video/x-m4v";
        if (n.endsWith(".webm")) return "video/webm";
        if (n.endsWith(".mkv")) return "video/x-matroska";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".heic")) return "image/heic";
        return "video/mp4";
    }
}
