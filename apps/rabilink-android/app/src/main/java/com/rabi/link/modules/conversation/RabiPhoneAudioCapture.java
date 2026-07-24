package com.rabi.link.modules.conversation;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.PowerManager;
import android.os.SystemClock;

import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Owns the long-running phone microphone lifecycle.
 *
 * The conversation service coordinates transport and UI-facing status; this class is the
 * single owner of AudioRecord, the capture wake lock, stall detection, bounded restart backoff,
 * and durable health metrics used by long-run acceptance checks.
 */
public final class RabiPhoneAudioCapture {
    private static final String PREFS = "rabi_phone_audio_capture";
    private static final String WAKE_LOCK_TAG = "RabiLink:PhoneAudioCapture";
    private static final int SAMPLE_RATE = 16000;
    private static final int BUFFER_BYTES = 3200;
    private static final long STALL_TIMEOUT_MS = 45_000L;
    private static final long HEALTHY_RESET_MS = 60_000L;
    private static final long METRIC_PERSIST_INTERVAL_MS = 10_000L;
    private static final long MAX_RESTART_DELAY_MS = 30_000L;

    public interface Listener {
        void onPcm(byte[] pcm);
        void onPlaybackSuppressed();
        void onStatus(String status);
        void onDiagnostic(String event, String level, String state);
    }

    private final Context context;
    private final Listener listener;
    private final ScheduledExecutorService supervisor = Executors.newSingleThreadScheduledExecutor();
    private final AtomicBoolean restartScheduled = new AtomicBoolean();
    private final AtomicInteger lifecycleGeneration = new AtomicInteger();
    private final Object recorderLock = new Object();

    private volatile boolean requested;
    private volatile boolean playbackSuppressed;
    private volatile ScheduledFuture<?> stallDeadline;
    private volatile AudioRecord recorder;
    private volatile long lastReadElapsed;
    private volatile long healthySinceElapsed;
    private volatile long lastMetricPersistElapsed;
    private volatile long totalBytes;
    private volatile int restartCount;
    private volatile int consecutiveRestarts;
    private volatile boolean closed;
    private PowerManager.WakeLock wakeLock;

    public RabiPhoneAudioCapture(Context context, Listener listener) {
        this.context = context.getApplicationContext();
        this.listener = listener;
        SharedPreferences values = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (!"stopped".equals(values.getString("state", ""))) {
            totalBytes = values.getLong("totalBytes", 0L);
            restartCount = values.getInt("restartCount", 0);
        }
    }

    public void start() {
        if (closed) throw new IllegalStateException("phone audio capture is closed");
        if (requested) return;
        requested = true;
        lifecycleGeneration.incrementAndGet();
        acquireWakeLock();
        startRecorder("initial_start");
    }

    public void setPlaybackSuppressed(boolean value) {
        playbackSuppressed = value;
    }

    /** Pauses phone capture while keeping the supervisor reusable for a later mode switch. */
    public void pause() {
        requested = false;
        lifecycleGeneration.incrementAndGet();
        restartScheduled.set(false);
        cancelStallDeadline();
        stopRecorder();
        releaseWakeLock();
        persistRuntime(false, "paused");
    }

    /** Permanently releases this capture owner when its service is shutting down. */
    public void close(boolean sessionEnded) {
        if (closed) return;
        closed = true;
        requested = false;
        lifecycleGeneration.incrementAndGet();
        restartScheduled.set(false);
        cancelStallDeadline();
        stopRecorder();
        supervisor.shutdownNow();
        releaseWakeLock();
        persistRuntime(false, sessionEnded ? "stopped" : "interrupted");
    }

