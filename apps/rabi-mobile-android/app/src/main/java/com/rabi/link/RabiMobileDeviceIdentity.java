package com.rabi.link;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;
import java.util.UUID;

/** Stable per-install identity so several phones can connect without sharing one stream id. */
public final class RabiMobileDeviceIdentity {
    private static final String PREFS = "rabi_mobile_device_identity";
    private static final String KEY_DEVICE_ID = "deviceId";
    private static final String PREFIX = "rabi-phone-";

    private RabiMobileDeviceIdentity() { }

    public static String load(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String existing = normalize(values.getString(KEY_DEVICE_ID, ""));
        if (!existing.isEmpty()) return existing;
        String generated = PREFIX + UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        if (!values.edit().putString(KEY_DEVICE_ID, generated).commit()) {
            throw new IllegalStateException("无法保存 Rabi 手机设备 ID");
        }
        return generated;
    }

    private static String normalize(String value) {
        String candidate = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (!candidate.startsWith(PREFIX) || candidate.length() > 100) return "";
        for (int index = 0; index < candidate.length(); index++) {
            char character = candidate.charAt(index);
            if (!(Character.isLetterOrDigit(character) || character == '-' || character == '_' || character == '.')) {
                return "";
            }
        }
        return candidate;
    }
}
