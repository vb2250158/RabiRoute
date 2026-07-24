package com.rabi.link;

import android.content.Context;
import android.content.SharedPreferences;

/** Durable user intent for restoring the message transport after process or device restart. */
public final class RabiConversationServiceState {
    private static final String PREFS = "rabi_conversation_service_state";
    private static final String KEY_RESTORE_ENABLED = "restoreEnabled";

    private RabiConversationServiceState() { }

    public static boolean shouldRestore(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (values.contains(KEY_RESTORE_ENABLED)) {
            return values.getBoolean(KEY_RESTORE_ENABLED, false);
        }
        // Existing installations used continuous listening as the only durable enable bit.
        return RabiConversationSettings.load(context).continuousListening;
    }

    public static void setRestoreEnabled(Context context, boolean enabled) {
        if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_RESTORE_ENABLED, enabled)
                .commit()) {
            throw new IllegalStateException("无法保存 Rabi 消息连接恢复状态");
        }
    }
}
