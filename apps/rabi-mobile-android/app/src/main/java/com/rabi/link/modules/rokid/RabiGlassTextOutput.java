package com.rabi.link.modules.rokid;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import com.rokid.cxr.link.utils.GlassInfo;
import com.rabi.link.protocol.RabiGlassTextProtocol;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** Bounded output adapter. The existing PC backend owns durable retry and delivery IDs. */
public final class RabiGlassTextOutput implements RokidCxrController.Listener {
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private RokidCxrController cxr;
    private CountDownLatch completion;
    private String messageId = "";
    private String attempt = "";
    private String payload = "";
    private volatile boolean displayed;
    private volatile boolean closed;
    private boolean queried;
    private boolean launched;
    private boolean sent;
    private boolean finished;

    public RabiGlassTextOutput(Context context) { this.context = context.getApplicationContext(); }
    public static boolean enabled(Context context) {
        return context.getSharedPreferences("rabi_glasses_output", Context.MODE_PRIVATE).getBoolean("text_enabled", false);
    }
    static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences("rabi_glasses_output", Context.MODE_PRIVATE).edit().putBoolean("text_enabled", enabled).apply();
    }

    /** Called only from the existing reply worker, never the Android main thread. */
    public synchronized boolean deliver(String id, String text) {
        if (Looper.myLooper() == Looper.getMainLooper() || closed) return false;
        messageId = id; attempt = UUID.randomUUID().toString(); displayed = false;
        try { payload = RabiGlassTextProtocol.message(id, attempt, text); }
        catch (Exception invalid) { onLog("invalid delivery payload"); return false; }
        completion = new CountDownLatch(1);
        main.post(this::begin);
        try { completion.await(25, TimeUnit.SECONDS); }
        catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
        boolean result = displayed;
        // Always create a fresh connection per retry, so late callbacks cannot acknowledge a new attempt.
        closed = true;
        main.post(this::disconnect);
        onLog(result ? "display confirmed" : "display unconfirmed; retained by existing reply retry");
        return result;
    }

    private void begin() {
        if (closed) return;
        String token = context.getSharedPreferences("rokid_probe", Context.MODE_PRIVATE).getString("rokid_token", "");
        if (token == null || token.isEmpty()) { finish(false); return; }
        try {
            cxr = new RokidCxrController(context, this, RabiGlassTextProtocol.PACKAGE);
            if (!cxr.connectGlassAppSession(token)) finish(false);
        } catch (RuntimeException failure) { onLog("CXR connection rejected"); finish(false); }
    }
    private void ready() {
        if (!closed && !finished && !queried && cxr != null && cxr.isLinkReady()) {
            queried = true; cxr.queryGlassAsrApp();
        }
    }
    private void finish(boolean success) {
        if (closed || finished) return;
        displayed = success;
        finished = true;
        if (completion != null) completion.countDown();
    }
    public void close() {
        closed = true;
        if (completion != null) completion.countDown();
        main.post(this::disconnect);
    }
    private void disconnect() { if (cxr != null) { cxr.disconnect(); cxr = null; } }
    @Override public void onLog(String line) { android.util.Log.i("RabiGlassTextOutput", line); }
    @Override public void onCxrConnectionChanged(boolean connected) { main.post(() -> { if (connected) ready(); }); }
    @Override public void onGlassBtConnectionChanged(boolean connected) { main.post(() -> { if (connected) ready(); else if (sent) finish(false); }); }
    @Override public void onGlassDeviceInfo(GlassInfo info) { }
    @Override public void onPhoto(byte[] data) { }
    @Override public void onAudioPcm(byte[] data, int offset, int length) { }
    @Override public void onGlassAppResult(String status, String summary, String error) {
        main.post(() -> {
            if (closed || finished || cxr == null) return;
            if (summary.startsWith("onQueryAppResult")) {
                if (!"ok".equals(status)) { onLog("glasses component missing"); finish(false); return; }
                if (!launched) { launched = true; cxr.startGlassTextApp(); }
            } else if ("started".equals(status) && launched && !sent) {
                sent = true; if (!cxr.sendTextCommand(payload)) finish(false);
            } else if ("failed".equals(status)) finish(false);
        });
    }
    @Override public void onNativeVoiceProtocol(String raw, String channel, String clientId) {
        main.post(() -> {
            if (!closed && sent && RabiGlassTextProtocol.REPLY.equals(clientId)
                    && RabiGlassTextProtocol.matchesReceipt(raw, messageId, attempt)) finish(true);
        });
    }
}
