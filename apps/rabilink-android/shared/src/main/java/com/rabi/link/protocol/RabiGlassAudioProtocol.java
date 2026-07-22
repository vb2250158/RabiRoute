package com.rabi.link.protocol;

/** Single protocol truth shared by the phone companion and the thin glasses APK. */
public final class RabiGlassAudioProtocol {
    public static final String CLIENT_ID = "GlassSample";
    public static final String AUDIO_STREAM_TAG = "RabiGlassAudioPcm";

    public static final String COMMAND_START = "RABI_GLASS_AUDIO_START";
    public static final String COMMAND_STOP = "RABI_GLASS_AUDIO_STOP";
    public static final String COMMAND_REVIEW = "RABI_GLASS_REVIEW_REQUEST";
    public static final String COMMAND_STATUS_REQUEST = "RABI_GLASS_AUDIO_STATUS_REQUEST";

    public static final String PREFIX_STATUS = "RABI_GLASS_AUDIO_STATUS:";
    public static final String PREFIX_TRANSCRIPT = "RABI_GLASS_TRANSCRIPT:";
    public static final String PREFIX_REPLY = "RABI_GLASS_REPLY:";
    public static final String PREFIX_DEVICE = "RABI_GLASS_DEVICE:";

    private RabiGlassAudioProtocol() {
    }
}
