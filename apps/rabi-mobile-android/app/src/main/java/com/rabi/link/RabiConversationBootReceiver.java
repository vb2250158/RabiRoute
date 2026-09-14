package com.rabi.link;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores the explicitly enabled phone conversation service after device reboot. */
public final class RabiConversationBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        // A reboot closes the permitted capture window; only an explicit foreground action resumes it.
        com.rabi.link.recording.AllDayRecordingSettings.load(context)
                .withRunning(false, System.currentTimeMillis()).save(context);
        context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit()
                .putString("allDayStatus", "设备已重启，采集暂停；请打开记录页恢复").apply();
        if (!RabiConversationServiceState.shouldRestore(context)
                || !RabiLinkRelaySettings.load(context).getConfigured()) return;
        try {
            RabiConversationService.restoreAfterBoot(context);
        } catch (RuntimeException ignored) {
            // If a vendor blocks boot foreground work entirely, the next explicit app
            // open restores transport without granting microphone access.
        }
    }
}
