package com.rabi.link.modules.rokid;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Diagnostic-only, single ATT packet protocol. No application data or credentials. */
public final class RokidBlePingProtocol {
    public static final UUID SERVICE = UUID.fromString("78c20001-48a3-4b18-a401-819ec0200001");
    public static final UUID CHARACTERISTIC = UUID.fromString("78c20002-48a3-4b18-a401-819ec0200001");
    public static final int MAX_BYTES = 20;

    private RokidBlePingProtocol() { }

    public static byte[] reply(byte[] request) {
        if (request == null || request.length > MAX_BYTES) return null;
        String text = new String(request, StandardCharsets.US_ASCII);
        if (!text.matches("ping:[a-f0-9]{8}")) return null;
        return ("pong:" + text.substring(5)).getBytes(StandardCharsets.US_ASCII);
    }
}
