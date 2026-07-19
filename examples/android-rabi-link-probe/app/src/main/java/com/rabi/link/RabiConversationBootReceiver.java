package com.rabi.link;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores the explicitly enabled phone conversation service after device reboot. */
public final class RabiConversationBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        RabiConversationSettings settings = RabiConversationSettings.load(context);
        if (!settings.continuousListening || !RabiLinkRelaySettings.load(context).getConfigured()) return;
        try {
            RabiConversationService.restoreAfterBoot(context);
        } catch (RuntimeException ignored) {
            // If a vendor blocks boot foreground work entirely, the next explicit app
            // open restores both transport and capture without losing queued messages.
        }
    }
}
