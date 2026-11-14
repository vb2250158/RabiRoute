package com.rabi.link.recording;

import android.content.Context;

/** Device-local port preferences; zero is automatic, positive values are explicit. */
public final class LocalMediaSettings {
    public static final String PREFS = "rabi_local_media";
    public static final int DEFAULT_RTMP_PORT = 0;
    public static final int DEFAULT_PREVIEW_PORT = 0;
    public final int rtmpPort;
    public final int previewPort;
    public LocalMediaSettings(int rtmpPort, int previewPort) {
        if (!validPort(rtmpPort) || !validPort(previewPort) || (rtmpPort != 0 && rtmpPort == previewPort))
            throw new IllegalArgumentException("Local media ports must be automatic (0) or distinct values within 1024–65535");
        this.rtmpPort = rtmpPort; this.previewPort = previewPort;
    }
    public static boolean validPort(int port) { return port == 0 || port >= 1024 && port <= 65535; }
    public static LocalMediaSettings load(Context context) {
        android.content.SharedPreferences p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return new LocalMediaSettings(p.getInt("rtmpPort", DEFAULT_RTMP_PORT), p.getInt("previewPort", DEFAULT_PREVIEW_PORT));
    }
    public void save(Context context) {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt("rtmpPort", rtmpPort)
                .putInt("previewPort", previewPort).commit()) throw new IllegalStateException("Cannot save local media ports");
    }
}