    private void startRecorder(String reason) {
        if (!requested) return;
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            fail("microphone_permission_required", "需要麦克风权限");
            return;
        }
        synchronized (recorderLock) {
            if (!requested || recorder != null) return;
            try {
                int minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT);
                AudioRecord next = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                        Math.max(minimum * 2, 8192));
                if (next.getState() != AudioRecord.STATE_INITIALIZED) {
                    next.release();
                    scheduleRestart("audio_record_not_initialized");
                    return;
                }
                next.startRecording();
                recorder = next;
                long now = SystemClock.elapsedRealtime();
                lastReadElapsed = now;
                healthySinceElapsed = now;
                scheduleStallDeadline(next, lifecycleGeneration.get(), STALL_TIMEOUT_MS);
                new Thread(() -> captureLoop(next), "rabi-phone-continuous-audio").start();
                persistRuntime(true, reason);
                listener.onStatus(restartCount == 0
                        ? "手机持续聆听中 · 点通知可返回"
                        : "手机持续聆听已恢复 · 自动恢复 " + restartCount + " 次");
            } catch (Throwable error) {
                scheduleRestart("audio_start_" + error.getClass().getSimpleName());
            }
        }
    }

    private void captureLoop(AudioRecord source) {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);
        byte[] buffer = new byte[BUFFER_BYTES];
        String exitReason = "audio_capture_ended";
        try {
            while (requested && recorder == source) {
                int read = source.read(buffer, 0, buffer.length);
                if (read <= 0) {
                    exitReason = "audio_read_" + read;
                    break;
                }
                long now = SystemClock.elapsedRealtime();
                lastReadElapsed = now;
                totalBytes += read;
                if (now - healthySinceElapsed >= HEALTHY_RESET_MS) consecutiveRestarts = 0;
                if (now - lastMetricPersistElapsed >= METRIC_PERSIST_INTERVAL_MS) {
                    lastMetricPersistElapsed = now;
                    persistRuntime(true, "capturing");
                }
                if (playbackSuppressed) {
                    listener.onPlaybackSuppressed();
                    continue;
                }
                byte[] chunk = new byte[read];
                System.arraycopy(buffer, 0, chunk, 0, read);
                listener.onPcm(chunk);
            }
        } catch (Throwable error) {
            exitReason = "audio_read_" + error.getClass().getSimpleName();
        }
        if (requested && recorder == source) scheduleRestart(exitReason);
    }

    private void scheduleStallDeadline(AudioRecord source, int generation, long delayMs) {
        cancelStallDeadline();
        stallDeadline = supervisor.schedule(
                () -> checkStallDeadline(source, generation),
                Math.max(1L, delayMs),
                TimeUnit.MILLISECONDS);
    }

    private void checkStallDeadline(AudioRecord source, int generation) {
        if (closed || !requested || generation != lifecycleGeneration.get() || recorder != source) return;
        ensureWakeLock();
        long silence = SystemClock.elapsedRealtime() - lastReadElapsed;
        if (silence >= STALL_TIMEOUT_MS) {
            scheduleRestart("audio_read_stalled");
            return;
        }
        scheduleStallDeadline(source, generation, STALL_TIMEOUT_MS - silence);
    }

    private void cancelStallDeadline() {
        ScheduledFuture<?> current = stallDeadline;
        stallDeadline = null;
        if (current != null) current.cancel(false);
    }

    private void scheduleRestart(String reason) {
        if (closed || !requested || !restartScheduled.compareAndSet(false, true)) return;
        consecutiveRestarts += 1;
        restartCount += 1;
        long delay = Math.min(MAX_RESTART_DELAY_MS, 1_000L << Math.min(5, consecutiveRestarts - 1));
        persistRuntime(false, reason);
        listener.onDiagnostic("conversation.audio.restart", "warning", reason);
        listener.onStatus("手机录音异常 · " + (delay / 1000L) + " 秒后自动恢复");
        int scheduledGeneration = lifecycleGeneration.get();
        supervisor.schedule(() -> {
            if (closed || !requested || scheduledGeneration != lifecycleGeneration.get()) return;
            restartScheduled.set(false);
            stopRecorder();
            startRecorder("automatic_restart");
        }, delay, TimeUnit.MILLISECONDS);
    }

    private void stopRecorder() {
        cancelStallDeadline();
        AudioRecord current;
        synchronized (recorderLock) {
            current = recorder;
            recorder = null;
        }
        if (current != null) {
            try { current.stop(); } catch (Throwable ignored) { }
            try { current.release(); } catch (Throwable ignored) { }
        }
    }

    private void acquireWakeLock() {
        PowerManager manager = context.getSystemService(PowerManager.class);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG);
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void ensureWakeLock() {
        if (wakeLock == null || !wakeLock.isHeld()) acquireWakeLock();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private void fail(String reason, String status) {
        requested = false;
        persistRuntime(false, reason);
        releaseWakeLock();
        listener.onDiagnostic("conversation.audio.failed", "error", reason);
        listener.onStatus(status);
    }

    private void persistRuntime(boolean active, String state) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        SharedPreferences.Editor editor = values.edit()
                .putBoolean("active", active)
                .putString("state", state)
                .putLong("updatedAt", now)
                .putLong("lastSampleAt", lastReadElapsed == 0L ? 0L
                        : now - Math.max(0L, SystemClock.elapsedRealtime() - lastReadElapsed))
                .putLong("totalBytes", totalBytes)
                .putInt("restartCount", restartCount);
        if (values.getLong("startedAt", 0L) == 0L || "stopped".equals(values.getString("state", ""))) {
            editor.putLong("startedAt", now);
        }
        editor.apply();
    }

    public static String runtimeSummary(Context context) {
        SharedPreferences values = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long startedAt = values.getLong("startedAt", 0L);
        long lastSampleAt = values.getLong("lastSampleAt", 0L);
        long durationMs = startedAt == 0L ? 0L : Math.max(0L, System.currentTimeMillis() - startedAt);
        long sampleAgeMs = lastSampleAt == 0L ? -1L : Math.max(0L, System.currentTimeMillis() - lastSampleAt);
        long bytes = values.getLong("totalBytes", 0L);
        int restarts = values.getInt("restartCount", 0);
        String state = values.getString("state", "尚无采集记录");
        return String.format(Locale.US, "采集 %s · 最近音频 %s · %.1f MiB · 自动恢复 %d 次 · %s",
                formatDuration(durationMs), sampleAgeMs < 0L ? "无" : formatDuration(sampleAgeMs) + "前",
                bytes / 1048576.0, restarts, state);
    }

    private static String formatDuration(long valueMs) {
        long totalSeconds = Math.max(0L, valueMs / 1000L);
        long hours = totalSeconds / 3600L;
        long minutes = (totalSeconds % 3600L) / 60L;
        long seconds = totalSeconds % 60L;
        if (hours > 0L) return hours + "小时" + minutes + "分";
        if (minutes > 0L) return minutes + "分" + seconds + "秒";
        return seconds + "秒";
    }
}
