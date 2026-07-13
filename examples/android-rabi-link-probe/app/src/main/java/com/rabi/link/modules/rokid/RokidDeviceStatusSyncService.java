package com.rabi.link.modules.rokid;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import com.rabi.link.MainActivity;
import com.rabi.link.RabiLinkRelayConfig;
import com.rabi.link.RabiLinkRelaySettings;
import com.rokid.cxr.link.utils.GlassInfo;
import com.rabiroute.sdk.RabiLinkDeviceStatus;
import com.rabiroute.sdk.RabiRouteSdk;

import java.time.Instant;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class RokidDeviceStatusSyncService extends Service implements RokidCxrController.Listener {
    private static final String TAG = "RabiLinkGlassStatus";
    private static final String CHANNEL_ID = "rabilink_glass_status";
    private static final int NOTIFICATION_ID = 1703;
    private static final long QUERY_INTERVAL_MS = 60_000L;
    private static final long RECONNECT_INTERVAL_MS = 15_000L;
    private static final String ROKID_PREFS_NAME = "rokid_probe";
    private static final String ROKID_TOKEN_KEY = "rokid_token";

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService publisher = Executors.newSingleThreadExecutor();
    private final RabiRouteSdk rabiRouteSdk = new RabiRouteSdk();
    private RokidCxrController controller;
    private boolean destroyed;

    private final Runnable queryRunnable = new Runnable() {
        @Override
        public void run() {
            if (destroyed || controller == null) return;
            if (controller.isCxrConnected()) {
                controller.getGlassDeviceInfo();
                scheduleQuery(QUERY_INTERVAL_MS);
            } else {
                connectStatusChannel();
                scheduleQuery(RECONNECT_INTERVAL_MS);
            }
        }
    };

    public static void start(Context context) {
        Intent intent = new Intent(context, RokidDeviceStatusSyncService.class);
        context.startForegroundService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIFICATION_ID, notification("等待眼镜状态"));
        controller = new RokidCxrController(this, this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        connectStatusChannel();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (controller != null) controller.disconnect();
        publisher.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void connectStatusChannel() {
        if (destroyed || controller == null) return;
        String rokidToken = getSharedPreferences(ROKID_PREFS_NAME, MODE_PRIVATE)
                .getString(ROKID_TOKEN_KEY, "");
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (rokidToken == null || rokidToken.trim().isEmpty()
                || !relay.getConfigured() || !relay.getStatusSyncEnabled()) {
            updateNotification("等待 RabiLink 与 Rokid 授权");
            stopSelf();
            return;
        }
        handler.removeCallbacks(queryRunnable);
        boolean binding = controller.connectStatusOnly(rokidToken.trim());
        updateNotification(binding ? "正在读取眼镜状态" : "等待眼镜连接");
        scheduleQuery(RECONNECT_INTERVAL_MS);
    }

    private void scheduleQuery(long delayMs) {
        handler.removeCallbacks(queryRunnable);
        if (!destroyed) handler.postDelayed(queryRunnable, delayMs);
    }

    @Override
    public void onLog(String line) {
        Log.d(TAG, line);
    }

    @Override
    public void onCxrConnectionChanged(boolean connected) {
        handler.post(() -> {
            if (destroyed) return;
            updateNotification(connected ? "正在读取眼镜状态" : "等待眼镜连接");
            scheduleQuery(connected ? 250L : RECONNECT_INTERVAL_MS);
        });
    }

    @Override
    public void onGlassBtConnectionChanged(boolean connected) {
        if (connected) handler.post(() -> scheduleQuery(100L));
    }

    @Override
    public void onGlassDeviceInfo(GlassInfo info) {
        if (info == null || info.batteryLevel < 0 || info.batteryLevel > 100) return;
        int batteryLevel = info.batteryLevel;
        boolean charging = info.ischarging;
        String observedAt = Instant.now().toString();
        updateNotification(charging
                ? "眼镜充电中 " + batteryLevel + "%"
                : "眼镜电量 " + batteryLevel + "%");
        publisher.execute(() -> publishStatus(batteryLevel, charging, observedAt));
    }

    private void publishStatus(int batteryLevel, boolean charging, String observedAt) {
        RabiLinkRelayConfig relay = RabiLinkRelaySettings.load(this);
        if (!relay.getConfigured() || !relay.getStatusSyncEnabled()) return;
        try {
            RabiLinkDeviceStatus result = rabiRouteSdk.publishMobileDeviceStatus(
                    relay.getBaseUrl(),
                    relay.getToken(),
                    batteryLevel,
                    charging,
                    observedAt
            );
            Log.i(TAG, "Published battery=" + result.getBatteryLevel()
                    + " charging=" + result.getCharging()
                    + " stale=" + result.getStale());
        } catch (Throwable error) {
            Log.w(TAG, "Device status publish failed: " + error.getClass().getSimpleName()
                    + ": " + error.getMessage());
        }
    }

    @Override
    public void onPhoto(byte[] data) {
    }

    @Override
    public void onGlassAppResult(String status, String summary, String error) {
    }

    @Override
    public void onNativeVoiceProtocol(String payload, String channel, String clientId) {
    }

    @Override
    public void onAudioPcm(byte[] data, int offset, int length) {
    }

    private void createNotificationChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID,
                "RabiLink 眼镜状态",
                NotificationManager.IMPORTANCE_LOW
        ));
    }

    private Notification notification(String text) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.rabi.link.R.drawable.rabiroute_icon)
                .setContentTitle("RabiLink 眼镜状态")
                .setContentText(text)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.notify(NOTIFICATION_ID, notification(text));
    }
}
