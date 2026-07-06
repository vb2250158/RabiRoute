package com.rabi.link.bridge;

import com.rabi.link.modules.rokid.RokidGlassModule;
import com.rabi.link.modules.xiaomi.XiaomiDeviceModule;

import java.util.Arrays;
import java.util.List;

public final class DeviceModuleRegistry {
    private DeviceModuleRegistry() {
    }

    public static List<DeviceModule> createDefaultModules() {
        return Arrays.asList(
                new XiaomiDeviceModule(),
                new RokidGlassModule()
        );
    }
}
