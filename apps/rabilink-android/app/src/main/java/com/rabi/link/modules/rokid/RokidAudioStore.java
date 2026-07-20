package com.rabi.link.modules.rokid;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.provider.MediaStore;

import com.rabi.link.bridge.RabiLinkStorage;

import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

final class RokidAudioStore {
    private static final int SAMPLE_RATE = 16000;
    private static final int CHANNELS = 1;
    private static final int BITS_PER_SAMPLE = 16;
    private static final int HEADER_BYTES = 44;

    private RokidAudioStore() {
    }

    static Uri saveWav(Context context, byte[] pcm) throws Exception {
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, "rokid-audio-" + stamp + ".wav");
        values.put(MediaStore.MediaColumns.MIME_TYPE, "audio/wav");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, RabiLinkStorage.downloadsPath("rokid"));
        Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        try (OutputStream stream = context.getContentResolver().openOutputStream(uri)) {
            if (stream == null) {
                throw new IllegalStateException("无法打开输出流");
            }
            stream.write(wavHeader(pcm.length));
            stream.write(pcm);
        }
        return uri;
    }

    private static byte[] wavHeader(int dataBytes) {
        int byteRate = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8;
        int blockAlign = CHANNELS * BITS_PER_SAMPLE / 8;
        ByteBuffer buffer = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN);
        buffer.put(new byte[]{'R', 'I', 'F', 'F'});
        buffer.putInt(36 + dataBytes);
        buffer.put(new byte[]{'W', 'A', 'V', 'E'});
        buffer.put(new byte[]{'f', 'm', 't', ' '});
        buffer.putInt(16);
        buffer.putShort((short) 1);
        buffer.putShort((short) CHANNELS);
        buffer.putInt(SAMPLE_RATE);
        buffer.putInt(byteRate);
        buffer.putShort((short) blockAlign);
        buffer.putShort((short) BITS_PER_SAMPLE);
        buffer.put(new byte[]{'d', 'a', 't', 'a'});
        buffer.putInt(dataBytes);
        return buffer.array();
    }
}
