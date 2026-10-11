package com.rabi.link.glass.video;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import java.util.HashSet;
import java.util.Set;
import com.rabi.link.protocol.RabiAiuiWakeProbeProtocol;

/** Explicit experiment: publish the documented gesture broadcast, then observe the real launcher. */
final class GlassAiuiWakeProbe {
    interface Receipt { void report(String state); }
    private static final int MAX_PROBES = 128;

    static void dispatch(Context context, String id, boolean captureBusy, Receipt receipt) {
        if (!RabiAiuiWakeProbeProtocol.validRequestId(id)) return;
        if (captureBusy) { receipt.report("capture_busy"); return; }
        Context app = context.getApplicationContext();
        SharedPreferences ledger = app.getSharedPreferences("aiui_wake_probe", Context.MODE_PRIVATE);
        Set<String> ids = new HashSet<>(ledger.getStringSet("attempted", new HashSet<>()));
        if (ids.contains(id)) { receipt.report("duplicate_suppressed"); return; }
        if (ids.size() >= MAX_PROBES) { receipt.report("ledger_full"); return; }
        ids.add(id);
        // Persist before the side effect. A lost receipt must never repeat the same gesture.
        if (!ledger.edit().putStringSet("attempted", ids).commit()) { receipt.report("ledger_failed"); return; }
        try {
            app.sendOrderedBroadcast(new Intent(RabiAiuiWakeProbeProtocol.TWO_FINGER_ACTION), null,
                    new BroadcastReceiver() {
                        @Override public void onReceive(Context ignored, Intent intent) {
                            receipt.report("broadcast_finished");
                        }
                    }, null, 0, null, null);
            receipt.report("broadcast_submitted");
        } catch (SecurityException failure) {
            android.util.Log.w("RabiAiuiWakeProbe", "gesture dispatch rejected requestId=" + id, failure);
            receipt.report("dispatch_security_rejected");
        } catch (IllegalArgumentException failure) {
            android.util.Log.w("RabiAiuiWakeProbe", "gesture dispatch invalid requestId=" + id, failure);
            receipt.report("dispatch_invalid_argument");
        } catch (RuntimeException failure) {
            android.util.Log.w("RabiAiuiWakeProbe", "gesture dispatch failed requestId=" + id, failure);
            receipt.report("dispatch_failed");
        }
    }
}
