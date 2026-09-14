package com.rabi.link.bridge;

import android.os.Environment;

public final class RabiLinkStorage {
    public static final String DOWNLOAD_DIR_NAME = "RabiLinkProbe";

    private RabiLinkStorage() {
    }

    public static String downloadsPath() {
        return Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_DIR_NAME;
    }

    public static String downloadsPath(String child) {
        if (child == null || child.trim().isEmpty()) {
            return downloadsPath();
        }
        return downloadsPath() + "/" + child.trim();
    }
}
