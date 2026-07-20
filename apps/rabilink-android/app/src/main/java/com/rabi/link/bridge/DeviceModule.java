package com.rabi.link.bridge;

import java.util.List;

public interface DeviceModule {
    String id();

    String displayName();

    String summary();

    List<Capability> capabilities();
}
