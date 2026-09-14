package com.rabi.link.modules.rokid;

import org.junit.Test;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;
import static org.junit.Assert.*;

/** Checks the actual Android request paths against the checked-in PC FastAPI declarations. */
public class RabiAudioCrossSourceContractTest {
    private static Path repository() {
        Path current = Paths.get("").toAbsolutePath();
        while (current != null) {
            if (Files.isRegularFile(current.resolve("plugin-adapters/rabi-speech/rabispeech/app.py"))) return current;
            current = current.getParent();
        }
        throw new AssertionError("RabiRoute checkout containing PC speech source is required");
    }
    private static String text(Path path) throws Exception { return new String(Files.readAllBytes(path), StandardCharsets.UTF_8); }
    @Test public void androidCapabilitiesPathIsAnActualPcGetRoute() throws Exception {
        Path root = repository();
        String android = text(root.resolve("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java"));
        String pc = text(root.resolve("plugin-adapters/rabi-speech/rabispeech/app.py"));
        Matcher request = Pattern.compile("jsonRequest\\(\"GET\", \"/api/rabilink/speech([^\"]*capabilities)\"").matcher(android);
        assertTrue("Android capability GET call not found", request.find());
        assertTrue("Android capability suffix must exist in actual FastAPI app", pc.contains("@api.get(\"" + request.group(1) + "\")"));
    }
    @Test public void pcConsumesCanonicalDeviceKindRatherThanOptionalSourceAlias() throws Exception {
        Path root = repository();
        String android = text(root.resolve("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassPcBackend.java"));
        String pc = text(root.resolve("plugin-adapters/rabi-speech/rabispeech/app.py"));
        String remote = text(root.resolve("plugin-adapters/rabi-speech/rabispeech/remote_audio.py"));
        assertEquals("phone", RabiGlassPcBackend.normalizeCaptureSource("mobile"));
        assertTrue(android.contains(".put(\"device_kind\", glasses ? \"glasses\" : \"mobile\")"));
        assertTrue(pc.contains("kind=body.device_kind"));
        assertTrue(pc.contains("device_kind: str = \"mobile\""));
        assertTrue(remote.contains("def _safe_kind(value: object)"));
        assertTrue(android.contains(".put(\"source_device_id\", deviceId)"));
        assertTrue(pc.contains("source_device_id=body.source_device_id or body.session_id or body.stream_id"));
    }
}
