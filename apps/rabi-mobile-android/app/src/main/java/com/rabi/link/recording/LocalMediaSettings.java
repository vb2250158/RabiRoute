package com.rabi.link.recording;

import android.content.Context;

/** Device-local receiver ports; legacy defaults preserve existing manual RTMP setup. */
public final class LocalMediaSettings {
    public static final String PREFS = "rabi_local_media";
    public static final int DEFAULT_RTMP_PORT = 1936;
    public static final int DEFAULT_PREVIEW_PORT = 8554;
    public final int rtmpPort;
    public final int previewPort;
    public LocalMediaSettings(int rtmpPort, int previewPort) {
        if (!validPort(rtmpPort) || !validPort(previewPort) || rtmpPort == previewPort)
            throw new IllegalArgumentException("Local media ports must differ and be within 1024–65535");
        this.rtmpPort = rtmpPort; this.previewPort = previewPort;
    }
    public static boolean validPort(int port) { return port >= 1024 && port <= 65535; }
    public static LocalMediaSettings load(Context context) {
        android.content.SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new LocalMediaSettings(p.getInt("rtmpPort", DEFAULT_RTMP_PORT), p.getInt("previewPort", DEFAULT_PREVIEW_PORT));
    }
    public void save(Context context) {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("rtmpPort", rtmpPort)
                .putInt("previewPort", previewPort).commit()) throw new IllegalStateException("Cannot save local media ports");
    }
}
