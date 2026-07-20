package com.rabi.link.modules.xiaomi;

import android.app.Activity;
import android.net.Uri;
import android.provider.MediaStore;

import com.rabi.link.bridge.RabiLinkStorage;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

final class MiHealthCloudDownloadExporter {
    private final Activity activity;
    private final MiHealthCloudResultActions.LogSink log;

    MiHealthCloudDownloadExporter(Activity activity, MiHealthCloudResultActions.LogSink log) {
        this.activity = activity;
        this.log = log;
    }

    Uri saveText(String fileName, String mimeType, String text) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RabiLinkStorage.downloadsPath());
        Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        try (OutputStream stream = activity.getContentResolver().openOutputStream(uri)) {
            if (stream == null) {
                throw new IllegalStateException("无法打开输出流");
            }
            stream.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return uri;
    }

    void saveRawFiles(String stamp) throws Exception {
        File dir = MiHealthCloudArtifacts.rawHttpDir(activity);
        File[] files = dir.listFiles();
        if (files == null || files.length == 0) {
            append("没有 raw HTTP 文件需要保存。");
            return;
        }
        int saved = 0;
        for (File file : files) {
            if (!file.isFile()) {
                continue;
            }
            Uri uri = saveFile(MiHealthCloudContract.rawJsonFileName(stamp, file.getName()), MiHealthCloudContract.MIME_JSON, file);
            saved += 1;
            append("raw HTTP 已保存：" + uri);
        }
        append("raw HTTP 文件数量：" + saved);
    }

    private Uri saveFile(String fileName, String mimeType, File source) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RabiLinkStorage.downloadsPath("raw"));
        Uri uri = activity.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        try (InputStream input = new FileInputStream(source);
             OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
            if (output == null) {
                throw new IllegalStateException("无法打开输出流");
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        return uri;
    }

    private void append(String line) {
        log.append(line);
    }
}
