package com.rabi.link;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores the explicitly enabled phone conversation service after device reboot. */
public final class RabiConversationBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        // Preserve the user switch while closing the old Android capture window.
        com.rabi.link.recording.AllDayRecordingSettings saved = com.rabi.link.recording.AllDayRecordingSettings.load(context);
        if (saved.running) saved.withEnabled(true, System.currentTimeMillis()).save(context);
        com.rabi.link.recording.AllDayRecordingSettings.load(context)
                .withRunning(false, System.currentTimeMillis()).save(context);
        context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit()
                .putString("allDayStatus", "设备已重启；打开应用后按保存的开关恢复记录").apply();
        if (!saved.autoResume && !saved.running && !RabiConversationServiceState.shouldRestore(context)) return;
        if (saved.autoResume || saved.running) showResumeNotification(context);
        try {
            RabiConversationService.restoreAfterBoot(context);
        } catch (RuntimeException ignored) {
            // If a vendor blocks boot foreground work entirely, the next explicit app
            // open restores transport without granting microphone access.
        }
    }
    private static void showResumeNotification(Context context) {
        android.app.NotificationManager manager = context.getSystemService(android.app.NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new android.app.NotificationChannel("recording_resume",
                "记录恢复", android.app.NotificationManager.IMPORTANCE_DEFAULT));
        android.app.PendingIntent open = android.app.PendingIntent.getActivity(context, 701,
                new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        try {
            manager.notify(701, new androidx.core.app.NotificationCompat.Builder(context, "recording_resume")
                    .setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("记录开关已保留")
                    .setContentText("点击打开应用，自动恢复记录").setContentIntent(open).setAutoCancel(true).build());
        } catch (SecurityException ignored) { /* Notification permission may be unavailable after boot. */ }
    }

}
