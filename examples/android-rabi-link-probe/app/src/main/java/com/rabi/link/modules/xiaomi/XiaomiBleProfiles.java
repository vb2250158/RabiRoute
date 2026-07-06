package com.rabi.link.modules.xiaomi;

import java.util.Locale;
import java.util.UUID;

final class XiaomiBleProfiles {
    static final UUID DEVICE_INFORMATION_SERVICE = uuid16(0x180A);
    static final UUID BATTERY_SERVICE = uuid16(0x180F);
    static final UUID HEART_RATE_SERVICE = uuid16(0x180D);
    static final UUID HEART_RATE_MEASUREMENT = uuid16(0x2A37);
    static final UUID CLIENT_CHARACTERISTIC_CONFIG = uuid16(0x2902);

    private XiaomiBleProfiles() {
    }

    static String shortUuid(UUID uuid) {
        String text = uuid.toString();
        if (text.startsWith("0000") && text.endsWith("-0000-1000-8000-00805f9b34fb")) {
            return "0x" + text.substring(4, 8).toUpperCase(Locale.US);
        }
        return text;
    }

    private static UUID uuid16(int value) {
        return UUID.fromString(String.format(Locale.US, "0000%04x-0000-1000-8000-00805f9b34fb", value));
    }
}
