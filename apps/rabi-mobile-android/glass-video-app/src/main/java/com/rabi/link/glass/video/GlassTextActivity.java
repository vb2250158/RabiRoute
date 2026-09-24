package com.rabi.link.glass.video;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.graphics.Color;
import android.view.ViewTreeObserver;
import android.view.WindowManager;
import android.widget.ScrollView;
import android.widget.TextView;
import com.rokid.cxr.CXRServiceBridge;
import com.rokid.cxr.Caps;
import com.rabi.link.protocol.RabiGlassTextProtocol;
import org.json.JSONObject;

/** Dedicated text-only entry: no microphone, camera, speech SDK, or capture startup. */
public final class GlassTextActivity extends Activity {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final CXRServiceBridge bridge = new CXRServiceBridge();
    private TextView textView;
    private JSONObject pending;
    private boolean destroyed;
    private boolean drawScheduled;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        textView = new TextView(this); textView.setTextColor(Color.WHITE); textView.setTextSize(24);
        textView.setPadding(20, 16, 20, 16);
        textView.setText(getPreferences(MODE_PRIVATE).getString("lastText", "等待 Rabi 消息"));
        ScrollView root = new ScrollView(this); root.setBackgroundColor(Color.BLACK); root.addView(textView); setContentView(root);
        bridge.subscribe(RabiGlassTextProtocol.CHANNEL, new CXRServiceBridge.MsgCallback() {
            @Override public void onReceive(String name, Caps args, byte[] bytes) {
                if (!RabiGlassTextProtocol.CHANNEL.equals(name) || args == null) return;
                try {
                    String raw = args.at(args.size() > 1 ? 1 : 0).getString();
                    if (raw == null || !raw.startsWith(RabiGlassTextProtocol.PREFIX)) return;
                    JSONObject value = new JSONObject(raw.substring(RabiGlassTextProtocol.PREFIX.length()));
                    if (RabiGlassTextProtocol.valid(value)) main.post(() -> display(value));
                } catch (Exception invalid) { android.util.Log.w("RabiGlassText", "invalid message"); }
            }
        });
    }

    private void display(JSONObject value) {
        if (destroyed) return;
        pending = value;
        textView.setText(value.optString("text"));
        // Only the current visible message is retained; retries redraw rather than append duplicates.
        getPreferences(MODE_PRIVATE).edit().putString("lastText", value.optString("text")).apply();
        scheduleReceipt();
    }

    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) scheduleReceipt();
    }

    private void scheduleReceipt() {
        if (destroyed || pending == null || !hasWindowFocus() || drawScheduled) return;
        drawScheduled = true;
        textView.getViewTreeObserver().addOnDrawListener(new ViewTreeObserver.OnDrawListener() {
            private boolean posted;
            @Override public void onDraw() {
                if (posted) return;
                posted = true;
                JSONObject drawn = pending;
                textView.post(() -> {
                    if (textView.getViewTreeObserver().isAlive()) textView.getViewTreeObserver().removeOnDrawListener(this);
                    drawScheduled = false;
                    if (destroyed || !hasWindowFocus() || pending == null) return;
                    if (pending != drawn) { scheduleReceipt(); return; }
                    JSONObject shown = pending; pending = null;
                    try {
                        JSONObject receipt = new JSONObject().put("messageId", shown.optString("messageId"))
                                .put("attempt", shown.optString("attempt")).put("state", "displayed");
                        Caps args = new Caps(); args.write("protocol"); args.write(RabiGlassTextProtocol.RECEIPT_PREFIX + receipt);
                        bridge.sendMessage(RabiGlassTextProtocol.REPLY, args);
                        android.util.Log.i("RabiGlassText", "displayed receipt sent");
                    } catch (Exception failure) { android.util.Log.w("RabiGlassText", "receipt failed"); }
                });
            }
        });
        textView.invalidate();
    }
    @Override protected void onDestroy() { destroyed = true; pending = null; main.removeCallbacksAndMessages(null); super.onDestroy(); }
}
