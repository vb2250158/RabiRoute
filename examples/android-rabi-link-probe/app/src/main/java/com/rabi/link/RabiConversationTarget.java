package com.rabi.link;

import android.content.Context;

/** Per-chat route/persona target; RabiLink login itself remains global. */
public final class RabiConversationTarget {
    private static final String PREFS = "rabi_mobile_message_target";
    public static String load(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("routeProfileId", "");
    }
    public static void save(Context context, String routeProfileId) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("routeProfileId", routeProfileId == null ? "" : routeProfileId.trim()).apply();
    }
    private RabiConversationTarget() { }
}
