package com.rabi.link.modules.rokid;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.provider.MediaStore;

import com.rabi.link.bridge.RabiLinkStorage;

import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class RokidPhotoStore {
    private RokidPhotoStore() {
    }

    static Uri saveJpeg(Context context, byte[] data) throws Exception {
        String fileName = "rokid-photo-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".jpg";
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RabiLinkStorage.downloadsPath("rokid"));
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回 null");
        }
        try (OutputStream output = context.getContentResolver().openOutputStream(uri)) {
            if (output != null) {
                output.write(data);
            }
        }
        return uri;
    }
}
