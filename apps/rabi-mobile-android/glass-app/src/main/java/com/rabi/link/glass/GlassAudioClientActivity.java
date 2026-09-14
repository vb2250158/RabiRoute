package com.rabi.link.glass;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.rokid.security.glass3.open.sdk.GlassSdk;
import com.rokid.security.glass3.open.sdk.client.IServiceConnectionCallback;
import com.rokid.security.system.server.IClientCallback;
import com.rokid.security.system.server.media.callback.AudioCallback;
import com.rokid.security.system.server.message.callback.IResultCallback;
import com.rokid.security.system.server.message.listener.IMessageListener;
import com.rabi.link.protocol.RabiGlassAudioProtocol;
import com.rabi.link.protocol.RabiGlassPlaybackSession;

import org.json.JSONObject;

import java.util.ArrayList;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Thin glasses frontend. It captures and plays PCM only; the phone owns transport/state and
 * the selected Rabi PC owns ASR, TTS, Agent context, and action policy.
 */
public final class GlassAudioClientActivity extends Activity {
    private static final int REQUEST_AUDIO = 9011;
    private static final long NAV_DEBOUNCE_MS = 260;
    private static final long PLAYBACK_RESUME_BASE_MS = 900;
    private static final long PLAYBACK_COMPLETION_GRACE_MS = 15000;

