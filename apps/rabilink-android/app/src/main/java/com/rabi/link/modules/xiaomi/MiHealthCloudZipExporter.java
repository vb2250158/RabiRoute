package com.rabi.link.modules.xiaomi;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.provider.MediaStore;

import com.rabi.link.bridge.RabiLinkStorage;

import java.io.File;
import java.io.FileInputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Comparator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public final class MiHealthCloudZipExporter {
    private MiHealthCloudZipExporter() {
    }

    public static Uri saveToDownloads(
            Context context,
            String fileName,
            String markdown,
            String json,
            String logText
    ) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, MiHealthCloudContract.MIME_ZIP);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RabiLinkStorage.downloadsPath());
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        OutputStream stream = context.getContentResolver().openOutputStream(uri);
        if (stream == null) {
            throw new IllegalStateException("无法打开输出流");
        }
        try (ZipOutputStream zip = new ZipOutputStream(stream)) {
            if (MiHealthCloudArtifacts.hasText(json)) {
                writeZipText(zip, MiHealthCloudContract.ZIP_JSON_ENTRY, json);
            }
            if (MiHealthCloudArtifacts.hasText(markdown)) {
                writeZipText(zip, MiHealthCloudContract.ZIP_MARKDOWN_ENTRY, markdown);
            }
            if (MiHealthCloudArtifacts.hasText(logText)) {
                writeZipText(zip, MiHealthCloudContract.ZIP_LOG_ENTRY, logText);
            }
            File rawDir = MiHealthCloudArtifacts.rawHttpDir(context);
            File[] rawFiles = rawDir.listFiles();
            if (rawFiles != null) {
                Arrays.sort(rawFiles, Comparator.comparing(File::getName));
                for (File file : rawFiles) {
                    if (file.isFile()) {
                        writeZipFile(zip, "raw/" + file.getName(), file);
                    }
                }
            }
        }
        return uri;
    }

    private static void writeZipText(ZipOutputStream zip, String name, String text) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(text.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private static void writeZipFile(ZipOutputStream zip, String name, File file) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                zip.write(buffer, 0, read);
            }
        }
        zip.closeEntry();
    }
}
