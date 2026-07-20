package com.rabi.link.modules.rokid;

final class RokidProbeDefaults {
    static final int AUDIO_STREAM_MODE = 1;
    static final int PHOTO_WIDTH = 1024;
    static final int PHOTO_HEIGHT = 768;
    static final int PHOTO_JPEG_QUALITY = 80;
    static final int GLASS_BRIGHTNESS = 8;
    static final int GLASS_VOLUME = 8;
    static final String CUSTOM_VIEW_TITLE = "Rabi Link";
    static final String CUSTOM_VIEW_HELLO_MESSAGE = "Hello Rokid";

    private RokidProbeDefaults() {
    }

    static String brightnessAndVolumeLabel() {
        return "亮度 " + GLASS_BRIGHTNESS + " / 音量 " + GLASS_VOLUME;
    }

    static String photoLabel() {
        return "拍照 " + PHOTO_WIDTH + "x" + PHOTO_HEIGHT;
    }

    static String updatedCustomViewMessage() {
        return "Updated " + System.currentTimeMillis();
    }
}