    private final List<Button> buttons = new ArrayList<>();
    private HorizontalScrollView actionScroll;
    private TextView stateView;
    private TextView statusView;
    private TextView transcriptView;
    private TextView replyView;
    private TextView timeView;
    private TextView deviceView;
    private Button pauseButton;
    private HudState hudState = HudState.CONNECTING;
    private final Object playbackTrackLock = new Object();
    private AudioTrack playback;
    private boolean sdkReady;
    private boolean recording;
    private boolean userPaused;
    private boolean playbackActive;
    private int selectedIndex;
    private long lastNavigationAt;
    private int reconnectAttempt;
    private volatile boolean destroyed;
    private int playbackGeneration;
    private String lastPlaybackReceiptMessageId = "";
    private String lastPlaybackReceiptState = "";
    private float touchStartX;
    private float touchStartY;
    private final RabiGlassPlaybackSession playbackSession = new RabiGlassPlaybackSession();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private HandlerThread playbackThread;
    private Handler playbackHandler;
    private final Runnable reconnectPhone = new Runnable() {
        @Override public void run() {
            if (destroyed || sdkReady) return;
            bindGlassSdk();
            scheduleReconnect();
        }
    };
    private final Runnable clockTick = new Runnable() {
        @Override public void run() {
            if (destroyed) return;
            if (timeView != null) timeView.setText(new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date()));
            mainHandler.postDelayed(this, 30000);
        }
    };
    private final Runnable resumeAfterPlayback = () -> {
        if (destroyed) return;
        playbackActive = false;
        refreshHud();
        if (!userPaused) startCapture(true);
    };
    private final Runnable playbackCompletionDeadline = () -> {
        if (!playbackSession.isActive()) return;
        playbackSession.fail();
        finishFramedPlayback("playback_failed", "眼镜扬声器播放完成超时");
    };

    private enum HudState {
        CONNECTING("连接", Color.rgb(105, 170, 255)),
        LISTENING("聆听", Color.rgb(61, 220, 151)),
        UPLOADING("上传", Color.rgb(246, 194, 91)),
        PLAYING("播报", Color.rgb(176, 132, 255)),
        PAUSED("暂停", Color.rgb(160, 168, 174)),
        ERROR("异常", Color.rgb(255, 116, 116));

        final String label;
        final int color;

        HudState(String label, int color) {
            this.label = label;
            this.color = color;
        }
    }

    private final IClientCallback clientCallback = new IClientCallback.Stub() {
        @Override
        public void onReady() {
            sdkReady = true;
            reconnectAttempt = 0;
            mainHandler.removeCallbacks(reconnectPhone);
            runOnUiThread(() -> {
                registerMessageListener();
                setStatus(HudState.CONNECTING, "手机后端已连接 · 正在启动持续聆听");
                startCapture(true);
            });
        }
    };

    private final IMessageListener messageListener = new IMessageListener.Stub() {
        @Override
        public void onTextMessage(String message) {
            String text = message == null ? "" : message.trim();
            if (text.startsWith(RabiGlassAudioProtocol.PREFIX_PLAYBACK_BEGIN)) {
                JSONObject payload = parsePlaybackPayload(text, RabiGlassAudioProtocol.PREFIX_PLAYBACK_BEGIN);
                postPlayback(() -> handlePlaybackBegin(payload));
            }
            else if (text.startsWith(RabiGlassAudioProtocol.PREFIX_PLAYBACK_END)) {
                JSONObject payload = parsePlaybackPayload(text, RabiGlassAudioProtocol.PREFIX_PLAYBACK_END);
                postPlayback(() -> handlePlaybackEnd(payload));
            }
            else if (text.startsWith(RabiGlassAudioProtocol.PREFIX_STATUS)) runOnUiThread(() -> setStatus(text.substring(RabiGlassAudioProtocol.PREFIX_STATUS.length())));
            else if (text.startsWith(RabiGlassAudioProtocol.PREFIX_TRANSCRIPT)) runOnUiThread(() -> transcriptView.setText(text.substring(RabiGlassAudioProtocol.PREFIX_TRANSCRIPT.length())));
            else if (text.startsWith(RabiGlassAudioProtocol.PREFIX_REPLY)) runOnUiThread(() -> replyView.setText(text.substring(RabiGlassAudioProtocol.PREFIX_REPLY.length())));
            else if (text.startsWith(RabiGlassAudioProtocol.PREFIX_DEVICE)) runOnUiThread(() -> updateDeviceState(text.substring(RabiGlassAudioProtocol.PREFIX_DEVICE.length())));
        }

        @Override
        public void onAudioStream(byte[] buffer) {
            if (buffer == null || buffer.length == 0) return;
            byte[] copy = buffer.clone();
            postPlayback(() -> handlePlaybackPcm(copy));
        }

        @Override
        public void onStreamDataReceived(String tag, byte[] data) {
        }
    };

    private final AudioCallback captureCallback = new AudioCallback.Stub() {
        @Override
        public String getCallbackId() {
            return RabiGlassAudioProtocol.CLIENT_ID + ":capture";
        }

        @Override
        public void onAudioStream(byte[] buffer, int bufferLength) {
            if (!recording || buffer == null || bufferLength <= 0 || !sdkReady) return;
            int length = Math.min(bufferLength, buffer.length);
            byte[] chunk = length == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, length);
            try {
                if (GlassSdk.getGlassMessageService() != null) {
                    GlassSdk.getGlassMessageService().sendStreamData(RabiGlassAudioProtocol.AUDIO_STREAM_TAG, chunk, RabiGlassAudioProtocol.CLIENT_ID, new IResultCallback.Stub() {
                        @Override public void onSuccess(boolean result) { }
                        @Override public void onFailed(int code, String message) {
                            runOnUiThread(() -> setStatus(HudState.ERROR, "音频发往手机失败: " + code));
                        }
                    });
                }
            } catch (Throwable error) {
                runOnUiThread(() -> setStatus(HudState.ERROR, "手机音频链路中断"));
            }
        }
    };

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prepareWindow();
        setContentView(buildUi());
        playbackThread = new HandlerThread("rabi-glass-playback");
        playbackThread.start();
        playbackHandler = new Handler(playbackThread.getLooper());
        preparePlayback();
        bindGlassSdk();
        scheduleReconnect();
        mainHandler.post(clockTick);
    }

    @Override protected void onResume() { super.onResume(); prepareWindow(); }
    @Override public void onWindowFocusChanged(boolean focus) { super.onWindowFocusChanged(focus); if (focus) prepareWindow(); }

    @Override
    protected void onDestroy() {
        String terminalMessageId;
        String terminalState;
        String terminalFailure;
        synchronized (this) {
            terminalMessageId = playbackSession.messageId();
            if (playbackSession.state() == RabiGlassPlaybackSession.State.PLAYED) {
                terminalState = "played";
                terminalFailure = "";
            } else if (!terminalMessageId.isEmpty()) {
                playbackSession.fail();
                terminalState = "playback_failed";
                terminalFailure = "眼镜播放界面已关闭";
            } else {
                terminalState = "";
                terminalFailure = "";
            }
            destroyed = true;
        }
        if (!terminalMessageId.isEmpty() && !terminalState.isEmpty()) {
            sendPhonePlaybackReceipt(terminalMessageId, terminalState, terminalFailure);
        }
        userPaused = true;
        mainHandler.removeCallbacks(reconnectPhone);
        mainHandler.removeCallbacks(resumeAfterPlayback);
        mainHandler.removeCallbacks(clockTick);
        stopCapture(true);
        Handler playbackQueue = playbackHandler;
        if (playbackQueue != null) playbackQueue.removeCallbacksAndMessages(null);
        playbackGeneration += 1;
        synchronized (playbackTrackLock) {
            if (playback != null) {
                try { playback.stop(); } catch (Throwable ignored) { }
                playback.release();
                playback = null;
            }
        }
        if (playbackThread != null) playbackThread.quitSafely();
        playbackHandler = null;
        playbackThread = null;
        super.onDestroy();
    }

    private void bindGlassSdk() {
        try {
            if (GlassSdk.isReady()) {
                GlassSdk.registerClient(RabiGlassAudioProtocol.CLIENT_ID, clientCallback);
                return;
            }
            GlassSdk.bindSecurityService(getApplicationContext(), new IServiceConnectionCallback() {
                @Override public void onServiceConnected() { GlassSdk.registerClient(RabiGlassAudioProtocol.CLIENT_ID, clientCallback); }
                @Override public void onServiceDisconnected() { sdkReady = false; recording = false; runOnUiThread(() -> { setStatus(HudState.CONNECTING, "手机后端已断开 · 自动重连中"); scheduleReconnect(); }); }
                @Override public void onBindingDied() { sdkReady = false; recording = false; runOnUiThread(() -> { setStatus(HudState.CONNECTING, "眼镜消息服务已停止 · 自动重连中"); scheduleReconnect(); }); }
            });
        } catch (Throwable error) {
            setStatus(HudState.CONNECTING, "眼镜消息服务不可用 · 自动重连中");
            scheduleReconnect();
        }
    }

    private void scheduleReconnect() {
        if (destroyed || sdkReady) return;
        mainHandler.removeCallbacks(reconnectPhone);
        long delay = Math.min(30000L, 1500L << Math.min(4, reconnectAttempt++));
        mainHandler.postDelayed(reconnectPhone, delay);
    }

    private void registerMessageListener() {
        try {
            if (GlassSdk.getGlassMessageService() != null) GlassSdk.getGlassMessageService().setMessageListener(messageListener);
        } catch (Throwable error) {
            setStatus(HudState.ERROR, "手机消息监听不可用");
        }
    }

    private void toggleCapture() {
        userPaused = !userPaused;
        if (userPaused) {
            stopCapture(true);
            setStatus(HudState.PAUSED, "已暂停持续聆听 · 再按继续");
        } else {
            startCapture(true);
        }
    }

    private void startCapture(boolean notifyPhone) {
        if (recording || userPaused || playbackActive) return;
        if (!sdkReady) { setStatus(HudState.CONNECTING, "等待手机后端连接"); return; }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
            return;
        }
        try {
            if (GlassSdk.getGlassMediaService() == null) throw new IllegalStateException("media service unavailable");
            if (notifyPhone) sendPhoneText(RabiGlassAudioProtocol.COMMAND_START);
            GlassSdk.getGlassMediaService().startAudioRecord(captureCallback);
            recording = true;
            setStatus(HudState.LISTENING, "持续聆听中 · 单击可提示 Rabi");
        } catch (Throwable error) {
            setStatus(HudState.ERROR, "录音启动失败");
        }
    }

    private void stopCapture(boolean notifyPhone) {
        if (!recording) return;
        recording = false;
        try { if (GlassSdk.getGlassMediaService() != null) GlassSdk.getGlassMediaService().stopAudioRecord(captureCallback); } catch (Throwable ignored) { }
        if (notifyPhone) {
            sendPhoneText(RabiGlassAudioProtocol.COMMAND_STOP);
            setStatus(HudState.UPLOADING, "手机上传中 · Rabi PC 识别中");
        }
    }

    private void pauseCaptureForPlayback() {
        playbackActive = true;
        mainHandler.removeCallbacks(resumeAfterPlayback);
        if (recording) stopCapture(true);
        setStatus(HudState.PLAYING, "Rabi 正在说话");
    }

    private long playbackResumeDelayMs(int bytes) {
        return PLAYBACK_RESUME_BASE_MS + Math.max(300L, bytes * 1000L / 32000L);
    }

    private JSONObject parsePlaybackPayload(String text, String prefix) {
        try { return new JSONObject(text.substring(prefix.length())); }
        catch (Throwable ignored) { return null; }
    }

    private void postPlayback(Runnable action) {
        Handler target = playbackHandler;
        if (destroyed || target == null) return;
        target.post(action);
    }

    private void handlePlaybackBegin(JSONObject payload) {
        String messageId = payload == null ? "" : payload.optString("messageId", "").trim();
        int bytes = payload == null ? 0 : payload.optInt("bytes", 0);
        try {
            boolean started = playbackSession.begin(messageId, bytes);
            if (!started) {
                RabiGlassPlaybackSession.State state = playbackSession.state();
                if (state == RabiGlassPlaybackSession.State.PLAYED) sendPhonePlaybackReceipt(messageId, "played", "");
                else if (state == RabiGlassPlaybackSession.State.PLAYBACK_FAILED) sendPhonePlaybackReceipt(messageId, "playback_failed", "重复播放请求此前已失败");
                return;
            }
            int markerFrames = bytes / 2;
            if (markerFrames <= 0) throw new IllegalArgumentException("invalid playback frame count");
            if (!pauseCaptureForPlaybackAndWait()) {
                throw new IllegalStateException("unable to pause capture before playback");
            }
            replacePlaybackTrack(markerFrames);
            Handler target = playbackHandler;
            if (target != null) {
                target.removeCallbacks(playbackCompletionDeadline);
                target.postDelayed(playbackCompletionDeadline,
                        PLAYBACK_COMPLETION_GRACE_MS + Math.max(1000L, bytes * 1000L / 32000L));
            }
        } catch (Throwable error) {
            boolean failedCurrent = !messageId.isEmpty()
                    && messageId.equals(playbackSession.messageId())
                    && playbackSession.isActive();
            if (failedCurrent) {
                playbackSession.fail();
                finishFramedPlayback("playback_failed", "播放请求无效");
            } else if (!messageId.isEmpty()) {
                sendPhonePlaybackReceipt(messageId, "playback_failed", "播放请求无效");
            }
        }
    }

    private void handlePlaybackPcm(byte[] buffer) {
        if (!playbackSession.knowsMessage()) {
            if (!pauseCaptureForPlaybackAndWait()) return;
            writePlayback(buffer);
            mainHandler.removeCallbacks(resumeAfterPlayback);
            mainHandler.postDelayed(resumeAfterPlayback, playbackResumeDelayMs(buffer.length));
            return;
        }
        if (playbackSession.state() != RabiGlassPlaybackSession.State.RECEIVING) return;
        if (!playbackSession.acceptPcm(buffer.length)) return;
        if (playbackSession.state() == RabiGlassPlaybackSession.State.PLAYBACK_FAILED) {
            finishFramedPlayback("playback_failed", "收到的 PCM 超出声明长度");
            return;
        }
        int written = writePlayback(buffer);
        if (written != buffer.length) {
            playbackSession.fail();
            finishFramedPlayback("playback_failed", "眼镜扬声器写入失败");
        }
    }

    private void handlePlaybackEnd(JSONObject payload) {
        String messageId = payload == null ? "" : payload.optString("messageId", "").trim();
        int bytes = payload == null ? 0 : payload.optInt("bytes", 0);
        RabiGlassPlaybackSession.State state = playbackSession.end(messageId, bytes);
        if (state == RabiGlassPlaybackSession.State.PLAYED) finishFramedPlayback("played", "");
        else if (state == RabiGlassPlaybackSession.State.PLAYBACK_FAILED) {
            finishFramedPlayback("playback_failed", "播放消息或 PCM 长度不匹配");
        }
    }

    private int writePlayback(byte[] buffer) {
        synchronized (playbackTrackLock) {
            AudioTrack target = playback;
            if (destroyed || target == null || target.getState() != AudioTrack.STATE_INITIALIZED) return AudioTrack.ERROR_INVALID_OPERATION;
            try { return target.write(buffer, 0, buffer.length, AudioTrack.WRITE_BLOCKING); }
            catch (Throwable ignored) { return AudioTrack.ERROR_INVALID_OPERATION; }
        }
    }

    private void replacePlaybackTrack(int markerFrames) {
        synchronized (playbackTrackLock) {
            if (destroyed) throw new IllegalStateException("activity destroyed");
            playbackGeneration += 1;
            AudioTrack previous = playback;
            playback = null;
            if (previous != null) {
                try { previous.pause(); } catch (Throwable ignored) { }
                try { previous.flush(); } catch (Throwable ignored) { }
                try { previous.stop(); } catch (Throwable ignored) { }
                previous.release();
            }
            playback = createPlaybackTrack(playbackGeneration, markerFrames);
        }
    }

    private AudioTrack createPlaybackTrack(int generation, int markerFrames) {
        int minimum = AudioTrack.getMinBufferSize(16000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioTrack created = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_ACCESSIBILITY).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(16000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(minimum * 2, 8192))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
        created.setPlaybackPositionUpdateListener(new AudioTrack.OnPlaybackPositionUpdateListener() {
            @Override public void onMarkerReached(AudioTrack track) {
                synchronized (playbackTrackLock) {
                    if (destroyed || generation != playbackGeneration || track != playback) return;
                }
                RabiGlassPlaybackSession.State state = playbackSession.markerReached();
                if (state == RabiGlassPlaybackSession.State.PLAYED) finishFramedPlayback("played", "");
            }
            @Override public void onPeriodicNotification(AudioTrack track) { }
        }, playbackHandler);
        if (markerFrames > 0 && created.setNotificationMarkerPosition(markerFrames) != AudioTrack.SUCCESS) {
            created.release();
            throw new IllegalStateException("unable to set playback marker");
        }
        created.play();
        return created;
    }

    private synchronized void finishFramedPlayback(String state, String failure) {
        if (destroyed) return;
        Handler target = playbackHandler;
        if (target != null) target.removeCallbacks(playbackCompletionDeadline);
        String messageId = playbackSession.messageId();
        if (!messageId.isEmpty()) sendPhonePlaybackReceipt(messageId, state, failure);
        runOnUiThread(() -> {
            if (!playbackActive) return;
            playbackActive = false;
            setStatus(userPaused ? HudState.PAUSED : HudState.LISTENING,
                    "played".equals(state) ? "Rabi 播报完成" : "Rabi 播报失败 · 已恢复聆听");
            if (!userPaused) startCapture(true);
        });
    }

    private void sendPhoneText(String text) {
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().sendTextMessageByClassicBT(text);
                GlassSdk.getGlassMessageService().sendTextMessageByP2P(text);
            }
        } catch (Throwable error) {
            setStatus(HudState.ERROR, "发送手机控制失败");
        }
    }

    private synchronized void sendPhonePlaybackReceipt(String messageId, String state, String failure) {
        String normalizedMessageId = messageId == null ? "" : messageId.trim();
        String normalizedState = state == null ? "" : state.trim();
        if (normalizedMessageId.isEmpty() || normalizedState.isEmpty()) return;
        if (normalizedMessageId.equals(lastPlaybackReceiptMessageId)
                && normalizedState.equals(lastPlaybackReceiptState)) return;
        try {
            JSONObject payload = new JSONObject().put("messageId", normalizedMessageId).put("state", normalizedState);
            if (failure != null && !failure.trim().isEmpty()) payload.put("failure", failure.trim());
            if (GlassSdk.getGlassMessageService() == null) throw new IllegalStateException("message service unavailable");
            GlassSdk.getGlassMessageService().sendTextMessageByClassicBT(
                    RabiGlassAudioProtocol.PREFIX_PLAYBACK_RECEIPT + payload.toString());
            lastPlaybackReceiptMessageId = normalizedMessageId;
            lastPlaybackReceiptState = normalizedState;
        } catch (Throwable error) {
            if (!destroyed) runOnUiThread(() -> setStatus(HudState.ERROR, "播放回执发送失败"));
        }
    }

    private void preparePlayback() {
        synchronized (playbackTrackLock) {
            playback = createPlaybackTrack(playbackGeneration, 0);
        }
    }

    private boolean pauseCaptureForPlaybackAndWait() {
        if (destroyed) return false;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            pauseCaptureForPlayback();
            return true;
        }
        CountDownLatch completed = new CountDownLatch(1);
        AtomicBoolean paused = new AtomicBoolean();
        mainHandler.post(() -> {
            try {
                if (!destroyed) {
                    pauseCaptureForPlayback();
                    paused.set(true);
                }
            } finally {
                completed.countDown();
            }
        });
        try {
            return completed.await(2, TimeUnit.SECONDS) && paused.get();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == REQUEST_AUDIO && results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) startCapture(true);
        else if (requestCode == REQUEST_AUDIO) setStatus(HudState.ERROR, "需要麦克风权限");
    }

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(24), dp(10), dp(24), dp(22));
        root.setBackgroundColor(Color.BLACK);
        TextView title = new TextView(this);
        title.setText("Rabi Glass"); title.setTextColor(Color.rgb(61, 220, 151)); title.setTextSize(18); title.setGravity(Gravity.CENTER);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));
        stateView = hudLine(HudState.CONNECTING.label);
        stateView.setTextColor(HudState.CONNECTING.color);
        stateView.setBackground(stateBackground(HudState.CONNECTING));
        LinearLayout.LayoutParams stateParams = new LinearLayout.LayoutParams(dp(76), dp(28)); stateParams.gravity = Gravity.CENTER_HORIZONTAL; stateParams.setMargins(0, dp(6), 0, 0); root.addView(stateView, stateParams);
        statusView = new TextView(this);
        statusView.setText("连接手机后端中"); statusView.setTextColor(Color.WHITE); statusView.setTextSize(14); statusView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams statusParams = new LinearLayout.LayoutParams(-1, -2); statusParams.setMargins(0, dp(4), 0, dp(12)); root.addView(statusView, statusParams);
        transcriptView = hudLine("等待语音");
        replyView = hudLine("Rabi 回复会显示在这里");
        root.addView(transcriptView, new LinearLayout.LayoutParams(-1, dp(28)));
        root.addView(replyView, new LinearLayout.LayoutParams(-1, dp(28)));
        LinearLayout footer = new LinearLayout(this);
        footer.setOrientation(LinearLayout.HORIZONTAL);
        footer.setGravity(Gravity.CENTER_VERTICAL);
        timeView = new TextView(this);
        timeView.setTextColor(Color.rgb(61, 220, 151)); timeView.setTextSize(12); timeView.setGravity(Gravity.START);
        deviceView = new TextView(this);
        deviceView.setText("v" + versionName() + " · --"); deviceView.setTextColor(Color.rgb(150, 160, 166)); deviceView.setTextSize(11); deviceView.setGravity(Gravity.END);
        footer.addView(timeView, new LinearLayout.LayoutParams(0, dp(24), 1f));
        footer.addView(deviceView, new LinearLayout.LayoutParams(0, dp(24), 1f));
        root.addView(footer, new LinearLayout.LayoutParams(-1, dp(24)));
        actionScroll = new HorizontalScrollView(this); actionScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout row = new LinearLayout(this); row.setOrientation(LinearLayout.HORIZONTAL); actionScroll.addView(row, new HorizontalScrollView.LayoutParams(-2, -2));
        addButton(row, "立即推送", () -> {
            sendPhoneText(RabiGlassAudioProtocol.COMMAND_REVIEW);
            setStatus(HudState.UPLOADING, "正在提醒 Rabi 审阅最近记录");
        });
        pauseButton = addButton(row, "暂停 / 继续", this::toggleCapture);
        addButton(row, "重连手机", this::bindGlassSdk);
        addButton(row, "状态", () -> sendPhoneText(RabiGlassAudioProtocol.COMMAND_STATUS_REQUEST));
        root.addView(actionScroll, new LinearLayout.LayoutParams(-1, dp(62)));
        root.setOnTouchListener((view, event) -> onTouch(event));
        root.post(() -> select(0));
        return root;
    }

    private Button addButton(LinearLayout row, String label, Runnable action) {
        Button button = new Button(this); button.setAllCaps(false); button.setText("  " + label); button.setTextColor(Color.WHITE); button.setTextSize(14); button.setSingleLine(true); button.setBackground(buttonBackground(false)); button.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(150), dp(48)); params.setMargins(dp(6), dp(6), dp(6), dp(6)); row.addView(button, params); buttons.add(button);
        return button;
    }

    private TextView hudLine(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.WHITE);
        view.setTextSize(13);
        view.setSingleLine(true);
        view.setEllipsize(TextUtils.TruncateAt.END);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private void updateDeviceState(String value) {
        String[] parts = value.split(":", 2);
        String battery = parts.length > 0 ? parts[0] : "--";
        boolean charging = parts.length > 1 && "1".equals(parts[1]);
        boolean hasBattery = battery.matches("\\d{1,3}");
        deviceView.setText("v" + versionName() + " · " + (hasBattery ? battery + "%" : "--") + (hasBattery && charging ? " charging" : ""));
    }

    private String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; }
        catch (Throwable ignored) { return "0.2"; }
    }

    private boolean onTouch(MotionEvent event) {
        if (event.getAction() == MotionEvent.ACTION_DOWN) { touchStartX = event.getX(); touchStartY = event.getY(); return true; }
        if (event.getAction() == MotionEvent.ACTION_MOVE) return true;
        if (event.getAction() != MotionEvent.ACTION_UP) return true;
        float dx = event.getX() - touchStartX, dy = event.getY() - touchStartY;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < dp(28)) confirm(); else navigate(Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 1 : -1) : (dy < 0 ? 1 : -1));
        return true;
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() != KeyEvent.ACTION_UP) return true;
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_LEFT || event.getKeyCode() == KeyEvent.KEYCODE_DPAD_UP) { navigate(-1); return true; }
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_RIGHT || event.getKeyCode() == KeyEvent.KEYCODE_DPAD_DOWN) { navigate(1); return true; }
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER || event.getKeyCode() == KeyEvent.KEYCODE_ENTER) { confirm(); return true; }
        return super.dispatchKeyEvent(event);
    }

    private void navigate(int direction) { long now = SystemClock.elapsedRealtime(); if (now - lastNavigationAt < NAV_DEBOUNCE_MS) return; lastNavigationAt = now; select((selectedIndex + direction + buttons.size()) % buttons.size()); }
    private void confirm() { if (!buttons.isEmpty()) buttons.get(selectedIndex).performClick(); }
    private void select(int index) { selectedIndex = index; for (int i = 0; i < buttons.size(); i++) { Button b = buttons.get(i); String label = b.getText().toString().replaceFirst("^> ", "").trim(); boolean focused = i == index; b.setText(focused ? "> " + label : "  " + label); b.setScaleX(focused ? 1.12f : 1f); b.setScaleY(focused ? 1.12f : 1f); b.setBackground(buttonBackground(focused)); } Button b = buttons.get(index); actionScroll.post(() -> actionScroll.smoothScrollTo(b.getLeft() + b.getWidth() / 2 - actionScroll.getWidth() / 2, 0)); }
    private GradientDrawable buttonBackground(boolean focused) { GradientDrawable d = new GradientDrawable(); d.setColor(Color.BLACK); d.setCornerRadius(dp(8)); d.setStroke(dp(focused ? 2 : 1), focused ? Color.rgb(61, 220, 151) : Color.rgb(105, 115, 120)); return d; }
    private GradientDrawable stateBackground(HudState state) { GradientDrawable d = new GradientDrawable(); d.setColor(Color.argb(38, Color.red(state.color), Color.green(state.color), Color.blue(state.color))); d.setCornerRadius(dp(14)); d.setStroke(dp(1), state.color); return d; }
    private void setStatus(String text) { setStatus(inferState(), text); }
    private void setStatus(HudState state, String text) { hudState = state; if (statusView != null) statusView.setText(text); refreshHud(); }
    private HudState inferState() { if (playbackActive) return HudState.PLAYING; if (userPaused) return HudState.PAUSED; if (!sdkReady) return HudState.CONNECTING; return recording ? HudState.LISTENING : HudState.UPLOADING; }
    private void refreshHud() { if (stateView != null) { stateView.setText(hudState.label); stateView.setTextColor(hudState.color); stateView.setBackground(stateBackground(hudState)); } if (pauseButton != null) pauseButton.setText(userPaused ? "  继续聆听" : "  暂停聆听"); }
    private void prepareWindow() { getWindow().setStatusBarColor(Color.BLACK); getWindow().setNavigationBarColor(Color.BLACK); getWindow().getDecorView().setBackgroundColor(Color.BLACK); getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN); getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
