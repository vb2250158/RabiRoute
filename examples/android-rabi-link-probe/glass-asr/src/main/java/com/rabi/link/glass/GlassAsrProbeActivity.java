package com.rabi.link.glass;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.rokid.cxr.CXRServiceBridge;
import com.rokid.cxr.Caps;
import com.rokid.security.glass3.open.sdk.GlassSdk;
import com.rokid.security.glass3.open.sdk.client.IServiceConnectionCallback;
import com.rokid.security.glass3.sdk.base.data.offlineCmd.bean.VoiceAction;
import com.rokid.security.glass3.sdk.base.data.offlineCmd.listener.IVoiceCallback;
import com.rokid.security.system.server.IClientCallback;
import com.rokid.security.system.server.asr.listener.SpeechCallback;
import com.rokid.security.system.server.message.listener.IMessageListener;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class GlassAsrProbeActivity extends Activity {
    private static final String TAG = "RabiGlassAsr";
    private static final float FOCUSED_BUTTON_SCALE = 1.10f;
    private static final long ACTION_NAVIGATION_DEBOUNCE_MS = 260L;
    private static final long ACTION_NAVIGATION_KEY_LOCK_MS = 700L;
    // Rokid AR display treats black pixels as optically transparent; Android window transparency reveals the launcher.
    private static final int GLASS_BACKGROUND_COLOR = Color.BLACK;
    private static final int REQUEST_RECORD_AUDIO = 8101;
    private static final String CLIENT_ID = "GlassSample";
    private static final String CUSTOM_CMD_CLIENT_KEY = "rabi_native_voice_client";
    private static final String CUSTOM_CMD_REPLY_KEY = "rabi_native_voice_reply";
    private static final String ASR_PREFIX = "RABI_ASR:";
    private static final String ASR_ERR_PREFIX = "RABI_ASR_ERR:";
    private static final String TTS_PREFIX = "RABI_TTS:";
    private static final String TTS_ACK_PREFIX = "RABI_TTS_OK:";
    private static final String TTS_ERR_PREFIX = "RABI_TTS_ERR:";
    private static final String PING_CMD = "RABI_PING";
    private static final String STATUS_CMD = "RABI_STATUS";
    private static final String DIAG_CMD = "RABI_DIAG";
    private static final String STATUS_PREFIX = "RABI_STATUS:";
    private static final String ASR_START_CMD = "RABI_ASR_START";
    private static final String ASR_STOP_CMD = "RABI_ASR_STOP";
    private static final String PONG_PREFIX = "RABI_PONG:";
    private static final String ASR_START_ACK_PREFIX = "RABI_ASR_START_OK:";
    private static final String ASR_START_ERR_PREFIX = "RABI_ASR_START_ERR:";
    private static final String ASR_STOP_ACK_PREFIX = "RABI_ASR_STOP_OK:";
    private static final String ASR_STOP_ERR_PREFIX = "RABI_ASR_STOP_ERR:";
    private static final String OFFLINE_ARM_CMD = "RABI_OFFLINE_CMD_ARM";
    private static final String OFFLINE_CLEAR_CMD = "RABI_OFFLINE_CMD_CLEAR";
    private static final String OFFLINE_STATUS_PREFIX = "RABI_OFFLINE_CMD_STATUS:";
    private static final String OFFLINE_TRIGGER_PREFIX = "RABI_OFFLINE_CMD:";
    private static final String OFFLINE_ERR_PREFIX = "RABI_OFFLINE_CMD_ERR:";
    private static final String ANDROID_VOICE_PROBE_CMD = "RABI_GLASS_ANDROID_VOICE_PROBE";
    private static final String ANDROID_ASR_START_CMD = "RABI_GLASS_ANDROID_ASR_START";
    private static final String ANDROID_ASR_STOP_CMD = "RABI_GLASS_ANDROID_ASR_STOP";
    private static final String ANDROID_TTS_PREFIX = "RABI_GLASS_ANDROID_TTS:";
    private static final String ANDROID_STATUS_PREFIX = "RABI_GLASS_ANDROID_STATUS:";
    private static final String ANDROID_ASR_PREFIX = "RABI_GLASS_ANDROID_ASR:";
    private static final String ANDROID_ASR_PARTIAL_PREFIX = "RABI_GLASS_ANDROID_ASR_PARTIAL:";
    private static final String ANDROID_ASR_START_ACK_PREFIX = "RABI_GLASS_ANDROID_ASR_START_OK:";
    private static final String ANDROID_ASR_STOP_ACK_PREFIX = "RABI_GLASS_ANDROID_ASR_STOP_OK:";
    private static final String ANDROID_TTS_ACK_PREFIX = "RABI_GLASS_ANDROID_TTS_OK:";
    private static final String ANDROID_ERR_PREFIX = "RABI_GLASS_ANDROID_ERR:";
    private static final String GLASS_ROKID_AI_PROBE_CMD = "RABI_GLASS_ROKID_AI_PROBE";
    private static final String GLASS_ROKID_AI_START_CMD = "RABI_GLASS_ROKID_AI_START";
    private static final String GLASS_ROKID_AI_STOP_CMD = "RABI_GLASS_ROKID_AI_STOP";
    private static final String GLASS_ROKID_AI_TTS_PREFIX = "RABI_GLASS_ROKID_AI_TTS:";
    private static final String GLASS_ROKID_AI_CONFIG_PREFIX = "RABI_GLASS_ROKID_AI_CONFIG_B64:";
    private static final String GLASS_ROKID_AI_CLEAR_CONFIG_CMD = "RABI_GLASS_ROKID_AI_CLEAR_CONFIG";

    private TextView statusView;
    private TextView logView;
    private HorizontalScrollView buttonScrollView;
    private final List<Button> actionButtons = new ArrayList<>();
    private int selectedActionIndex;
    private float touchStartX;
    private float touchStartY;
    private boolean touchGestureActive;
    private boolean navigationKeyGestureActive;
    private long lastActionNavigationAtMs;
    private int lastActionNavigationDirection;
    private String latestText = "";
    private String pendingProtocolAfterSdkReady = "";
    private String lastGlassSdkEvent = "not_initialized";
    private String lastGlassSdkError = "";
    private boolean startAfterPermission;
    private boolean bindRequested;
    private boolean serviceConnectedSeen;
    private boolean registerClientRequested;
    private boolean clientReadySeen;
    private boolean offlineCmdArmed;
    private String lastOfflineCmdEvent = "not_armed";
    private String lastOfflineCmdError = "";
    private CXRServiceBridge cxrBridge;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer androidRecognizer;
    private boolean androidAsrListening;
    private TextToSpeech androidTts;
    private boolean androidTtsReady;
    private String lastAndroidVoiceEvent = "not_initialized";
    private String lastAndroidVoiceError = "";
    private GlassRokidAiSdkBridge rokidAiSdkBridge;

    private final IClientCallback clientCallback = new IClientCallback.Stub() {
        @Override
        public void onReady() {
            clientReadySeen = true;
            lastGlassSdkEvent = "client_ready";
            lastGlassSdkError = "";
            appendOnUi("Glass SDK client ready: " + CLIENT_ID);
            registerRuntimeServicesOnUi();
            updateSdkStatusOnUi();
            runPendingProtocolOnUi();
        }
    };

    private final IMessageListener messageListener = new IMessageListener.Stub() {
        @Override
        public void onTextMessage(String msg) {
            String text = msg == null ? "" : msg.trim();
            runOnUiThread(() -> {
                append("message from phone: " + redactedProtocol(text));
                handleProtocol(text);
            });
        }

        @Override
        public void onAudioStream(byte[] buffer) {
            appendOnUi("audio stream from phone bytes=" + (buffer == null ? 0 : buffer.length));
        }

        @Override
        public void onStreamDataReceived(String tag, byte[] data) {
            appendOnUi("stream from phone tag=" + safe(tag) + " bytes=" + (data == null ? 0 : data.length));
        }
    };

    private final CXRServiceBridge.StatusListener cxrStatusListener = new CXRServiceBridge.StatusListener() {
        @Override
        public void onConnected(String deviceName, String deviceAddress, int deviceType) {
            appendOnUi("CXRServiceBridge connected name=" + safe(deviceName) + " type=" + deviceType);
        }

        @Override
        public void onDisconnected() {
            appendOnUi("CXRServiceBridge disconnected");
        }

        @Override
        public void onConnecting(String deviceName, String deviceAddress, int deviceType) {
            appendOnUi("CXRServiceBridge connecting name=" + safe(deviceName) + " type=" + deviceType);
        }

        @Override
        public void onARTCStatus(float fps, boolean stable) {
        }

        @Override
        public void onRokidAccountChanged(String account) {
            appendOnUi("CXRServiceBridge account changed=" + safe(account));
        }

        @Override
        public void onAudioNoise(float noise) {
        }
    };

    private final CXRServiceBridge.MsgCallback customCmdCallback = new CXRServiceBridge.MsgCallback() {
        @Override
        public void onReceive(String name, Caps args, byte[] bytes) {
            String protocol = protocolFromCaps(args);
            runOnUiThread(() -> {
                append("custom cmd from phone name=" + safe(name) + " protocol=" + redactedProtocol(protocol) + " bytes=" + (bytes == null ? 0 : bytes.length));
                if (!protocol.isEmpty()) {
                    handleProtocol(protocol);
                }
            });
        }
    };

    private final SpeechCallback speechCallback = new SpeechCallback.Stub() {
        @Override
        public void onStart() {
            appendOnUi("ASR started: 请开始说话");
            setStatusOnUi("ASR 监听中");
        }

        @Override
        public void onIntermediateVad(String content) {
            String text = content == null ? "" : content.trim();
            if (!text.isEmpty()) {
                latestText = text;
                appendOnUi("partial: " + text);
                setStatusOnUi("识别中: " + text);
            }
        }

        @Override
        public void onAsrComplete(String content) {
            String text = content == null ? "" : content.trim();
            latestText = text;
            if (text.isEmpty()) {
                appendOnUi("complete: <empty>");
                setStatusOnUi("结束: 未识别到文本");
                return;
            }
            appendOnUi("complete: " + text);
            setStatusOnUi("完成: " + text);
            sendLatestTextToPhone();
        }

        public void onAsrCompleteWithIntent(String content, int intent, String intentJson) {
            appendOnUi("intent: text=" + safe(content) + " index=" + intent + " json=" + safe(intentJson));
        }

        @Override
        public void onError(int code) {
            appendOnUi("ASR error: code=" + code);
            setStatusOnUi("ASR 错误: " + code);
            sendTextToPhone(ASR_ERR_PREFIX + "code=" + code);
        }

        public void onServiceConnectState(boolean connect) {
            appendOnUi("ASR service connected=" + connect);
        }
    };

    private final RecognitionListener androidRecognitionListener = new RecognitionListener() {
        @Override
        public void onReadyForSpeech(Bundle params) {
            androidAsrListening = true;
            lastAndroidVoiceEvent = "asr_ready";
            lastAndroidVoiceError = "";
            append("Android system ASR ready for speech");
            setStatus("Android 系统 ASR 监听中");
        }

        @Override
        public void onBeginningOfSpeech() {
            lastAndroidVoiceEvent = "asr_begin";
            append("Android system ASR beginning of speech");
        }

        @Override
        public void onRmsChanged(float rmsdB) {
        }

        @Override
        public void onBufferReceived(byte[] buffer) {
            append("Android system ASR buffer bytes=" + (buffer == null ? 0 : buffer.length));
        }

        @Override
        public void onEndOfSpeech() {
            androidAsrListening = false;
            lastAndroidVoiceEvent = "asr_end";
            append("Android system ASR end of speech");
        }

        @Override
        public void onError(int error) {
            androidAsrListening = false;
            lastAndroidVoiceEvent = "asr_error";
            lastAndroidVoiceError = "code=" + error;
            append("Android system ASR error=" + error);
            setStatus("Android 系统 ASR 错误: " + error);
            sendTextToPhone(ANDROID_ERR_PREFIX + "asr:code=" + error);
        }

        @Override
        public void onResults(Bundle results) {
            androidAsrListening = false;
            String text = firstRecognitionText(results);
            lastAndroidVoiceEvent = text.isEmpty() ? "asr_result_empty" : "asr_result";
            latestText = text.isEmpty() ? latestText : text;
            append("Android system ASR final=" + (text.isEmpty() ? "<empty>" : text));
            setStatus(text.isEmpty() ? "Android 系统 ASR 无文本" : "Android 系统 ASR: " + text);
            if (!text.isEmpty()) {
                sendTextToPhone(ANDROID_ASR_PREFIX + text);
            }
        }

        @Override
        public void onPartialResults(Bundle partialResults) {
            String text = firstRecognitionText(partialResults);
            if (text.isEmpty()) {
                return;
            }
            lastAndroidVoiceEvent = "asr_partial";
            latestText = text;
            append("Android system ASR partial=" + text);
            sendTextToPhone(ANDROID_ASR_PARTIAL_PREFIX + text);
        }

        @Override
        public void onEvent(int eventType, Bundle params) {
            append("Android system ASR event=" + eventType);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prepareGlassWindow();
        setContentView(buildUi());
        append("Rabi Glass Test started.");
        append("用于验证眼镜端测试 APK、CXR CustomCmd 和基础回包。");
        append("按钮可用触摸板逐项切换；选中项会放大并显示 > 光标。");
        initCustomCmdBridge();
        initAndroidSystemTts();
        initGlassSdk();
    }

    @Override
    protected void onResume() {
        super.onResume();
        prepareGlassWindow();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            prepareGlassWindow();
        }
    }

    @Override
    protected void onDestroy() {
        stopAsr(false);
        stopAndroidSystemAsr(false);
        if (androidRecognizer != null) {
            try {
                androidRecognizer.destroy();
            } catch (Throwable ignored) {
            }
            androidRecognizer = null;
        }
        if (androidTts != null) {
            try {
                androidTts.shutdown();
            } catch (Throwable ignored) {
            }
            androidTts = null;
        }
        if (rokidAiSdkBridge != null) {
            rokidAiSdkBridge.destroy();
            rokidAiSdkBridge = null;
        }
        try {
            GlassSdk.release();
        } catch (Throwable error) {
            append("GlassSdk.release failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        super.onDestroy();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int keyCode = event.getKeyCode();
        if (isNavigationActionKey(keyCode)) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                navigationKeyGestureActive = false;
                return true;
            }
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                long now = SystemClock.uptimeMillis();
                if (navigationKeyGestureActive && now - lastActionNavigationAtMs < ACTION_NAVIGATION_KEY_LOCK_MS) {
                    Log.d(TAG, "suppress active key navigation keyCode=" + keyCode);
                    return true;
                }
                navigationKeyGestureActive = true;
                return guardedMoveActionFocus(isNextActionKey(keyCode) ? 1 : -1, "key", event.getRepeatCount());
            }
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (isConfirmActionKey(keyCode)) {
                performSelectedAction();
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            touchStartX = event.getX();
            touchStartY = event.getY();
            touchGestureActive = true;
            return true;
        }
        if (action == MotionEvent.ACTION_CANCEL) {
            touchGestureActive = false;
            return true;
        }
        if (action == MotionEvent.ACTION_MOVE) {
            return true;
        }
        if (action == MotionEvent.ACTION_UP && touchGestureActive) {
            touchGestureActive = false;
            float deltaX = event.getX() - touchStartX;
            float deltaY = event.getY() - touchStartY;
            float threshold = dp(24);
            if (Math.abs(deltaX) < threshold && Math.abs(deltaY) < threshold) {
                performSelectedAction();
                return true;
            }
            if (Math.abs(deltaX) >= Math.abs(deltaY)) {
                return guardedMoveActionFocus(deltaX < 0 ? 1 : -1, "touch", 0);
            }
            return guardedMoveActionFocus(deltaY > 0 ? 1 : -1, "touch", 0);
        }
        return super.dispatchTouchEvent(event);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_RECORD_AUDIO) {
            return;
        }
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (granted && startAfterPermission) {
            startAfterPermission = false;
            startAsr(false);
            return;
        }
        startAfterPermission = false;
        append("麦克风权限未授权，无法启动 ASR。");
    }

    private View buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.BOTTOM);
        root.setPadding(dp(16), 0, dp(16), dp(16));
        root.setBackgroundColor(GLASS_BACKGROUND_COLOR);

        root.addView(new View(this), new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout hud = new LinearLayout(this);
        hud.setOrientation(LinearLayout.VERTICAL);
        hud.setBackgroundColor(Color.TRANSPARENT);

        TextView title = new TextView(this);
        title.setText("Rabi Glass Test");
        title.setTextColor(Color.WHITE);
        title.setTextSize(13);
        title.setPadding(0, 0, 0, dp(2));
        hud.addView(title, new LinearLayout.LayoutParams(-1, -2));

        statusView = new TextView(this);
        statusView.setText("初始化中");
        statusView.setTextColor(Color.rgb(61, 220, 151));
        statusView.setTextSize(11);
        statusView.setSingleLine(true);
        statusView.setPadding(0, 0, 0, dp(6));
        hud.addView(statusView, new LinearLayout.LayoutParams(-1, -2));

        hud.addView(buttonRow(
                button("发送文本", v -> sendLatestTextToPhone()),
                button("Ping", v -> handleProtocol(PING_CMD)),
                button("状态", v -> handleProtocol(STATUS_CMD)),
                button("诊断", v -> handleProtocol(DIAG_CMD)),
                button("注册离线", v -> armOfflineCommands(false)),
                button("清除离线", v -> clearOfflineCommands(false))
        ), new LinearLayout.LayoutParams(-1, -2));

        ScrollView scroll = new ScrollView(this);
        logView = new TextView(this);
        logView.setTextColor(Color.rgb(188, 200, 210));
        logView.setTextSize(9);
        logView.setPadding(0, dp(4), 0, 0);
        scroll.addView(logView, new ScrollView.LayoutParams(-1, -2));
        hud.addView(scroll, new LinearLayout.LayoutParams(-1, dp(44)));

        root.addView(hud, new LinearLayout.LayoutParams(-1, -2));
        return root;
    }

    private HorizontalScrollView buttonRow(Button... buttons) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(dp(116), 0, dp(116), dp(4));
        actionButtons.clear();
        for (Button button : buttons) {
            button.setId(View.generateViewId());
            actionButtons.add(button);
        }
        for (int i = 0; i < buttons.length; i++) {
            int next = buttons[(i + 1) % buttons.length].getId();
            int previous = buttons[(i + buttons.length - 1) % buttons.length].getId();
            buttons[i].setNextFocusForwardId(next);
            buttons[i].setNextFocusRightId(next);
            buttons[i].setNextFocusDownId(next);
            buttons[i].setNextFocusLeftId(previous);
            buttons[i].setNextFocusUpId(previous);
        }
        for (Button button : buttons) {
            LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(dp(112), dp(36));
            params.setMargins(0, 0, dp(6), 0);
            row.addView(button, params);
        }
        buttonScrollView = new HorizontalScrollView(this);
        buttonScrollView.setHorizontalScrollBarEnabled(false);
        buttonScrollView.setFillViewport(false);
        buttonScrollView.addView(row, new HorizontalScrollView.LayoutParams(-2, -2));
        if (buttons.length > 0) {
            row.post(() -> selectAction(0, false));
        }
        return buttonScrollView;
    }

    private boolean isNextActionKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
                || keyCode == KeyEvent.KEYCODE_DPAD_DOWN
                || keyCode == KeyEvent.KEYCODE_NAVIGATE_NEXT
                || keyCode == KeyEvent.KEYCODE_FORWARD
                || keyCode == KeyEvent.KEYCODE_MEDIA_NEXT
                || keyCode == KeyEvent.KEYCODE_PAGE_DOWN
                || keyCode == KeyEvent.KEYCODE_TAB;
    }

    private boolean isPreviousActionKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_DPAD_LEFT
                || keyCode == KeyEvent.KEYCODE_DPAD_UP
                || keyCode == KeyEvent.KEYCODE_NAVIGATE_PREVIOUS
                || keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS
                || keyCode == KeyEvent.KEYCODE_PAGE_UP;
    }

    private boolean isNavigationActionKey(int keyCode) {
        return isNextActionKey(keyCode) || isPreviousActionKey(keyCode);
    }

    private boolean isConfirmActionKey(int keyCode) {
        return keyCode == KeyEvent.KEYCODE_ENTER
                || keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER
                || keyCode == KeyEvent.KEYCODE_DPAD_CENTER
                || keyCode == KeyEvent.KEYCODE_BUTTON_A
                || keyCode == KeyEvent.KEYCODE_SPACE;
    }

    private boolean moveActionFocus(int direction) {
        if (actionButtons.isEmpty()) {
            return false;
        }
        selectAction(selectedActionIndex + direction, true);
        return true;
    }

    private boolean guardedMoveActionFocus(int direction, String source, int repeatCount) {
        if (repeatCount > 0) {
            Log.d(TAG, "suppress repeated navigation source=" + source + " direction=" + direction + " repeat=" + repeatCount);
            return true;
        }
        long now = SystemClock.uptimeMillis();
        if (lastActionNavigationDirection == direction
                && now - lastActionNavigationAtMs < ACTION_NAVIGATION_DEBOUNCE_MS) {
            Log.d(TAG, "suppress duplicate navigation source=" + source + " direction=" + direction);
            return true;
        }
        lastActionNavigationDirection = direction;
        lastActionNavigationAtMs = now;
        Log.d(TAG, "navigation source=" + source + " direction=" + direction);
        return moveActionFocus(direction);
    }

    private void selectAction(int index, boolean announce) {
        if (actionButtons.isEmpty()) {
            return;
        }
        selectedActionIndex = (index % actionButtons.size() + actionButtons.size()) % actionButtons.size();
        Button button = actionButtons.get(selectedActionIndex);
        button.requestFocus();
        centerFocusedButton(button);
        if (announce) {
            Object tag = button.getTag();
            String label = tag == null ? "" : tag.toString();
            setStatus("选择 " + (selectedActionIndex + 1) + "/" + actionButtons.size() + ": " + label);
            Log.d(TAG, "selected action " + (selectedActionIndex + 1) + "/" + actionButtons.size() + " " + label);
        }
    }

    private void performSelectedAction() {
        if (actionButtons.isEmpty()) {
            startAsr(false);
            return;
        }
        View focused = getCurrentFocus();
        int current = actionButtons.indexOf(focused);
        if (current >= 0) {
            selectedActionIndex = current;
        }
        Button button = actionButtons.get(selectedActionIndex);
        button.requestFocus();
        centerFocusedButton(button);
        Object tag = button.getTag();
        Log.d(TAG, "perform action " + (selectedActionIndex + 1) + "/" + actionButtons.size() + " " + (tag == null ? "" : tag.toString()));
        button.performClick();
    }

    private Button button(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setTag(text);
        button.setText("  " + text);
        button.setAllCaps(false);
        button.setTextSize(13);
        button.setTextColor(Color.WHITE);
        button.setMinHeight(dp(32));
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        button.setPadding(dp(4), 0, dp(4), 0);
        button.setFocusable(true);
        button.setFocusableInTouchMode(true);
        button.setBackground(buttonBackground(false));
        button.setOnFocusChangeListener((view, focused) -> updateButtonFocus((Button) view, focused));
        button.setOnClickListener(listener);
        return button;
    }

    private void updateButtonFocus(Button button, boolean focused) {
        Object tag = button.getTag();
        String label = tag == null ? "" : tag.toString();
        button.setText((focused ? "> " : "  ") + label);
        button.setTextColor(focused ? Color.rgb(61, 220, 151) : Color.WHITE);
        button.setScaleX(focused ? FOCUSED_BUTTON_SCALE : 1.0f);
        button.setScaleY(focused ? FOCUSED_BUTTON_SCALE : 1.0f);
        button.setBackground(buttonBackground(focused));
        if (focused) {
            int index = actionButtons.indexOf(button);
            if (index >= 0) {
                selectedActionIndex = index;
            }
            centerFocusedButton(button);
        }
    }

    private void centerFocusedButton(Button button) {
        if (buttonScrollView == null) {
            return;
        }
        button.post(() -> {
            int viewportWidth = buttonScrollView.getWidth();
            int buttonCenter = button.getLeft() + button.getWidth() / 2;
            int targetScrollX = Math.max(0, buttonCenter - viewportWidth / 2);
            buttonScrollView.smoothScrollTo(targetScrollX, 0);
        });
    }

    private GradientDrawable buttonBackground(boolean focused) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(Color.TRANSPARENT);
        drawable.setCornerRadius(8);
        drawable.setStroke(focused ? 2 : 1, focused ? Color.rgb(61, 220, 151) : Color.TRANSPARENT);
        return drawable;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private void prepareGlassWindow() {
        getWindow().setBackgroundDrawable(new ColorDrawable(GLASS_BACKGROUND_COLOR));
        getWindow().addFlags(
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_FULLSCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        );
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams params = getWindow().getAttributes();
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(params);
        }
        View decor = getWindow().getDecorView();
        decor.setBackgroundColor(GLASS_BACKGROUND_COLOR);
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
        );
    }

    private void initGlassSdk() {
        try {
            if (GlassSdk.isReady()) {
                lastGlassSdkEvent = "already_ready";
                lastGlassSdkError = "";
                append("GlassSdk already ready.");
                updateSdkStatus();
                return;
            }
            bindRequested = true;
            lastGlassSdkEvent = "bind_requested";
            append("bindSecurityService...");
            GlassSdk.bindSecurityService(getApplicationContext(), new IServiceConnectionCallback() {
                @Override
                public void onServiceConnected() {
                    serviceConnectedSeen = true;
                    registerClientRequested = true;
                    lastGlassSdkEvent = "service_connected";
                    lastGlassSdkError = "";
                    appendOnUi("Glass security service connected, register client=" + CLIENT_ID);
                    try {
                        GlassSdk.registerClient(CLIENT_ID, clientCallback);
                    } catch (Throwable error) {
                        lastGlassSdkEvent = "register_failed";
                        lastGlassSdkError = error.getClass().getSimpleName() + ": " + error.getMessage();
                        appendOnUi("registerClient failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
                    }
                }

                @Override
                public void onServiceDisconnected() {
                    lastGlassSdkEvent = "service_disconnected";
                    appendOnUi("Glass security service disconnected.");
                    setStatusOnUi("SDK 服务已断开");
                }

                @Override
                public void onBindingDied() {
                    lastGlassSdkEvent = "binding_died";
                    appendOnUi("Glass security service binding died.");
                    setStatusOnUi("SDK 绑定失效");
                }
            });
        } catch (Throwable error) {
            lastGlassSdkEvent = "bind_failed";
            lastGlassSdkError = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("bindSecurityService failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            updateSdkStatus();
        }
    }

    private void initCustomCmdBridge() {
        try {
            cxrBridge = new CXRServiceBridge();
            cxrBridge.setStatusListener(cxrStatusListener);
            int result = cxrBridge.subscribe(CUSTOM_CMD_CLIENT_KEY, customCmdCallback);
            append("CXR custom cmd subscribed key=" + CUSTOM_CMD_CLIENT_KEY + " result=" + result);
        } catch (Throwable error) {
            append("CXR custom cmd init failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void updateSdkStatusOnUi() {
        runOnUiThread(this::updateSdkStatus);
    }

    private void updateSdkStatus() {
        boolean ready = false;
        try {
            ready = GlassSdk.isReady();
        } catch (Throwable error) {
            append("GlassSdk.isReady failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        setStatus("SDK ready=" + ready
                + " | ASR=" + (safeAsrAvailable() ? "available" : "unavailable")
                + " | TTS=" + (safeTtsAvailable() ? "available" : "unavailable"));
    }

    private boolean safeAsrAvailable() {
        try {
            return GlassSdk.getGlassAsrService() != null;
        } catch (Throwable error) {
            append("getGlassAsrService failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    private boolean safeTtsAvailable() {
        try {
            return GlassSdk.getGlassTtsService() != null;
        } catch (Throwable error) {
            append("getGlassTtsService failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    private void handleProtocol(String text) {
        if (PING_CMD.equals(text)) {
            sendTextToPhone(PONG_PREFIX + System.currentTimeMillis());
            return;
        }
        if (STATUS_CMD.equals(text) || DIAG_CMD.equals(text)) {
            initGlassSdk();
            sendTextToPhone(STATUS_PREFIX + glassSdkStatusSummary());
            return;
        }
        if (ASR_START_CMD.equals(text)) {
            if (deferProtocolUntilSdkReady(text)) {
                sendTextToPhone(ASR_START_ERR_PREFIX + "glass_sdk_not_ready");
            } else {
                startAsr(true);
            }
            return;
        }
        if (ASR_STOP_CMD.equals(text)) {
            if (deferProtocolUntilSdkReady(text)) {
                sendTextToPhone(ASR_STOP_ERR_PREFIX + "glass_sdk_not_ready");
            } else {
                stopAsr(true);
            }
            return;
        }
        if (OFFLINE_ARM_CMD.equals(text)) {
            armOfflineCommands(true);
            return;
        }
        if (OFFLINE_CLEAR_CMD.equals(text)) {
            clearOfflineCommands(true);
            return;
        }
        if (ANDROID_VOICE_PROBE_CMD.equals(text)) {
            sendTextToPhone(ANDROID_STATUS_PREFIX + androidVoiceStatusSummary());
            return;
        }
        if (ANDROID_ASR_START_CMD.equals(text)) {
            startAndroidSystemAsr(true);
            return;
        }
        if (ANDROID_ASR_STOP_CMD.equals(text)) {
            stopAndroidSystemAsr(true);
            return;
        }
        if (text.startsWith(ANDROID_TTS_PREFIX)) {
            String speech = text.substring(ANDROID_TTS_PREFIX.length()).trim();
            if (speech.isEmpty()) {
                speech = "Rabi 眼镜系统 TTS 测试";
            }
            speakAndroidSystemTts(speech, true);
            return;
        }
        if (GLASS_ROKID_AI_PROBE_CMD.equals(text)) {
            sendTextToPhone("RABI_ROKID_AI_STATUS:" + getRokidAiSdkBridge().readinessSummary());
            return;
        }
        if (text.startsWith(GLASS_ROKID_AI_CONFIG_PREFIX)) {
            applyRokidAiSdkConfig(text.substring(GLASS_ROKID_AI_CONFIG_PREFIX.length()));
            return;
        }
        if (GLASS_ROKID_AI_CLEAR_CONFIG_CMD.equals(text)) {
            getRokidAiSdkBridge().clearCredentials();
            append("RokidAiSdk eye credentials cleared.");
            return;
        }
        if (GLASS_ROKID_AI_START_CMD.equals(text)) {
            getRokidAiSdkBridge().start();
            return;
        }
        if (GLASS_ROKID_AI_STOP_CMD.equals(text)) {
            getRokidAiSdkBridge().stop();
            return;
        }
        if (text.startsWith(GLASS_ROKID_AI_TTS_PREFIX)) {
            String speech = text.substring(GLASS_ROKID_AI_TTS_PREFIX.length()).trim();
            getRokidAiSdkBridge().speak(speech);
            return;
        }
        if (!text.startsWith(TTS_PREFIX)) {
            return;
        }
        if (deferProtocolUntilSdkReady(text)) {
            sendTextToPhone(TTS_ERR_PREFIX + "glass_sdk_not_ready");
            return;
        }
        String speech = text.substring(TTS_PREFIX.length()).trim();
        if (speech.isEmpty()) {
            speech = "Rabi 原生 TTS 测试";
        }
        speakText(speech, true);
    }

    private GlassRokidAiSdkBridge getRokidAiSdkBridge() {
        if (rokidAiSdkBridge == null) {
            rokidAiSdkBridge = new GlassRokidAiSdkBridge(this, new GlassRokidAiSdkBridge.Listener() {
                @Override
                public void onAiSdkPayload(String payload) {
                    sendTextToPhone(payload);
                }

                @Override
                public void onAiSdkLog(String line) {
                    append(line);
                }
            });
        }
        return rokidAiSdkBridge;
    }

    private void applyRokidAiSdkConfig(String encodedJson) {
        try {
            byte[] bytes = Base64.decode(encodedJson == null ? "" : encodedJson.trim(), Base64.NO_WRAP);
            JSONObject root = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            GlassRokidAiSdkBridge.Credentials credentials = new GlassRokidAiSdkBridge.Credentials(
                    root.optString("key", ""),
                    root.optString("secret", ""),
                    root.optString("deviceTypeId", ""),
                    root.optString("deviceId", ""),
                    root.optString("seed", ""),
                    root.optString("workDir", GlassRokidAiSdkBridge.DEFAULT_WORK_DIR),
                    root.optString("configFile", GlassRokidAiSdkBridge.DEFAULT_CONFIG_FILE)
            );
            getRokidAiSdkBridge().updateCredentials(credentials);
            append("RokidAiSdk eye credentials updated: " + credentials.summary());
        } catch (Throwable error) {
            sendTextToPhone("RABI_ROKID_AI_ERROR:config_failed:" + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
            append("RokidAiSdk eye credentials update failed: " + error.getClass().getSimpleName() + ": " + safe(error.getMessage()));
        }
    }

    private boolean deferProtocolUntilSdkReady(String protocol) {
        if (isGlassSdkReady()) {
            return false;
        }
        pendingProtocolAfterSdkReady = protocol;
        append("GlassSdk 尚未 ready，暂存远程命令：" + redactedProtocol(protocol));
        initGlassSdk();
        updateSdkStatus();
        return true;
    }

    private String glassSdkStatusSummary() {
        boolean ready = isGlassSdkReady();
        boolean asr = false;
        boolean tts = false;
        boolean message = false;
        try {
            asr = GlassSdk.getGlassAsrService() != null;
        } catch (Throwable ignored) {
        }
        try {
            tts = GlassSdk.getGlassTtsService() != null;
        } catch (Throwable ignored) {
        }
        try {
            message = GlassSdk.getGlassMessageService() != null;
        } catch (Throwable ignored) {
        }
        boolean offlineCmd = safeOfflineCmdAvailable();
        boolean serverPackage = isPackageInstalled("com.rokid.security.system.server");
        boolean recordAudio = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean bluetoothConnect = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        return "ready=" + ready
                + ";asr=" + asr
                + ";tts=" + tts
                + ";message=" + message
                + ";offlineCmd=" + offlineCmd
                + ";offlineArmed=" + offlineCmdArmed
                + ";serverPackage=" + serverPackage
                + ";recordAudioGranted=" + recordAudio
                + ";btConnectGranted=" + bluetoothConnect
                + ";bindRequested=" + bindRequested
                + ";serviceConnected=" + serviceConnectedSeen
                + ";registerRequested=" + registerClientRequested
                + ";clientReady=" + clientReadySeen
                + ";package=" + sanitizeStatusValue(getPackageName())
                + ";device=" + sanitizeStatusValue(Build.MANUFACTURER + "/" + Build.MODEL + "/sdk" + Build.VERSION.SDK_INT)
                + ";supportedAbis=" + sanitizeStatusValue(join(Build.SUPPORTED_ABIS))
                + ";supported32BitAbis=" + sanitizeStatusValue(join(Build.SUPPORTED_32_BIT_ABIS))
                + ";supported64BitAbis=" + sanitizeStatusValue(join(Build.SUPPORTED_64_BIT_ABIS))
                + ";nativeLibraryDir=" + sanitizeStatusValue(nativeLibraryDir())
                + ";rokidPackages=" + sanitizeStatusValue(rokidPackageDigest())
                + ";securityCandidates=" + sanitizeStatusValue(securityPackageCandidates())
                + ";offlineEvent=" + sanitizeStatusValue(lastOfflineCmdEvent)
                + ";offlineError=" + sanitizeStatusValue(lastOfflineCmdError)
                + ";androidVoice=" + sanitizeStatusValue(androidVoiceStatusSummary())
                + ";event=" + sanitizeStatusValue(lastGlassSdkEvent)
                + ";error=" + sanitizeStatusValue(lastGlassSdkError);
    }

    private String nativeLibraryDir() {
        try {
            return getApplicationInfo().nativeLibraryDir == null ? "none" : getApplicationInfo().nativeLibraryDir;
        } catch (Throwable error) {
            return "unavailable:" + error.getClass().getSimpleName();
        }
    }

    private String join(String[] values) {
        if (values == null || values.length == 0) {
            return "none";
        }
        List<String> safeValues = new ArrayList<>();
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) {
                safeValues.add(value.trim());
            }
        }
        return safeValues.isEmpty() ? "none" : String.join(",", safeValues);
    }

    private String androidVoiceStatusSummary() {
        boolean recordAudio = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        boolean recognitionAvailable = false;
        try {
            recognitionAvailable = SpeechRecognizer.isRecognitionAvailable(this);
        } catch (Throwable error) {
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
        }
        return "recordAudioGranted=" + recordAudio
                + ";speechRecognizer=" + recognitionAvailable
                + ";asrListening=" + androidAsrListening
                + ";ttsReady=" + androidTtsReady
                + ";event=" + sanitizeStatusValue(lastAndroidVoiceEvent)
                + ";error=" + sanitizeStatusValue(lastAndroidVoiceError);
    }

    private boolean safeOfflineCmdAvailable() {
        try {
            return GlassSdk.getGlassOfflineCmdService() != null;
        } catch (Throwable error) {
            append("getGlassOfflineCmdService failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    private boolean isPackageInstalled(String packageName) {
        try {
            getPackageManager().getPackageInfo(packageName, 0);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private String securityPackageCandidates() {
        String[] packages = new String[]{
                "com.rokid.security.system.server",
                "com.rokid.security",
                "com.rokid.glass",
                "com.rokid.glass.service",
                "com.rokid.cxrservice",
                "com.rokid.cxr",
                "com.rokid.os.sprite.assistserver",
                "com.rokid.os.sprite.record",
                "com.rokid.system"
        };
        List<String> states = new ArrayList<>();
        for (String packageName : packages) {
            states.add(packageName + ":" + (isPackageInstalled(packageName) ? "yes" : "no"));
        }
        return join(states, ",");
    }

    private String rokidPackageDigest() {
        try {
            List<PackageInfo> packages = getPackageManager().getInstalledPackages(0);
            List<String> hits = new ArrayList<>();
            for (PackageInfo info : packages) {
                if (info == null || info.packageName == null) {
                    continue;
                }
                String name = info.packageName;
                if (name.contains("rokid") || name.contains("cxr") || name.contains("security")) {
                    hits.add(name);
                }
                if (hits.size() >= 16) {
                    hits.add("more");
                    break;
                }
            }
            return hits.isEmpty() ? "none_visible" : join(hits, ",");
        } catch (Throwable error) {
            return "error:" + error.getClass().getSimpleName() + ":" + error.getMessage();
        }
    }

    private static String join(List<String> values, String delimiter) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                builder.append(delimiter);
            }
            builder.append(values.get(i));
        }
        return builder.toString();
    }

    private String sanitizeStatusValue(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "none";
        }
        return value.replace(';', ',').replace('\n', ' ').replace('\r', ' ');
    }

    private boolean isGlassSdkReady() {
        try {
            return GlassSdk.isReady();
        } catch (Throwable error) {
            append("GlassSdk.isReady failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return false;
        }
    }

    private void runPendingProtocolOnUi() {
        runOnUiThread(() -> {
            if (pendingProtocolAfterSdkReady.trim().isEmpty()) {
                return;
            }
            String protocol = pendingProtocolAfterSdkReady;
            pendingProtocolAfterSdkReady = "";
            append("GlassSdk ready，执行暂存远程命令：" + protocol);
            handleProtocol(protocol);
        });
    }

    private void startAsr(boolean ackToPhone) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            startAfterPermission = true;
            append("请求麦克风权限...");
            if (ackToPhone) {
                sendTextToPhone(ASR_START_ERR_PREFIX + "record_audio_permission_required");
            }
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_RECORD_AUDIO);
            return;
        }
        try {
            if (!GlassSdk.isReady()) {
                append("GlassSdk 尚未 ready，请稍后重试。");
                initGlassSdk();
                updateSdkStatus();
                if (ackToPhone) {
                    sendTextToPhone(ASR_START_ERR_PREFIX + "glass_sdk_not_ready");
                }
                return;
            }
            if (GlassSdk.getGlassAsrService() == null) {
                append("ASR 服务不可用。");
                updateSdkStatus();
                if (ackToPhone) {
                    sendTextToPhone(ASR_START_ERR_PREFIX + "asr_service_unavailable");
                }
                return;
            }
            GlassSdk.getGlassAsrService().stopSpeech();
            append("startSpeech...");
            GlassSdk.getGlassAsrService().startSpeech(speechCallback);
            if (ackToPhone) {
                sendTextToPhone(ASR_START_ACK_PREFIX + "started");
            }
        } catch (Throwable error) {
            String reason = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("startSpeech failed: " + reason);
            setStatus("启动失败");
            if (ackToPhone) {
                sendTextToPhone(ASR_START_ERR_PREFIX + reason);
            }
        }
    }

    private void stopAsr(boolean ackToPhone) {
        try {
            if (GlassSdk.getGlassAsrService() != null) {
                GlassSdk.getGlassAsrService().stopSpeech();
                append("stopSpeech");
                setStatus("ASR 已停止");
                if (ackToPhone) {
                    sendTextToPhone(ASR_STOP_ACK_PREFIX + "stopped");
                }
                return;
            }
            if (ackToPhone) {
                sendTextToPhone(ASR_STOP_ERR_PREFIX + "asr_service_unavailable");
            }
        } catch (Throwable error) {
            String reason = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("stopSpeech failed: " + reason);
            if (ackToPhone) {
                sendTextToPhone(ASR_STOP_ERR_PREFIX + reason);
            }
        }
    }

    private void sendLatestTextToPhone() {
        if (latestText.trim().isEmpty()) {
            append("暂无可发送文本。");
            return;
        }
        String payload = ASR_PREFIX + latestText;
        boolean p2pSent = false;
        boolean btSent = false;
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().sendTextMessageByP2P(payload);
                p2pSent = true;
            }
        } catch (Throwable error) {
            append("send P2P failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().sendTextMessageByClassicBT(payload);
                btSent = true;
            }
        } catch (Throwable error) {
            append("send BT failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        append("send text to phone: p2p=" + p2pSent + " bt=" + btSent + " text=" + latestText);
    }

    private void speakLatestText() {
        String text = latestText.trim().isEmpty() ? "Rabi 语音识别测试" : latestText;
        speakText(text, false);
    }

    private void speakText(String text, boolean ackToPhone) {
        try {
            if (GlassSdk.getGlassTtsService() == null) {
                append("TTS 服务不可用。");
                if (ackToPhone) {
                    sendTextToPhone(TTS_ERR_PREFIX + "tts_service_unavailable");
                }
                return;
            }
            GlassSdk.getGlassTtsService().doSpeechTts(text);
            append("TTS: " + text);
            if (ackToPhone) {
                sendTextToPhone(TTS_ACK_PREFIX + text);
            }
        } catch (Throwable error) {
            String reason = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("TTS failed: " + reason);
            if (ackToPhone) {
                sendTextToPhone(TTS_ERR_PREFIX + reason);
            }
        }
    }

    private void armOfflineCommands(boolean ackToPhone) {
        if (deferProtocolUntilSdkReady(OFFLINE_ARM_CMD)) {
            if (ackToPhone) {
                sendTextToPhone(OFFLINE_ERR_PREFIX + "glass_sdk_not_ready");
            }
            return;
        }
        try {
            List<VoiceAction> words = new ArrayList<>();
            words.add(new VoiceAction("测试中文", "ce shi zhong wen", offlineCallback("测试中文")));
            words.add(new VoiceAction("打开Rabi", "da kai rabi", offlineCallback("打开Rabi")));
            words.add(new VoiceAction("关闭Rabi", "guan bi rabi", offlineCallback("关闭Rabi")));
            if (GlassSdk.getGlassOfflineCmdService() == null) {
                throw new IllegalStateException("offline_cmd_service_unavailable");
            }
            GlassSdk.getGlassOfflineCmdService().init();
            GlassSdk.getGlassOfflineCmdService().addAll(words);
            offlineCmdArmed = true;
            lastOfflineCmdEvent = "armed";
            lastOfflineCmdError = "";
            append("offline voice commands armed: 测试中文 / 打开Rabi / 关闭Rabi");
            setStatus("离线语音指令已注册");
            if (ackToPhone) {
                sendTextToPhone(OFFLINE_STATUS_PREFIX + "armed=true;words=测试中文,打开Rabi,关闭Rabi");
            }
        } catch (Throwable error) {
            String reason = error.getClass().getSimpleName() + ": " + error.getMessage();
            offlineCmdArmed = false;
            lastOfflineCmdEvent = "arm_failed";
            lastOfflineCmdError = reason;
            append("offline voice commands arm failed: " + reason);
            if (ackToPhone) {
                sendTextToPhone(OFFLINE_ERR_PREFIX + reason);
            }
        }
    }

    private void clearOfflineCommands(boolean ackToPhone) {
        try {
            if (GlassSdk.getGlassOfflineCmdService() == null) {
                throw new IllegalStateException("offline_cmd_service_unavailable");
            }
            GlassSdk.getGlassOfflineCmdService().removeAll();
            offlineCmdArmed = false;
            lastOfflineCmdEvent = "cleared";
            lastOfflineCmdError = "";
            append("offline voice commands cleared");
            setStatus("离线语音指令已清除");
            if (ackToPhone) {
                sendTextToPhone(OFFLINE_STATUS_PREFIX + "armed=false;cleared=true");
            }
        } catch (Throwable error) {
            String reason = error.getClass().getSimpleName() + ": " + error.getMessage();
            lastOfflineCmdEvent = "clear_failed";
            lastOfflineCmdError = reason;
            append("offline voice commands clear failed: " + reason);
            if (ackToPhone) {
                sendTextToPhone(OFFLINE_ERR_PREFIX + reason);
            }
        }
    }

    private IVoiceCallback offlineCallback(String word) {
        return new IVoiceCallback.Stub() {
            @Override
            public void onVoiceTriggered() {
                lastOfflineCmdEvent = "triggered:" + word;
                lastOfflineCmdError = "";
                latestText = word;
                appendOnUi("offline voice triggered: " + word);
                setStatusOnUi("离线语音命中: " + word);
                sendTextToPhone(OFFLINE_TRIGGER_PREFIX + word);
            }
        };
    }

    private void initAndroidSystemTts() {
        if (androidTts != null) {
            return;
        }
        lastAndroidVoiceEvent = "tts_init_requested";
        try {
            androidTts = new TextToSpeech(this, status -> runOnUiThread(() -> {
                androidTtsReady = status == TextToSpeech.SUCCESS;
                lastAndroidVoiceEvent = androidTtsReady ? "tts_ready" : "tts_init_failed";
                lastAndroidVoiceError = androidTtsReady ? "" : "status=" + status;
                if (androidTtsReady) {
                    try {
                        androidTts.setLanguage(Locale.CHINA);
                    } catch (Throwable error) {
                        append("Android system TTS setLanguage failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
                    }
                    androidTts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                        @Override
                        public void onStart(String utteranceId) {
                            appendOnUi("Android system TTS onStart id=" + safe(utteranceId));
                        }

                        @Override
                        public void onDone(String utteranceId) {
                            lastAndroidVoiceEvent = "tts_done";
                            lastAndroidVoiceError = "";
                            appendOnUi("Android system TTS onDone id=" + safe(utteranceId));
                        }

                        @Override
                        public void onError(String utteranceId) {
                            lastAndroidVoiceEvent = "tts_error";
                            lastAndroidVoiceError = "utterance=" + safe(utteranceId);
                            appendOnUi("Android system TTS onError id=" + safe(utteranceId));
                            sendTextToPhone(ANDROID_ERR_PREFIX + "tts:utterance=" + safe(utteranceId));
                        }
                    });
                }
                append("Android system TTS init ready=" + androidTtsReady + " status=" + status);
            }));
        } catch (Throwable error) {
            androidTtsReady = false;
            lastAndroidVoiceEvent = "tts_init_failed";
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("Android system TTS init failed: " + lastAndroidVoiceError);
        }
    }

    private void startAndroidSystemAsr(boolean ackToPhone) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            lastAndroidVoiceEvent = "asr_permission_required";
            lastAndroidVoiceError = "record_audio_permission_required";
            append("Android system ASR requires RECORD_AUDIO permission.");
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "asr:record_audio_permission_required");
            }
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_RECORD_AUDIO);
            return;
        }
        boolean available;
        try {
            available = SpeechRecognizer.isRecognitionAvailable(this);
        } catch (Throwable error) {
            available = false;
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
        }
        if (!available) {
            lastAndroidVoiceEvent = "asr_unavailable";
            lastAndroidVoiceError = "speech_recognizer_unavailable";
            append("Android system SpeechRecognizer unavailable.");
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "asr:speech_recognizer_unavailable");
            }
            return;
        }
        try {
            if (androidRecognizer == null) {
                androidRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
                androidRecognizer.setRecognitionListener(androidRecognitionListener);
            }
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
            androidRecognizer.cancel();
            androidRecognizer.startListening(intent);
            androidAsrListening = true;
            lastAndroidVoiceEvent = "asr_start_requested";
            lastAndroidVoiceError = "";
            append("Android system ASR startListening requested.");
            setStatus("Android 系统 ASR 启动中");
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ASR_START_ACK_PREFIX + "started");
            }
        } catch (Throwable error) {
            androidAsrListening = false;
            lastAndroidVoiceEvent = "asr_start_failed";
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("Android system ASR start failed: " + lastAndroidVoiceError);
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "asr_start:" + lastAndroidVoiceError);
            }
        }
    }

    private void stopAndroidSystemAsr(boolean ackToPhone) {
        try {
            if (androidRecognizer != null) {
                androidRecognizer.stopListening();
                androidRecognizer.cancel();
            }
            androidAsrListening = false;
            lastAndroidVoiceEvent = "asr_stopped";
            lastAndroidVoiceError = "";
            append("Android system ASR stopped.");
            setStatus("Android 系统 ASR 已停止");
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ASR_STOP_ACK_PREFIX + "stopped");
            }
        } catch (Throwable error) {
            androidAsrListening = false;
            lastAndroidVoiceEvent = "asr_stop_failed";
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("Android system ASR stop failed: " + lastAndroidVoiceError);
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "asr_stop:" + lastAndroidVoiceError);
            }
        }
    }

    private void speakAndroidSystemTts(String text, boolean ackToPhone) {
        String speech = text == null || text.trim().isEmpty() ? "Rabi 眼镜系统 TTS 测试" : text.trim();
        initAndroidSystemTts();
        if (!androidTtsReady || androidTts == null) {
            lastAndroidVoiceEvent = "tts_not_ready";
            lastAndroidVoiceError = "tts_not_ready";
            append("Android system TTS not ready.");
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "tts:tts_not_ready");
            }
            return;
        }
        try {
            String utteranceId = "rabi-glass-android-tts-" + System.currentTimeMillis();
            int result = androidTts.speak(speech, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            lastAndroidVoiceEvent = "tts_requested";
            lastAndroidVoiceError = result == TextToSpeech.SUCCESS ? "" : "result=" + result;
            append("Android system TTS speak result=" + result + " text=" + speech);
            if (ackToPhone) {
                if (result == TextToSpeech.SUCCESS) {
                    sendTextToPhone(ANDROID_TTS_ACK_PREFIX + speech);
                } else {
                    sendTextToPhone(ANDROID_ERR_PREFIX + "tts:result=" + result);
                }
            }
        } catch (Throwable error) {
            lastAndroidVoiceEvent = "tts_failed";
            lastAndroidVoiceError = error.getClass().getSimpleName() + ": " + error.getMessage();
            append("Android system TTS failed: " + lastAndroidVoiceError);
            if (ackToPhone) {
                sendTextToPhone(ANDROID_ERR_PREFIX + "tts:" + lastAndroidVoiceError);
            }
        }
    }

    private String firstRecognitionText(Bundle results) {
        if (results == null) {
            return "";
        }
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        if (matches == null || matches.isEmpty() || matches.get(0) == null) {
            return "";
        }
        return matches.get(0).trim();
    }

    private void registerRuntimeServicesOnUi() {
        runOnUiThread(this::registerRuntimeServices);
    }

    private void registerRuntimeServices() {
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().setMessageListener(messageListener);
                append("Glass message listener registered.");
            } else {
                append("Glass message service unavailable.");
            }
        } catch (Throwable error) {
            append("register message listener failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void sendTextToPhone(String payload) {
        sendCustomCmdToPhone(payload);
        boolean p2pSent = false;
        boolean btSent = false;
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().sendTextMessageByP2P(payload);
                p2pSent = true;
            }
        } catch (Throwable error) {
            append("send P2P failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        try {
            if (GlassSdk.getGlassMessageService() != null) {
                GlassSdk.getGlassMessageService().sendTextMessageByClassicBT(payload);
                btSent = true;
            }
        } catch (Throwable error) {
            append("send BT failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        append("send text to phone: p2p=" + p2pSent + " bt=" + btSent + " payload=" + redactedProtocol(payload));
    }

    private void sendCustomCmdToPhone(String payload) {
        try {
            if (cxrBridge == null) {
                append("send custom cmd skipped: bridge null payload=" + payload);
                return;
            }
            Caps caps = new Caps();
            caps.write("protocol");
            caps.write(payload);
            int result = cxrBridge.sendMessage(CUSTOM_CMD_REPLY_KEY, caps);
            append("send custom cmd to phone key=" + CUSTOM_CMD_REPLY_KEY + " result=" + result + " payload=" + payload);
        } catch (Throwable error) {
            append("send custom cmd failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private String protocolFromCaps(Caps caps) {
        if (caps == null) {
            return "";
        }
        try {
            for (int i = 0; i < caps.size(); i++) {
                Caps.Value value = caps.at(i);
                if (value != null && value.type() == Caps.Value.TYPE_STRING) {
                    String text = value.getString();
                    if (text != null && text.startsWith("RABI_")) {
                        return text;
                    }
                }
            }
            return caps.toString();
        } catch (Throwable error) {
            append("parse custom cmd caps failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
            return "";
        }
    }

    private void setStatusOnUi(String line) {
        runOnUiThread(() -> setStatus(line));
    }

    private void setStatus(String line) {
        if (statusView != null) {
            statusView.setText(line);
        }
    }

    private void appendOnUi(String line) {
        runOnUiThread(() -> append(line));
    }

    private void append(String line) {
        Log.d(TAG, line);
        if (logView == null) {
            return;
        }
        String current = logView.getText() == null ? "" : logView.getText().toString();
        logView.setText(line + "\n" + current);
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }

    private static String redactedProtocol(String protocol) {
        if (protocol == null) {
            return "";
        }
        if (protocol.startsWith(GLASS_ROKID_AI_CONFIG_PREFIX)) {
            return GLASS_ROKID_AI_CONFIG_PREFIX + "<redacted>";
        }
        return protocol;
    }
}
