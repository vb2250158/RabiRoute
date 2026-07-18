package com.rabi.link.modules.rokid;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.companion.AssociationInfo;
import android.companion.AssociationRequest;
import android.companion.BluetoothDeviceFilter;
import android.companion.CompanionDeviceManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognizerIntent;
import android.util.Log;
import android.util.Base64;
import android.widget.TextView;

import com.rokid.sprite.aiapp.externalapp.auth.AuthResult;
import com.rabi.link.RabiLinkRelayConfig;
import com.rabi.link.RabiLinkRelaySettings;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Executor;

public class RokidProbeActivity extends Activity implements RokidProbeUi.Actions {
    private static final String TAG = "RokidProbeActivity";
    private static final int REQUEST_ROKID_AUTH = 7101;
    private static final int REQUEST_ANDROID_PERMISSIONS = 7102;
    private static final int REQUEST_ANDROID_RECOGNIZER_INTENT = 7103;
    private static final int REQUEST_PHONE_COMPANION_ASSOCIATION = 7104;
    private static final long NATIVE_VOICE_TIMEOUT_MS = 7000L;
    private static final String GLASS_ASR_ASSET = "rabi-glass-debug.apk";
    private static final String PREFS_NAME = "rokid_probe";
    private static final String PREF_ROKID_TOKEN = "rokid_token";
    private static final String PREF_NATIVE_VOICE_ACCESS_KEY = "native_voice_access_key";
    private static final String PREF_NATIVE_VOICE_SECRET_KEY = "native_voice_secret_key";
    private static final String PREF_ROKID_AI_KEY = "rokid_ai_key";
    private static final String PREF_ROKID_AI_SECRET = "rokid_ai_secret";
    private static final String PREF_ROKID_AI_DEVICE_TYPE_ID = "rokid_ai_device_type_id";
    private static final String PREF_ROKID_AI_DEVICE_ID = "rokid_ai_device_id";
    private static final String PREF_ROKID_AI_SEED = "rokid_ai_seed";
    private static final String PREF_ROKID_AI_WORK_DIR = "rokid_ai_work_dir";
    private static final String PREF_ROKID_AI_CONFIG_FILE = "rokid_ai_config_file";
    private static final String EXTRA_PROBE_COMMAND = "rokid_probe_command";
    private static final String EXTRA_NATIVE_VOICE_COMMAND = "native_voice_command";
    private static final String EXTRA_NATIVE_VOICE_MODE = "native_voice_mode";
    private static final String EXTRA_NATIVE_VOICE_TEXT = "native_voice_text";
    private static final String EXTRA_NATIVE_VOICE_TEXT_B64 = "native_voice_text_b64";
    private static final String EXTRA_NATIVE_VOICE_ACCESS_KEY = "native_voice_access_key";
    private static final String EXTRA_NATIVE_VOICE_ACCESS_KEY_B64 = "native_voice_access_key_b64";
    private static final String EXTRA_NATIVE_VOICE_SECRET_KEY = "native_voice_secret_key";
    private static final String EXTRA_NATIVE_VOICE_SECRET_KEY_B64 = "native_voice_secret_key_b64";
    private static final String EXTRA_NATIVE_VOICE_CHANNEL = "native_voice_channel";
    private static final String EXTRA_NATIVE_VOICE_CLIENT_ID = "native_voice_client_id";
    private static final String EXTRA_ROKID_AI_KEY = "rokid_ai_key";
    private static final String EXTRA_ROKID_AI_KEY_B64 = "rokid_ai_key_b64";
    private static final String EXTRA_ROKID_AI_SECRET = "rokid_ai_secret";
    private static final String EXTRA_ROKID_AI_SECRET_B64 = "rokid_ai_secret_b64";
    private static final String EXTRA_ROKID_AI_DEVICE_TYPE_ID = "rokid_ai_device_type_id";
    private static final String EXTRA_ROKID_AI_DEVICE_TYPE_ID_B64 = "rokid_ai_device_type_id_b64";
    private static final String EXTRA_ROKID_AI_DEVICE_ID = "rokid_ai_device_id";
    private static final String EXTRA_ROKID_AI_DEVICE_ID_B64 = "rokid_ai_device_id_b64";
    private static final String EXTRA_ROKID_AI_SEED = "rokid_ai_seed";
    private static final String EXTRA_ROKID_AI_SEED_B64 = "rokid_ai_seed_b64";
    private static final String EXTRA_ROKID_AI_WORK_DIR = "rokid_ai_work_dir";
    private static final String EXTRA_ROKID_AI_CONFIG_FILE = "rokid_ai_config_file";
    private static final String GLASS_ROKID_AI_CONFIG_PREFIX = "RABI_GLASS_ROKID_AI_CONFIG_B64:";

    private final RokidProbeReport report = new RokidProbeReport();
    private final RokidAuthorizationFlow authorizationFlow = new RokidAuthorizationFlow();
    private final RokidReportClipboard reportClipboard = new RokidReportClipboard();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private RokidCxrController cxrController;
    private RokidNativeVoiceBridge nativeVoiceBridge;
    private RokidAndroidSystemVoiceBridge androidSystemVoiceBridge;
    private RokidAiSdkVoiceBridge rokidAiSdkVoiceBridge;
    private RokidProbeUi.Views uiViews;
    private TextView logView;
    private String token = "";
    private String nativeVoiceAccessKey = "";
    private String nativeVoiceSecretKey = "";
    private String rokidAiKey = "";
    private String rokidAiSecret = "";
    private String rokidAiDeviceTypeId = "";
    private String rokidAiDeviceId = "";
    private String rokidAiSeed = "";
    private String rokidAiWorkDir = RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR;
    private String rokidAiConfigFile = RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE;
    private Uri lastAudioUri;
    private String lastNativeAsrText = "";
    private String lastNativeCommandAck = "";
    private String lastNativeTtsAck = "";
    private String lastNativeVoiceError = "";
    private String lastNativeLoopback = "";
    private String lastAndroidSystemAsrText = "";
    private String lastAndroidSystemTtsAck = "";
    private String lastAndroidSystemVoiceError = "";
    private String lastRokidAiSdkAsrText = "";
    private String lastRokidAiSdkTtsAck = "";
    private String lastRokidAiSdkState = "";
    private String lastRokidAiSdkError = "";
    private String pendingNativeVoiceKind = "";
    private RokidNativeVoiceStatus lastNativeVoiceStatus = RokidNativeVoiceStatus.empty();
    private long pendingNativeVoiceGeneration;
    private MediaPlayer audioPlayer;
    private boolean audioStreamStarted;
    private boolean glassAsrAppInstalled;
    private boolean glassAsrAppStarted;
    private boolean nativeVoiceReachable;
    private boolean nativeEchoNextAsr;
    private RabiGlassPcBackend glassPcBackend;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        token = loadSavedToken();
        nativeVoiceAccessKey = loadSavedPref(PREF_NATIVE_VOICE_ACCESS_KEY);
        nativeVoiceSecretKey = loadSavedPref(PREF_NATIVE_VOICE_SECRET_KEY);
        loadRokidAiSdkConfig();
        buildUi();
        append("Rokid 眼镜探针已启动。");
        if (token != null && !token.trim().isEmpty()) {
            append("已恢复 Rokid 授权 token=" + RokidProbeText.summarizeToken(token));
        }
        append("Rokid 在线语音授权 configured=" + nativeVoiceAuthConfigured());
        append("RokidAiSdk 语音 configured=" + rokidAiSdkConfigured());
        append("本页先验证 CXR-L SDK 依赖、配套 App、权限和前置条件；后续按钮会继续接入授权、连接、CustomView、音频、拍照和设备控制。");
        initCxrLink();
        runEnvironmentProbe();
        handleExternalIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleExternalIntent(intent);
    }

    @Override
    protected void onDestroy() {
        if (cxrController != null) {
            cxrController.disconnect();
        }
        if (nativeVoiceBridge != null) {
            nativeVoiceBridge.stop();
        }
        if (androidSystemVoiceBridge != null) {
            androidSystemVoiceBridge.stop();
        }
        if (rokidAiSdkVoiceBridge != null) {
            rokidAiSdkVoiceBridge.stop();
        }
        if (glassPcBackend != null) {
            glassPcBackend.stop();
        }
        pendingNativeVoiceGeneration++;
        releaseAudioPlayer();
        super.onDestroy();
    }

    private void buildUi() {
        uiViews = RokidProbeUi.install(this, this);
        uiViews.setNativeVoiceCredentials(nativeVoiceAccessKey, nativeVoiceSecretKey);
        uiViews.setRokidAiSdkCredentials(currentRokidAiSdkCredentials());
        logView = uiViews.logView;
        updateDashboard();
    }

    private void initCxrLink() {
        cxrController = new RokidCxrController(this, new RokidCxrController.Listener() {
            @Override
            public void onLog(String line) {
                appendOnUi(line);
            }

            @Override
            public void onCxrConnectionChanged(boolean connected) {
                // The probe dashboard already receives the same state through onLog.
            }

            @Override
            public void onGlassBtConnectionChanged(boolean connected) {
                // The probe dashboard already receives the same state through onLog.
            }

            @Override
            public void onGlassDeviceInfo(com.rokid.cxr.link.utils.GlassInfo info) {
                // The probe dashboard already receives the formatted device info through onLog.
            }

            @Override
            public void onPhoto(byte[] data) {
                saveJpeg(data);
                if (glassPcBackend != null) {
                    glassPcBackend.submitMedia(data, "image/jpeg", "rabi-glass-photo-" + System.currentTimeMillis() + ".jpg", "眼镜拍摄的照片");
                }
            }

            @Override
            public void onGlassAppResult(String status, String summary, String error) {
                handleGlassAppResult(status, summary, error);
            }

            @Override
            public void onNativeVoiceProtocol(String payload, String channel, String clientId) {
                if (nativeVoiceBridge != null) {
                    nativeVoiceBridge.handleIncomingProtocol(channel, payload, clientId);
                }
            }

            @Override
            public void onAudioPcm(byte[] data, int offset, int length) {
                if (nativeVoiceBridge != null) {
                    nativeVoiceBridge.feedPhoneAsrAudio(data, offset, length);
                }
            }
        });
        append("CXRLink 已初始化。");
        nativeVoiceBridge = new RokidNativeVoiceBridge(this, new RokidNativeVoiceBridge.Listener() {
            @Override
            public void onNativeVoiceLog(String line) {
                appendOnUi(line);
            }

            @Override
            public void onNativeAsrText(String text, String channel, String clientId) {
                handleNativeAsrText(text, channel, clientId, true);
            }

            @Override
            public void onNativeTtsAck(String text, String channel, String clientId) {
                handleNativeTtsAck(text, channel, clientId, true);
            }

            @Override
            public void onNativeCommandAck(String kind, String text, String channel, String clientId) {
                handleNativeCommandAck(kind, text, channel, clientId, true);
            }

            @Override
            public void onNativeStatus(String text, String channel, String clientId) {
                handleNativeStatus(text, channel, clientId, true);
            }

            @Override
            public void onNativeVoiceError(String kind, String text, String channel, String clientId) {
                handleNativeVoiceError(kind, text, channel, clientId, true);
            }

            @Override
            public void onGlassAudioCaptureComplete(byte[] pcm) {
                if (glassPcBackend != null) {
                    glassPcBackend.submitPcm(pcm);
                }
            }
        }, nativeVoiceAccessKey, nativeVoiceSecretKey);
        nativeVoiceBridge.start();
        RabiLinkRelayConfig relayConfig = RabiLinkRelaySettings.load(this);
        glassPcBackend = new RabiGlassPcBackend(this, new RabiGlassPcBackend.Listener() {
            @Override
            public void onStatus(String status) {
                appendOnUi("眼镜后端：" + status);
                if (nativeVoiceBridge != null) nativeVoiceBridge.sendGlassAudioStatus(status);
            }

            @Override
            public void onReplyPcm(byte[] pcm) {
                if (nativeVoiceBridge != null) nativeVoiceBridge.sendAudioPcmToGlass(pcm);
            }

            @Override
            public void onError(String message) {
                appendOnUi("眼镜后端错误：" + message);
                if (nativeVoiceBridge != null) nativeVoiceBridge.sendGlassAudioStatus("错误：" + message);
            }
        });
        glassPcBackend.configure(relayConfig.getBaseUrl(), relayConfig.getToken(), "rabi-glass");
        glassPcBackend.start();
        androidSystemVoiceBridge = new RokidAndroidSystemVoiceBridge(this, new RokidAndroidSystemVoiceBridge.Listener() {
            @Override
            public void onSystemVoiceLog(String line) {
                appendOnUi(line);
            }

            @Override
            public void onSystemAsrText(String text, boolean finalResult) {
                handleAndroidSystemAsrText(text, finalResult);
            }

            @Override
            public void onSystemTtsAck(String text) {
                handleAndroidSystemTtsAck(text);
            }

            @Override
            public void onSystemVoiceError(String kind, String message) {
                handleAndroidSystemVoiceError(kind, message);
            }
        });
        androidSystemVoiceBridge.start();
        rokidAiSdkVoiceBridge = new RokidAiSdkVoiceBridge(this, new RokidAiSdkVoiceBridge.Listener() {
            @Override
            public void onAiSdkLog(String line) {
                appendOnUi(line);
            }

            @Override
            public void onAiSdkAsrText(String text, boolean finalResult, boolean local) {
                handleRokidAiSdkAsrText(text, finalResult, local);
            }

            @Override
            public void onAiSdkTtsRequested(String text) {
                handleRokidAiSdkTtsRequested(text);
            }

            @Override
            public void onAiSdkError(String kind, String message) {
                handleRokidAiSdkError(kind, message);
            }

            @Override
            public void onAiSdkState(String state, String detail) {
                handleRokidAiSdkState(state, detail);
            }
        }, currentRokidAiSdkCredentials());
        updateDashboard();
    }

    @Override
    public void runEnvironmentProbe() {
        for (String line : RokidProbeEnvironment.inspect(
                this,
                RokidProbeText.summarizeToken(token),
                cxrController != null && cxrController.isCxrConnected(),
                cxrController != null && cxrController.isGlassBtConnected(),
                cxrController == null ? "<not-initialized>" : cxrController.getSessionState())) {
            append(line);
        }
        recordResult(RokidGlassModule.CAP_APP_AUTH, "checked", "Rokid 环境检查完成", "", "");
        updateDashboard();
    }

    @Override
    public void requestAndroidPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> permissions = new ArrayList<>();
            permissions.add(Manifest.permission.RECORD_AUDIO);
            permissions.add(Manifest.permission.CAMERA);
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
            permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                permissions.add(Manifest.permission.BLUETOOTH_SCAN);
                permissions.add(Manifest.permission.BLUETOOTH_CONNECT);
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                permissions.add(Manifest.permission.NEARBY_WIFI_DEVICES);
                permissions.add(Manifest.permission.POST_NOTIFICATIONS);
            }
            requestPermissions(permissions.toArray(new String[0]), REQUEST_ANDROID_PERMISSIONS);
        }
    }

    @Override
    public void requestRokidAuthorization() {
        RokidAuthorizationFlow.Request request = authorizationFlow.request(this, REQUEST_ROKID_AUTH);
        append("requestAuthorization resultCode=" + request.resultCode + " intent=" + (request.intent == null ? "null" : request.intent));
        if (request.resultCode == Activity.RESULT_OK) {
            handleAuthorizationResult(request.resultCode, request.intent);
            return;
        }
        if (request.intent != null) {
            startActivityForResult(request.intent, REQUEST_ROKID_AUTH);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_ANDROID_RECOGNIZER_INTENT) {
            handleAndroidRecognizerIntentResult(resultCode, data);
            return;
        }
        if (requestCode == REQUEST_PHONE_COMPANION_ASSOCIATION) {
            handlePhoneCompanionAssociationResult(resultCode, data);
            return;
        }
        if (requestCode == REQUEST_ROKID_AUTH) {
            handleAuthorizationResult(resultCode, data);
        }
    }

    private void handlePhoneCompanionAssociationResult(int resultCode, Intent data) {
        String summary = "Phone SDK Companion association result resultCode=" + resultCode;
        append(summary + " data=" + (data == null ? "null" : data.getAction()));
        String detail = "";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && data != null) {
            AssociationInfo info = data.getParcelableExtra(CompanionDeviceManager.EXTRA_ASSOCIATION, AssociationInfo.class);
            if (info != null) {
                detail = "id=" + info.getId()
                        + " displayName=" + safeAssociationText(info.getDisplayName())
                        + " macSuffix=" + addressSuffix(info.getDeviceMacAddress() == null ? "" : info.getDeviceMacAddress().toString());
                append("Phone SDK Companion association info " + detail);
            }
        }
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                resultCode == Activity.RESULT_OK ? "ok" : "partial",
                summary,
                "",
                resultCode == Activity.RESULT_OK ? detail : "用户取消或系统未完成关联"
        );
        if (resultCode == Activity.RESULT_OK) {
            startObservingPhoneCompanionPresence();
            mainHandler.postDelayed(() -> {
                append("Phone SDK Companion association follow-up: rerun device link probe");
                probePhoneDeviceLink();
                probePhoneBtAuth();
            }, 1000L);
        }
        updateDashboard();
    }

    private void handleAuthorizationResult(int resultCode, Intent data) {
        AuthResult result = authorizationFlow.parseResult(resultCode, data);
        append("parseAuthorizationResult=" + result);
        if (result instanceof AuthResult.AuthSuccess) {
            token = authorizationFlow.tokenFrom(result);
            saveToken(token);
            append("Rokid 授权成功，token=" + RokidProbeText.summarizeToken(token));
            recordResult(RokidGlassModule.CAP_APP_AUTH, "ok", "Rokid 授权成功，token=" + RokidProbeText.summarizeToken(token), "", "");
        } else {
            append("Rokid 授权未成功：" + result.getClass().getSimpleName());
            recordResult(RokidGlassModule.CAP_APP_AUTH, "failed", "Rokid 授权未成功", "", result.getClass().getSimpleName());
        }
        updateDashboard();
    }

    @Override
    public void connectCustomViewSession() {
        if (token == null || token.trim().isEmpty()) {
            append("缺少 token，请先请求 Rokid 授权。");
            return;
        }
        resetGlassNativeVoiceState();
        boolean connected = cxrController.connectCustomViewSession(token);
        recordResult(RokidGlassModule.CAP_LINK, connected ? "started" : "failed", "connect(token) returned " + connected, "", "");
        updateDashboard();
    }

    @Override
    public void connectGlassAppSession() {
        if (token == null || token.trim().isEmpty()) {
            append("缺少 token，请先请求 Rokid 授权。");
            return;
        }
        resetGlassNativeVoiceState();
        boolean connected = cxrController.connectGlassAppSession(token);
        recordResult(RokidGlassModule.CAP_GLASS_ASR, connected ? "started" : "failed", "connect CustomApp returned " + connected, "", "");
        updateDashboard();
    }

    @Override
    public void getGlassDeviceInfo() {
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_DEVICE_CONTROL, "failed", "连接层未就绪，不能读取设备信息", "", "link is not ready");
            return;
        }
        cxrController.getGlassDeviceInfo();
        recordResult(RokidGlassModule.CAP_DEVICE_CONTROL, "requested", "已请求 getGlassDeviceInfo", "", "");
        updateDashboard();
    }

    @Override
    public void setBrightnessAndVolume() {
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_DEVICE_CONTROL, "failed", "连接层未就绪，不能设置亮度和音量", "", "link is not ready");
            return;
        }
        boolean ok = cxrController.setBrightnessAndVolume(
                RokidProbeDefaults.GLASS_BRIGHTNESS,
                RokidProbeDefaults.GLASS_VOLUME
        );
        recordResult(RokidGlassModule.CAP_DEVICE_CONTROL, ok ? "ok" : "partial", "brightnessAndVolume=" + ok, "", "");
        updateDashboard();
    }

    @Override
    public void openHelloCustomView() {
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, "failed", "连接层未就绪，不能打开 CustomView", "", "link is not ready");
            return;
        }
        boolean opened = cxrController.openHelloCustomView();
        recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, opened ? "started" : "failed", "customViewOpen returned " + opened, "", "");
        updateDashboard();
    }

    @Override
    public void updateHelloCustomView() {
        if (!isCustomViewOpened()) {
            recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, "failed", "CustomView 未打开，不能更新", "", "custom view is not opened");
            return;
        }
        boolean updated = cxrController.updateHelloCustomView();
        recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, updated ? "ok" : "failed", "customViewUpdate returned " + updated, "", "");
        updateDashboard();
    }

    @Override
    public void closeCustomView() {
        if (!isCustomViewOpened()) {
            recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, "failed", "CustomView 未打开，不能关闭", "", "custom view is not opened");
            return;
        }
        boolean closed = cxrController.closeCustomView();
        recordResult(RokidGlassModule.CAP_CUSTOM_VIEW, closed ? "ok" : "failed", "customViewClose returned " + closed, "", "");
        updateDashboard();
    }

    @Override
    public void startAudioStream() {
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_AUDIO, "failed", "连接层未就绪，不能开始音频流", "", "link is not ready");
            return;
        }
        boolean started = cxrController.startAudioStream();
        audioStreamStarted = started;
        recordResult(RokidGlassModule.CAP_AUDIO, started ? "started" : "failed", "startAudioStream returned " + started, "", "");
        updateDashboard();
    }

    @Override
    public void stopAudioStream() {
        if (!audioStreamStarted) {
            recordResult(RokidGlassModule.CAP_AUDIO, "failed", "音频流未开始，不能停止保存", "", "audio stream is not started");
            return;
        }
        boolean stopped = cxrController.stopAudioStream();
        audioStreamStarted = false;
        String evidencePath = "";
        int audioBytes = cxrController.getAudioBytes();
        if (stopped && audioBytes > 0) {
            evidencePath = saveAudioWav(cxrController.copyAudioPcm());
        }
        String status = stopped && audioBytes > 0 && !evidencePath.isEmpty() ? "ok" : "failed";
        String error = "";
        if (!stopped) {
            error = "stopAudioStream returned false";
        } else if (audioBytes <= 0) {
            error = "没有收到 PCM 音频数据";
        } else if (evidencePath.isEmpty()) {
            error = "WAV 保存失败";
        }
        recordResult(RokidGlassModule.CAP_AUDIO, status, "stopAudioStream returned " + stopped + " bytes=" + audioBytes, evidencePath, error);
        updateDashboard();
    }

    @Override
    public void playLastAudio() {
        if (lastAudioUri == null) {
            append("暂无可播放 WAV，请先开始音频流，然后停止并保存。");
            recordResult(RokidGlassModule.CAP_AUDIO, "failed", "暂无可播放 WAV", "", "lastAudioUri is empty");
            return;
        }
        try {
            releaseAudioPlayer();
            audioPlayer = new MediaPlayer();
            audioPlayer.setDataSource(this, lastAudioUri);
            audioPlayer.setOnCompletionListener(player -> {
                appendOnUi("WAV 播放完成：" + lastAudioUri);
                releaseAudioPlayer();
            });
            audioPlayer.prepare();
            audioPlayer.start();
            append("开始播放 WAV：" + lastAudioUri);
            recordResult(RokidGlassModule.CAP_AUDIO, "started", "开始播放最近 WAV", lastAudioUri.toString(), "");
        } catch (Throwable error) {
            releaseAudioPlayer();
            append("播放 WAV 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
            recordResult(RokidGlassModule.CAP_AUDIO, "failed", "播放 WAV 失败", lastAudioUri.toString(), error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        updateDashboard();
    }

    @Override
    public void stopAudioPlayback() {
        if (audioPlayer == null) {
            append("当前没有正在播放的 WAV。");
            return;
        }
        releaseAudioPlayer();
        append("已停止 WAV 播放。");
        recordResult(RokidGlassModule.CAP_AUDIO, "ok", "已停止 WAV 播放", lastAudioUri == null ? "" : lastAudioUri.toString(), "");
        updateDashboard();
    }

    @Override
    public void takePhoto() {
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_PHOTO, "failed", "连接层未就绪，不能拍照", "", "link is not ready");
            return;
        }
        boolean requested = cxrController.takePhoto();
        recordResult(RokidGlassModule.CAP_PHOTO, requested ? "requested" : "failed", "takePhoto returned " + requested, "", "");
        updateDashboard();
    }

    @Override
    public void queryGlassAsrApp() {
        if (!isGlassAppLinkReady()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "眼镜应用会话未就绪，不能查询安装状态", "", "custom app session is not ready");
            return;
        }
        cxrController.queryGlassAsrApp();
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求查询 Rabi Glass 安装状态", "", "");
        updateDashboard();
    }

    @Override
    public void installGlassAsrApp() {
        if (!isGlassAppLinkReady()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "眼镜应用会话未就绪，不能安装眼镜 APK", "", "custom app session is not ready");
            return;
        }
        try {
            File apk = copyGlassAsrAssetToCache();
            cxrController.installGlassAsrApp(apk.getAbsolutePath());
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求安装内置眼镜 APK，bytes=" + apk.length(), apk.getAbsolutePath(), "");
        } catch (Throwable error) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "复制或安装眼镜 APK 失败", "", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
        updateDashboard();
    }

    @Override
    public void startGlassAsrApp() {
        if (!isGlassAppLinkReady()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "眼镜应用会话未就绪，不能启动 Rabi Glass", "", "custom app session is not ready");
            return;
        }
        cxrController.startGlassAsrApp();
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求启动 Rabi Glass", RokidCxrController.GLASS_ASR_ENTRY, "");
        updateDashboard();
    }

    @Override
    public void stopGlassAsrApp() {
        if (!isGlassAppLinkReady()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "眼镜应用会话未就绪，不能停止 Rabi Glass", "", "custom app session is not ready");
            return;
        }
        cxrController.stopGlassAsrApp();
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求停止 Rabi Glass", "", "");
        updateDashboard();
    }

    @Override
    public void saveNativeVoiceAuthorization() {
        if (uiViews == null) {
            return;
        }
        nativeVoiceAccessKey = uiViews.nativeVoiceAccessKey();
        nativeVoiceSecretKey = uiViews.nativeVoiceSecretKey();
        savePref(PREF_NATIVE_VOICE_ACCESS_KEY, nativeVoiceAccessKey);
        savePref(PREF_NATIVE_VOICE_SECRET_KEY, nativeVoiceSecretKey);
        append("Rokid 在线语音授权已保存 configured=" + nativeVoiceAuthConfigured());
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                nativeVoiceAuthConfigured() ? "checked" : "partial",
                nativeVoiceAuthConfigured()
                        ? "在线语音 AK/SK 已配置；为避免 SDK logcat 泄漏，暂不自动注入 UserAuthInfo"
                        : "在线语音 AK/SK 未完整配置，Phone SDK 仍会使用空 UserAuthInfo",
                "",
                ""
        );
        if (nativeVoiceBridge != null) {
            nativeVoiceBridge.updateUserAuth(nativeVoiceAccessKey, nativeVoiceSecretKey);
        }
        updateDashboard();
    }

    @Override
    public void pingNativeVoiceBridge() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能 Ping 眼镜", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_PING");
        nativeVoiceBridge.pingGlass();
        markNativeVoicePending("ping", "等待眼镜 Pong");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已向眼镜发送原生消息 Ping", "", "");
        updateDashboard();
    }

    @Override
    public void queryNativeVoiceStatus() {
        sendNativeStatusCommand();
    }

    @Override
    public void queryNativeVoiceDiagnostics() {
        sendNativeDiagnosticsCommand();
    }

    @Override
    public void startNativeAsrRemote() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能远程启动 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_ASR_START");
        nativeVoiceBridge.startGlassAsr();
        markNativeVoicePending("asr_start", "等待眼镜 ASR 启动 ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已向眼镜发送远程开始 ASR 命令", "", "");
        updateDashboard();
    }

    @Override
    public void stopNativeAsrRemote() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能远程停止 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_ASR_STOP");
        nativeVoiceBridge.stopGlassAsr();
        markNativeVoicePending("asr_stop", "等待眼镜 ASR 停止 ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已向眼镜发送远程停止 ASR 命令", "", "");
        updateDashboard();
    }

    @Override
    public void sendNativeTtsTest() {
        String text = uiViews == null ? "Rabi 原生 TTS 测试" : uiViews.nativeTtsText("Rabi 原生 TTS 测试");
        sendNativeTtsText(text, "已向眼镜发送原生 TTS 测试文本：");
    }

    private void sendNativeTtsText(String text, String summaryPrefix) {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能发送 TTS", "", "nativeVoiceBridge is null");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            text = "Rabi 原生 TTS 测试";
        }
        text = text.trim();
        sendNativeVoiceCustomCmd("RABI_TTS:" + text);
        nativeVoiceBridge.sendTtsTest(text);
        markNativeVoicePending("tts", "等待眼镜 TTS ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", summaryPrefix + text, "", "");
        updateDashboard();
    }

    @Override
    public void startNativeEchoTest() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能启动 ASR 回声测试", "", "nativeVoiceBridge is null");
            return;
        }
        nativeEchoNextAsr = true;
        lastNativeLoopback = "等待下一条 ASR 文本";
        sendNativeVoiceCustomCmd("RABI_ASR_START");
        nativeVoiceBridge.startGlassAsr();
        markNativeVoicePending("asr_echo_start", "等待眼镜 ASR 启动 ACK，下一条 ASR 文本会自动转 TTS");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已启动 ASR 回声测试：下一条 ASR 文本会自动发回眼镜 TTS", "", "");
        updateDashboard();
    }

    @Override
    public void armOfflineVoiceCommands() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能注册眼镜离线语音指令", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_OFFLINE_CMD_ARM");
        markNativeVoicePending("offline_cmd_arm", "等待眼镜离线语音指令注册结果");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜注册离线语音指令：测试中文 / 打开Rabi / 关闭Rabi", "", "");
        updateDashboard();
    }

    @Override
    public void clearOfflineVoiceCommands() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能清除眼镜离线语音指令", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_OFFLINE_CMD_CLEAR");
        markNativeVoicePending("offline_cmd_clear", "等待眼镜离线语音指令清除结果");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜清除离线语音指令", "", "");
        updateDashboard();
    }

    @Override
    public void probeGlassAndroidVoice() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能检查眼镜 Android 系统语音", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ANDROID_VOICE_PROBE");
        markNativeVoicePending("glass_android_voice", "等待眼镜 Android 系统语音状态");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 Android SpeechRecognizer/TextToSpeech 状态", "", "");
        updateDashboard();
    }

    @Override
    public void startGlassAndroidAsr() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能启动眼镜 Android 系统 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ANDROID_ASR_START");
        markNativeVoicePending("glass_android_asr_start", "等待眼镜 Android 系统 ASR 启动 ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 Android 系统 ASR startListening", "", "");
        updateDashboard();
    }

    @Override
    public void stopGlassAndroidAsr() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能停止眼镜 Android 系统 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ANDROID_ASR_STOP");
        markNativeVoicePending("glass_android_asr_stop", "等待眼镜 Android 系统 ASR 停止 ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 Android 系统 ASR stopListening", "", "");
        updateDashboard();
    }

    @Override
    public void sendGlassAndroidTtsTest() {
        String text = uiViews == null ? "Rabi 眼镜系统 TTS 测试" : uiViews.nativeTtsText("Rabi 眼镜系统 TTS 测试");
        sendGlassAndroidTtsText(text);
    }

    private void sendGlassAndroidTtsText(String text) {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能发送眼镜 Android 系统 TTS", "", "nativeVoiceBridge is null");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            text = "Rabi 眼镜系统 TTS 测试";
        }
        text = text.trim();
        sendNativeVoiceCustomCmd("RABI_GLASS_ANDROID_TTS:" + text);
        markNativeVoicePending("glass_android_tts", "等待眼镜 Android 系统 TTS ACK");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 Android 系统 TTS 播报：" + text, "", "");
        updateDashboard();
    }

    @Override
    public void probeGlassRokidAiSdk() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能检查眼镜 RokidAiSdk", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_PROBE");
        markNativeVoicePending("glass_rokid_ai_probe", "等待眼镜端 RokidAiSdk readiness");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 RokidAiSdk 状态", "", "会回传 assets/nativeAbi/recordAudioPermission/credentials/serviceConnected/recording");
        updateDashboard();
    }

    @Override
    public void saveAndSendGlassRokidAiSdkConfig() {
        if (uiViews == null) {
            return;
        }
        saveRokidAiSdkCredentials(uiViews.rokidAiSdkCredentials());
        RokidAiSdkVoiceBridge.Credentials credentials = currentRokidAiSdkCredentials();
        if (!credentials.isComplete()) {
            recordResult(
                    RokidGlassModule.CAP_GLASS_ASR,
                    "partial",
                    "眼镜侧 RokidAiSdk 配置未发送：缺少开放平台字段",
                    "",
                    "missing " + credentials.missingFields()
            );
            updateDashboard();
            return;
        }
        if (!isGlassAppLinkReady() || !glassAsrAppStarted) {
            recordResult(
                    RokidGlassModule.CAP_GLASS_ASR,
                    "failed",
                    "眼镜应用未就绪，不能发送 RokidAiSdk 配置",
                    "",
                    "需要先连接应用会话、安装并启动眼镜 APK"
            );
            updateDashboard();
            return;
        }
        sendRokidAiSdkConfigToGlass(credentials);
        updateDashboard();
    }

    @Override
    public void startGlassRokidAiSdk() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能启动眼镜 RokidAiSdk", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_START");
        markNativeVoicePending("glass_rokid_ai_start", "等待眼镜端 RokidAiSdk 启动结果");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 RokidAiSdk 启动", "", "需要先通过 secrets 配置 key/secret/deviceTypeId/deviceId/seed");
        updateDashboard();
    }

    @Override
    public void stopGlassRokidAiSdk() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能停止眼镜 RokidAiSdk", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_STOP");
        markNativeVoicePending("glass_rokid_ai_stop", "等待眼镜端 RokidAiSdk 停止结果");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 RokidAiSdk 停止", "", "");
        updateDashboard();
    }

    @Override
    public void sendGlassRokidAiSdkTtsTest() {
        String text = uiViews == null ? "Rabi 眼镜 AI SDK TTS 测试" : uiViews.nativeTtsText("Rabi 眼镜 AI SDK TTS 测试");
        if (text == null || text.trim().isEmpty()) {
            text = "Rabi 眼镜 AI SDK TTS 测试";
        }
        text = text.trim();
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 消息桥未初始化，不能发送眼镜 RokidAiSdk TTS", "", "nativeVoiceBridge is null");
            return;
        }
        sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_TTS:" + text);
        markNativeVoicePending("glass_rokid_ai_tts", "等待眼镜端 RokidAiSdk TTS 请求结果");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已请求眼镜端 RokidAiSdk TTS：" + text, "", "需要眼镜端 RokidAiSdk serviceConnected=true");
        updateDashboard();
    }

    @Override
    public void scanPhoneBt() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能扫描 BT", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.startPhoneBtScan(RokidNativeVoiceBridge.PHONE_BT_SCAN_DURATION_MS);
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK ClassicBT 扫描请求 " + requested,
                "",
                requested ? "等待 Phone SDK BT scan found/finished 日志" : "ClassicBluetooth service 不可用或扫描请求失败"
        );
        updateDashboard();
    }

    @Override
    public void probePhoneDeviceLink() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能跑官方连接探针", "", "nativeVoiceBridge is null");
            return;
        }
        startObservingPhoneCompanionPresence();
        boolean requested = nativeVoiceBridge.probePhoneDeviceLink();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK 官方连接探针请求 " + requested,
                "",
                requested ? "按官方流程 scan ClassicBT -> connect BT -> probe P2P；等待 device link 日志" : "ClassicBluetooth service 不可用或请求失败"
        );
        updateDashboard();
    }

    @Override
    public void associatePhoneCompanionDevice() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联不可用", "", "requires Android O+");
            updateDashboard();
            return;
        }
        BluetoothDevice target = findBondedRokidGlassCandidate();
        if (target == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "没有找到已配对 Rokid/Glass 候选，不能发起系统关联", "", "bonded candidate not found");
            updateDashboard();
            return;
        }
        String address = safeDeviceAddress(target);
        if (address.isEmpty()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "无法读取眼镜蓝牙地址，不能发起系统关联", "", "BLUETOOTH_CONNECT permission may be missing");
            updateDashboard();
            return;
        }
        CompanionDeviceManager manager = (CompanionDeviceManager) getSystemService(COMPANION_DEVICE_SERVICE);
        if (manager == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "CompanionDeviceManager 不可用", "", "system service is null");
            updateDashboard();
            return;
        }
        String safeTarget = describeBluetoothDeviceSafe(target);
        append("Phone SDK Companion association requested target=" + safeTarget);
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                "requested",
                "系统 Companion 关联请求 target=" + safeTarget,
                "",
                "会打开 Android 系统关联界面；确认后自动回跑 Phone SDK 官方连接探针"
        );
        updateDashboard();
        try {
            BluetoothDeviceFilter filter = new BluetoothDeviceFilter.Builder()
                    .setAddress(address)
                    .build();
            AssociationRequest request = new AssociationRequest.Builder()
                    .addDeviceFilter(filter)
                    .setSingleDevice(true)
                    .build();
            CompanionDeviceManager.Callback callback = new CompanionDeviceManager.Callback() {
                @Override
                public void onAssociationPending(IntentSender intentSender) {
                    append("Phone SDK Companion association pending; launching chooser target=" + safeTarget);
                    launchPhoneCompanionAssociation(intentSender);
                }

                @Override
                public void onDeviceFound(IntentSender intentSender) {
                    append("Phone SDK Companion association device found; launching chooser target=" + safeTarget);
                    launchPhoneCompanionAssociation(intentSender);
                }

                @Override
                public void onAssociationCreated(AssociationInfo associationInfo) {
                    append("Phone SDK Companion association created "
                            + (associationInfo == null ? "info=null" : "id=" + associationInfo.getId()
                            + " displayName=" + safeAssociationText(associationInfo.getDisplayName())));
                    recordResult(
                            RokidGlassModule.CAP_GLASS_ASR,
                            "ok",
                            "系统 Companion 关联已创建",
                            "",
                            associationInfo == null ? "" : "id=" + associationInfo.getId()
                    );
                    startObservingPhoneCompanionPresence();
                    mainHandler.postDelayed(() -> {
                        append("Phone SDK Companion association created follow-up: rerun device link probe");
                        probePhoneDeviceLink();
                        probePhoneBtAuth();
                    }, 1000L);
                }

                @Override
                public void onFailure(CharSequence error) {
                    String message = error == null ? "unknown" : error.toString();
                    append("Phone SDK Companion association failure=" + message);
                    recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联失败", "", message);
                    updateDashboard();
                }
            };
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                Executor executor = command -> runOnUiThread(command);
                manager.associate(request, executor, callback);
            } else {
                manager.associate(request, callback, null);
            }
        } catch (SecurityException error) {
            append("Phone SDK Companion association security error=" + error.getMessage());
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联缺少权限", "", error.getClass().getSimpleName() + ": " + error.getMessage());
            updateDashboard();
        } catch (Throwable error) {
            append("Phone SDK Companion association error=" + error.getClass().getSimpleName() + ": " + error.getMessage());
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联异常", "", error.getClass().getSimpleName() + ": " + error.getMessage());
            updateDashboard();
        }
    }

    @Override
    public void connectPhoneBt() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能连接 BT", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.connectPhoneBtBondedGlass();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK 已配对眼镜 BT 连接请求 " + requested,
                "",
                requested ? "等待 Phone SDK BT connect callback 和 BT/Auth 日志" : "没有已配对眼镜候选，或 ClassicBluetooth service 不可用"
        );
        updateDashboard();
    }

    @Override
    public void probePhoneBtAuth() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能检查 BT/Auth 状态", "", "nativeVoiceBridge is null");
            return;
        }
        RokidNativeVoiceBridge.PhoneBtAuthProbe probe = nativeVoiceBridge.probePhoneBtAuth(true);
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                probe.getReadyForDeviceMessages() ? "ok" : "partial",
                "Phone SDK BT/Auth readiness：" + probe.summary(),
                "",
                probe.getReadyForDeviceMessages() ? "" : "需要 ClassicBT message 通道连接且 deviceAuth=true，Phone SDK 设备消息才会有回包"
        );
        updateDashboard();
    }

    @Override
    public void probePhoneP2p() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能检查 P2P 状态", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.probePhoneP2pConnection();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK P2P 探针请求 " + requested,
                "",
                requested ? "先检查 isConnect，再按官方流程尝试 sendConnectP2pRequest / discover peers" : "WifiP2PClientService 不可用或请求失败"
        );
        updateDashboard();
    }

    @Override
    public void requestPhoneSystemInfo() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能请求官方系统信息", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.requestPhoneOfficialSystemInfo();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK 官方系统信息请求 " + requested,
                "",
                requested ? "按官方 sample 向 RokidESecurity 发送 GET_SYSTEM_INFO，等待 SYSTEM_INFO_RESPONSE" : "MessageService 不可用或发送失败"
        );
        updateDashboard();
    }

    @Override
    public void requestPhoneDeviceAudioHandshake() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能触发手机设备握手", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.requestPhoneDeviceAudioHandshake();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK 设备服务音频握手请求 " + requested,
                "",
                requested ? "等待 Phone SDK device audio handshake callback；随后再检查 phone_device_info" : "AbsDeviceInfoService 不可用或请求失败"
        );
        updateDashboard();
    }

    @Override
    public void requestPhoneDeviceVideoAudioHandshake() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能触发视频+音频握手", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.requestPhoneDeviceVideoAudioHandshake();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                requested ? "requested" : "failed",
                "Phone SDK 设备服务视频+音频握手请求 " + requested,
                "",
                requested ? "按官方 demo 顺序等待 first video，再请求 audio；随后检查 phone_device_info" : "AbsDeviceInfoService 不可用或请求失败"
        );
        updateDashboard();
    }

    @Override
    public void probePhoneGlassDeviceInfo() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能检查手机侧眼镜设备信息", "", "nativeVoiceBridge is null");
            return;
        }
        RokidNativeVoiceBridge.PhoneGlassDeviceInfoProbe probe = nativeVoiceBridge.probePhoneGlassDeviceInfo(true);
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                probe.getReadyForAppToken() ? "ok" : "partial",
                "Phone SDK GlassDeviceInfo readiness：" + probe.summary(),
                "",
                probe.getReadyForAppToken() ? "" : "需要 Phone SDK 缓存到眼镜 deviceId，才能生成手机侧在线语音 app token"
        );
        updateDashboard();
    }

    @Override
    public void probePhoneVoiceAuthorization() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能检查手机语音授权", "", "nativeVoiceBridge is null");
            return;
        }
        RokidNativeVoiceBridge.PhoneVoiceAuthProbe probe = nativeVoiceBridge.probePhoneVoiceAuthorization(true);
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                probe.getReadyForOnlineVoice() ? "ok" : "partial",
                "手机侧在线语音授权 readiness：" + probe.summary(),
                "",
                probe.getReadyForOnlineVoice() ? "" : "缺少 x-app-authorization；未就绪时不展示在线 ASR/TTS 测试按钮"
        );
        updateDashboard();
    }

    @Override
    public void applyPhoneVoiceAuthorization() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能激活手机语音授权", "", "nativeVoiceBridge is null");
            return;
        }
        RokidNativeVoiceBridge.PhoneVoiceAuthProbe probe = nativeVoiceBridge.applyPhoneVoiceAuthorization();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                probe.getReadyForOnlineVoice() ? "ok" : "partial",
                "手机侧在线语音授权激活：" + probe.summary(),
                "",
                probe.getReadyForOnlineVoice() ? "" : "需要完整 AK/SK 和 Phone SDK GlassDeviceInfo"
        );
        updateDashboard();
    }

    @Override
    public void initPhoneVoiceProbe() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能初始化手机语音引擎", "", "nativeVoiceBridge is null");
            return;
        }
        boolean started = nativeVoiceBridge.initPhoneVoiceProbe();
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                started ? "requested" : "failed",
                "手机侧 Rokid ASR/TTS 引擎初始化请求 " + started,
                "",
                started ? "" : "see fixed log"
        );
        updateDashboard();
    }

    @Override
    public void startPhoneAsrFeed() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能启动手机 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        if (!isLinkReady()) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "CXR 链路未就绪，不能把眼镜音频流喂给手机 ASR", "", "link is not ready");
            return;
        }
        boolean asrStarted = nativeVoiceBridge.startPhoneAsrFeed();
        boolean audioStarted = audioStreamStarted || cxrController.startAudioStream();
        audioStreamStarted = audioStarted;
        markNativeVoicePending("phone_asr", "手机 SDK ASR 已请求；等待 CXR 音频流和 ASR 回调");
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                asrStarted && audioStarted ? "requested" : "partial",
                "手机侧 ASR 喂音频 asrStarted=" + asrStarted + " audioStarted=" + audioStarted,
                "",
                asrStarted && audioStarted ? "" : "ASR 或 CXR 音频未完全启动"
        );
        updateDashboard();
    }

    @Override
    public void stopPhoneAsrFeed() {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能停止手机 ASR", "", "nativeVoiceBridge is null");
            return;
        }
        boolean stopped = nativeVoiceBridge.stopPhoneAsrFeed();
        clearNativeVoicePending();
        recordResult(RokidGlassModule.CAP_GLASS_ASR, stopped ? "ok" : "failed", "手机侧 ASR 停止请求 " + stopped, "", stopped ? "" : "see fixed log");
        updateDashboard();
    }

    @Override
    public void sendPhoneTtsTest() {
        String text = uiViews == null ? "Rabi 手机侧 Rokid TTS 测试" : uiViews.nativeTtsText("Rabi 手机侧 Rokid TTS 测试");
        sendPhoneTtsText(text);
    }

    private void sendPhoneTtsText(String text) {
        if (nativeVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "Phone SDK 未初始化，不能发送手机 TTS", "", "nativeVoiceBridge is null");
            return;
        }
        boolean requested = nativeVoiceBridge.sendPhoneTts(text);
        markNativeVoicePending("phone_tts", "等待手机侧 Rokid TTS 音频/完成回调");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, requested ? "requested" : "failed", "手机侧 Rokid TTS 请求 " + requested + " text=" + text, "", requested ? "" : "see fixed log");
        updateDashboard();
    }

    @Override
    public void probeAndroidSystemVoice() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化", "", "androidSystemVoiceBridge is null");
            return;
        }
        RokidAndroidSystemVoiceBridge.Probe probe = androidSystemVoiceBridge.probe();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                probe.readyForAsr() || probe.readyForTts() ? "checked" : "failed",
                "Android 系统语音 readiness：" + probe.summary(),
                "",
                probe.readyForAsr() || probe.readyForTts() ? "" : "SpeechRecognizer/TTS 均不可用或缺权限"
        );
        updateDashboard();
    }

    @Override
    public void routeAndroidSystemBluetooth() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能路由蓝牙", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean routed = androidSystemVoiceBridge.routeBluetoothForSystemVoice();
        RokidAndroidSystemVoiceBridge.Probe probe = androidSystemVoiceBridge.probe();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                routed ? "ok" : "partial",
                "Android 系统语音蓝牙路由请求 " + routed + "；" + probe.summary(),
                "",
                routed ? "后续系统 ASR/TTS 会优先请求蓝牙通信设备" : "未能确认蓝牙 SCO/通信设备已激活"
        );
        updateDashboard();
    }

    @Override
    public void clearAndroidSystemBluetooth() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能清除蓝牙路由", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean cleared = androidSystemVoiceBridge.clearBluetoothRoute();
        RokidAndroidSystemVoiceBridge.Probe probe = androidSystemVoiceBridge.probe();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                cleared ? "ok" : "partial",
                "Android 系统语音蓝牙路由清除 " + cleared + "；" + probe.summary(),
                "",
                ""
        );
        updateDashboard();
    }

    @Override
    public void startAndroidHeadsetVoiceRecognition() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能启动耳机语音通道", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean requested = androidSystemVoiceBridge.startBluetoothHeadsetVoiceRecognition();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                requested ? "requested" : "failed",
                "Android BluetoothHeadset.startVoiceRecognition 请求 " + requested,
                "",
                requested ? "等待 HEADSET profile 回调、startVoiceRecognition 和蓝牙路由日志" : "getProfileProxy 失败或缺蓝牙权限"
        );
        updateDashboard();
    }

    @Override
    public void stopAndroidHeadsetVoiceRecognition() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能停止耳机语音通道", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean stopped = androidSystemVoiceBridge.stopBluetoothHeadsetVoiceRecognition();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                stopped ? "ok" : "partial",
                "Android BluetoothHeadset.stopVoiceRecognition 请求 " + stopped,
                "",
                stopped ? "" : "可能没有已激活的 HEADSET voice recognition"
        );
        updateDashboard();
    }

    @Override
    public void startAndroidSystemAsr() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能启动 ASR", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean requested = androidSystemVoiceBridge.startAsr();
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                requested ? "requested" : "failed",
                "Android 系统 ASR startListening 请求 " + requested,
                "",
                requested ? "开始后请对手机或眼镜说话，等待 partial/final 文本" : "SpeechRecognizer 不可用或缺权限"
        );
        updateDashboard();
    }

    @Override
    public void startAndroidSystemAsrIntent() {
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.CHINESE.toLanguageTag());
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
        intent.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说一句用于 Rabi Link 测试的话");
        intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
        try {
            startActivityForResult(intent, REQUEST_ANDROID_RECOGNIZER_INTENT);
            recordResult(
                    RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                    "requested",
                    "Android 前台系统 ASR 已启动，等待系统识别界面返回文本",
                    "",
                    ""
            );
            append("Android 前台系统 ASR 已启动：请在系统识别界面对手机或眼镜说话。");
        } catch (ActivityNotFoundException | SecurityException error) {
            String message = error.getClass().getSimpleName() + ": " + error.getMessage();
            lastAndroidSystemVoiceError = "android_asr_intent / " + message;
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 前台系统 ASR 启动失败", "", message);
            append("Android 前台系统 ASR 启动失败：" + message);
        }
        updateDashboard();
    }

    @Override
    public void stopAndroidSystemAsr() {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能停止 ASR", "", "androidSystemVoiceBridge is null");
            return;
        }
        boolean stopped = androidSystemVoiceBridge.stopAsr();
        recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, stopped ? "ok" : "failed", "Android 系统 ASR 停止请求 " + stopped, "", "");
        updateDashboard();
    }

    private void handleAndroidRecognizerIntentResult(int resultCode, Intent data) {
        ArrayList<String> results = data == null ? null : data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
        String text = results == null || results.isEmpty() || results.get(0) == null ? "" : results.get(0);
        if (resultCode == Activity.RESULT_OK && !text.trim().isEmpty()) {
            lastAndroidSystemAsrText = text.trim();
            lastAndroidSystemVoiceError = "";
            String summary = "Android 前台系统 ASR final=" + lastAndroidSystemAsrText;
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "ok", summary, "", "");
            append(summary);
        } else {
            String reason = "resultCode=" + resultCode + " text=" + (text == null ? "" : text);
            lastAndroidSystemVoiceError = "android_asr_intent / " + reason;
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 前台系统 ASR 未返回文本", "", reason);
            append("Android 前台系统 ASR 未返回文本：" + reason);
        }
        updateDashboard();
    }


    @Override
    public void sendAndroidSystemTtsTest() {
        String text = uiViews == null ? "Rabi Android 系统 TTS 测试" : uiViews.nativeTtsText("Rabi Android 系统 TTS 测试");
        sendAndroidSystemTtsText(text);
    }

    @Override
    public void startAndroidSystemLoopback() {
        String text = uiViews == null ? "打开星门" : uiViews.nativeTtsText("打开星门");
        startAndroidSystemLoopback(text);
    }

    private void startAndroidSystemLoopback(String text) {
        if (text == null || text.trim().isEmpty()) {
            text = "打开星门";
        }
        boolean asrRequested = androidSystemVoiceBridge != null && androidSystemVoiceBridge.startAsr();
        String requestedText = text;
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                asrRequested ? "requested" : "failed",
                "Android 系统语音回环 ASR 请求 " + asrRequested + " text=" + requestedText,
                "",
                asrRequested ? "等待 TTS 播放和 ASR final 文本" : "ASR 未启动"
        );
        append("Android 系统语音回环：ASR=" + asrRequested + "，准备 TTS=" + requestedText);
        if (asrRequested && logView != null) {
            logView.postDelayed(() -> sendAndroidSystemTtsText(requestedText), 900L);
        }
        updateDashboard();
    }

    private void sendAndroidSystemTtsText(String text) {
        if (androidSystemVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", "Android 系统语音桥未初始化，不能 TTS", "", "androidSystemVoiceBridge is null");
            return;
        }
        if (text == null || text.trim().isEmpty()) {
            text = "Rabi Android 系统 TTS 测试";
        }
        boolean requested = androidSystemVoiceBridge.speak(text);
        recordResult(
                RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                requested ? "requested" : "failed",
                "Android 系统 TTS speak 请求 " + requested + " text=" + text,
                "",
                requested ? "等待 TextToSpeech onDone 回调；是否从眼镜播出需要现场听感确认" : "TTS 未 ready 或 speak 返回失败"
        );
        updateDashboard();
    }

    @Override
    public void probeRokidAiSdkVoice() {
        if (rokidAiSdkVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", "RokidAiSdk 语音桥未初始化", "", "rokidAiSdkVoiceBridge is null");
            return;
        }
        RokidAiSdkVoiceBridge.ProbeResult probe = rokidAiSdkVoiceBridge.probe();
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                probe.readyToStart() ? "checked" : "partial",
                "RokidAiSdk readiness：" + probe.summary,
                "",
                probe.readyToStart() ? "" : "需要补齐 assets/armeabi-v7a 运行环境/麦克风权限/开放平台凭证"
        );
        append("RokidAiSdk readiness：" + probe.summary);
        updateDashboard();
    }

    @Override
    public void saveRokidAiSdkConfig() {
        if (uiViews != null) {
            saveRokidAiSdkCredentials(uiViews.rokidAiSdkCredentials());
        }
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                rokidAiSdkConfigured() ? "checked" : "partial",
                rokidAiSdkConfigured()
                        ? "RokidAiSdk 配置已保存：" + currentRokidAiSdkCredentials().summary()
                        : "RokidAiSdk 配置已保存但不完整：" + currentRokidAiSdkCredentials().summary(),
                "",
                rokidAiSdkConfigured() ? "" : "missing " + currentRokidAiSdkCredentials().missingFields()
        );
        updateDashboard();
    }

    @Override
    public void startRokidAiSdkAsr() {
        if (rokidAiSdkVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", "RokidAiSdk 语音桥未初始化，不能启动 ASR", "", "rokidAiSdkVoiceBridge is null");
            return;
        }
        boolean started = rokidAiSdkVoiceBridge.start();
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                started ? "requested" : "failed",
                "RokidAiSdk ASR start 请求 " + started,
                "",
                started ? "等待 service connected、record socket 和 ASR final 文本" : "见固定日志中的 readiness/error"
        );
        updateDashboard();
    }

    @Override
    public void stopRokidAiSdkVoice() {
        if (rokidAiSdkVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", "RokidAiSdk 语音桥未初始化，不能停止", "", "rokidAiSdkVoiceBridge is null");
            return;
        }
        boolean stopped = rokidAiSdkVoiceBridge.stop();
        recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, stopped ? "ok" : "partial", "RokidAiSdk stop 请求 " + stopped, "", "");
        updateDashboard();
    }

    @Override
    public void sendRokidAiSdkTtsTest() {
        String text = uiViews == null ? "Rabi Rokid AI SDK TTS 测试" : uiViews.nativeTtsText("Rabi Rokid AI SDK TTS 测试");
        sendRokidAiSdkTtsText(text);
    }

    @Override
    public void enableRokidAiSdkPickup() {
        setRokidAiSdkPickup(true);
    }

    @Override
    public void disableRokidAiSdkPickup() {
        setRokidAiSdkPickup(false);
    }

    private void setRokidAiSdkPickup(boolean enabled) {
        if (rokidAiSdkVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", "RokidAiSdk 语音桥未初始化，不能设置拾音", "", "rokidAiSdkVoiceBridge is null");
            return;
        }
        boolean requested = rokidAiSdkVoiceBridge.setPickUp(enabled);
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                requested ? "requested" : "failed",
                "RokidAiSdk setPickUp(" + enabled + ") 请求 " + requested,
                "",
                requested ? "开启后请对手机/眼镜说话，等待 ASR partial/final 文本" : "service 未连接或 setPickUp 失败"
        );
        updateDashboard();
    }

    private void sendRokidAiSdkTtsText(String text) {
        if (rokidAiSdkVoiceBridge == null) {
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", "RokidAiSdk 语音桥未初始化，不能 TTS", "", "rokidAiSdkVoiceBridge is null");
            return;
        }
        boolean requested = rokidAiSdkVoiceBridge.speak(text);
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                requested ? "requested" : "failed",
                "RokidAiSdk TTS 请求 " + requested + " text=" + text,
                "",
                requested ? "是否从眼镜或手机播出需要现场听感确认" : "service 未连接或 speak 失败"
        );
        updateDashboard();
    }

    @Override
    public void copyReport() {
        reportClipboard.copy(this, report.text());
    }

    private void saveJpeg(byte[] data) {
        try {
            Uri uri = RokidPhotoStore.saveJpeg(this, data);
            appendOnUi("JPEG 已保存：" + uri);
            recordResultOnUi(RokidGlassModule.CAP_PHOTO, "ok", "JPEG bytes=" + data.length, uri.toString(), "");
            runOnUiThread(this::updateDashboard);
        } catch (Throwable error) {
            appendOnUi("保存 JPEG 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
            recordResultOnUi(RokidGlassModule.CAP_PHOTO, "failed", "保存 JPEG 失败", "", error.getClass().getSimpleName() + ": " + error.getMessage());
            runOnUiThread(this::updateDashboard);
        }
    }

    private String saveAudioWav(byte[] pcm) {
        try {
            Uri uri = RokidAudioStore.saveWav(this, pcm);
            lastAudioUri = uri;
            append("WAV 已保存：" + uri);
            return uri.toString();
        } catch (Throwable error) {
            append("保存 WAV 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
            return "";
        }
    }

    private File copyGlassAsrAssetToCache() throws Exception {
        File dir = new File(getCacheDir(), "rokid");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IllegalStateException("cannot create " + dir.getAbsolutePath());
        }
        File apk = new File(dir, GLASS_ASR_ASSET);
        try (InputStream input = getAssets().open(GLASS_ASR_ASSET);
             FileOutputStream output = new FileOutputStream(apk)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        append("眼镜 APK 已复制到缓存：" + apk.getAbsolutePath() + " bytes=" + apk.length());
        return apk;
    }

    private BluetoothDevice findBondedRokidGlassCandidate() {
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter == null) {
                append("Phone SDK Companion association skipped: BluetoothAdapter=null");
                return null;
            }
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded == null || bonded.isEmpty()) {
                append("Phone SDK Companion association skipped: bonded devices empty");
                return null;
            }
            BluetoothDevice firstGlass = null;
            for (BluetoothDevice device : bonded) {
                String name = safeDeviceName(device);
                if (!isLikelyRokidGlassName(name)) {
                    continue;
                }
                if (name.toLowerCase(Locale.ROOT).contains("rokid")) {
                    return device;
                }
                if (firstGlass == null) {
                    firstGlass = device;
                }
            }
            return firstGlass;
        } catch (SecurityException error) {
            append("Phone SDK Companion association cannot read bonded devices: " + error.getMessage());
            return null;
        }
    }

    private boolean isLikelyRokidGlassName(String name) {
        if (name == null) {
            return false;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        return lower.contains("rokid") || lower.contains("glass") || lower.contains("glasses");
    }

    private String describeBluetoothDeviceSafe(BluetoothDevice device) {
        if (device == null) {
            return "null";
        }
        String name = safeDeviceName(device);
        String displayName = isLikelyRokidGlassName(name) ? name : "nonRokidDevice";
        return "name=" + displayName + " addressSuffix=" + addressSuffix(safeDeviceAddress(device));
    }

    private String safeDeviceName(BluetoothDevice device) {
        if (device == null) {
            return "";
        }
        try {
            String name = device.getName();
            return name == null ? "" : name.trim();
        } catch (SecurityException error) {
            return "";
        }
    }

    private String safeDeviceAddress(BluetoothDevice device) {
        if (device == null) {
            return "";
        }
        try {
            String address = device.getAddress();
            return address == null ? "" : address.trim();
        } catch (SecurityException error) {
            return "";
        }
    }

    private String addressSuffix(String address) {
        if (address == null || address.trim().isEmpty()) {
            return "unknown";
        }
        String cleaned = address.trim();
        if (cleaned.length() <= 5) {
            return cleaned;
        }
        return cleaned.substring(cleaned.length() - 5);
    }

    private String safeAssociationText(CharSequence text) {
        return text == null ? "" : text.toString().trim();
    }

    private void launchPhoneCompanionAssociation(IntentSender intentSender) {
        if (intentSender == null) {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联没有返回启动器", "", "intentSender is null");
            updateDashboard();
            return;
        }
        try {
            startIntentSenderForResult(intentSender, REQUEST_PHONE_COMPANION_ASSOCIATION, null, 0, 0, 0);
        } catch (IntentSender.SendIntentException error) {
            append("Phone SDK Companion association launch failed=" + error.getMessage());
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "系统 Companion 关联界面启动失败", "", error.getClass().getSimpleName() + ": " + error.getMessage());
            updateDashboard();
        }
    }

    private void startObservingPhoneCompanionPresence() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return;
        }
        BluetoothDevice target = findBondedRokidGlassCandidate();
        String address = safeDeviceAddress(target);
        if (address.isEmpty()) {
            append("Phone SDK Companion observe skipped: no bonded target address");
            return;
        }
        CompanionDeviceManager manager = (CompanionDeviceManager) getSystemService(COMPANION_DEVICE_SERVICE);
        if (manager == null) {
            append("Phone SDK Companion observe skipped: manager=null");
            return;
        }
        try {
            manager.startObservingDevicePresence(address);
            append("Phone SDK Companion observing presence addressSuffix=" + addressSuffix(address));
        } catch (SecurityException error) {
            append("Phone SDK Companion observe security error=" + error.getMessage());
        } catch (Throwable error) {
            append("Phone SDK Companion observe error=" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void appendOnUi(String line) {
        runOnUiThread(() -> {
            append(line);
            updateDashboard();
        });
    }

    private void recordResult(String capabilityId, String status, String summary, String evidencePath, String error) {
        report.record(logView, capabilityId, status, summary, evidencePath, error);
        if (uiViews != null) {
            String detail = summary;
            if (evidencePath != null && !evidencePath.isEmpty()) {
                detail += "\n证据：" + evidencePath;
            }
            if (error != null && !error.isEmpty()) {
                detail += "\n错误：" + error;
            }
            uiViews.setCapabilityStatus(capabilityId, status, detail);
        }
    }

    private void recordResultOnUi(String capabilityId, String status, String summary, String evidencePath, String error) {
        runOnUiThread(() -> recordResult(capabilityId, status, summary, evidencePath, error));
    }

    private void append(String line) {
        Log.d(TAG, line);
        report.append(logView, line);
    }

    private String loadSavedToken() {
        return loadSavedPref(PREF_ROKID_TOKEN);
    }

    private String loadSavedPref(String key) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        return prefs.getString(key, "");
    }

    private void saveToken(String value) {
        savePref(PREF_ROKID_TOKEN, value);
    }

    private void savePref(String key, String value) {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit()
                .putString(key, value == null ? "" : value)
                .apply();
    }

    private void loadRokidAiSdkConfig() {
        rokidAiKey = loadSavedPref(PREF_ROKID_AI_KEY);
        rokidAiSecret = loadSavedPref(PREF_ROKID_AI_SECRET);
        rokidAiDeviceTypeId = loadSavedPref(PREF_ROKID_AI_DEVICE_TYPE_ID);
        rokidAiDeviceId = loadSavedPref(PREF_ROKID_AI_DEVICE_ID);
        rokidAiSeed = loadSavedPref(PREF_ROKID_AI_SEED);
        String savedWorkDir = loadSavedPref(PREF_ROKID_AI_WORK_DIR);
        String savedConfigFile = loadSavedPref(PREF_ROKID_AI_CONFIG_FILE);
        rokidAiWorkDir = savedWorkDir == null || savedWorkDir.trim().isEmpty()
                ? RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR
                : savedWorkDir.trim();
        rokidAiConfigFile = savedConfigFile == null || savedConfigFile.trim().isEmpty()
                ? RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE
                : savedConfigFile.trim();
    }

    private void saveRokidAiSdkPrefs() {
        savePref(PREF_ROKID_AI_KEY, rokidAiKey);
        savePref(PREF_ROKID_AI_SECRET, rokidAiSecret);
        savePref(PREF_ROKID_AI_DEVICE_TYPE_ID, rokidAiDeviceTypeId);
        savePref(PREF_ROKID_AI_DEVICE_ID, rokidAiDeviceId);
        savePref(PREF_ROKID_AI_SEED, rokidAiSeed);
        savePref(PREF_ROKID_AI_WORK_DIR, rokidAiWorkDir);
        savePref(PREF_ROKID_AI_CONFIG_FILE, rokidAiConfigFile);
    }

    private void saveRokidAiSdkCredentials(RokidAiSdkVoiceBridge.Credentials credentials) {
        if (credentials == null) {
            return;
        }
        rokidAiKey = credentials.key;
        rokidAiSecret = credentials.secret;
        rokidAiDeviceTypeId = credentials.deviceTypeId;
        rokidAiDeviceId = credentials.deviceId;
        rokidAiSeed = credentials.seed;
        rokidAiWorkDir = credentials.workDir == null || credentials.workDir.trim().isEmpty()
                ? RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR
                : credentials.workDir.trim();
        rokidAiConfigFile = credentials.configFile == null || credentials.configFile.trim().isEmpty()
                ? RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE
                : credentials.configFile.trim();
        saveRokidAiSdkPrefs();
        if (rokidAiSdkVoiceBridge != null) {
            rokidAiSdkVoiceBridge.updateCredentials(currentRokidAiSdkCredentials());
        }
    }

    private RokidAiSdkVoiceBridge.Credentials currentRokidAiSdkCredentials() {
        return new RokidAiSdkVoiceBridge.Credentials(
                rokidAiKey,
                rokidAiSecret,
                rokidAiDeviceTypeId,
                rokidAiDeviceId,
                rokidAiSeed,
                rokidAiWorkDir,
                rokidAiConfigFile
        );
    }

    private void handleExternalIntent(Intent intent) {
        handleProbeCommand(intent);
        handleNativeVoiceIntent(intent);
    }

    private void handleProbeCommand(Intent intent) {
        if (intent == null || !intent.hasExtra(EXTRA_PROBE_COMMAND)) {
            return;
        }
        String command = textExtra(intent, EXTRA_PROBE_COMMAND, "").trim();
        append("rokid probe command=" + command);
        if ("auth".equalsIgnoreCase(command) || "request_auth".equalsIgnoreCase(command)) {
            requestRokidAuthorization();
        } else if ("connect_custom_view".equalsIgnoreCase(command)) {
            connectCustomViewSession();
        } else if ("connect_glass_app".equalsIgnoreCase(command)
                || "connect_glass_app_session".equalsIgnoreCase(command)) {
            connectGlassAppSession();
        } else if ("query_glass_asr".equalsIgnoreCase(command)
                || "query_glass_asr_app".equalsIgnoreCase(command)) {
            queryGlassAsrApp();
        } else if ("install_glass_asr".equalsIgnoreCase(command)
                || "install_glass_asr_app".equalsIgnoreCase(command)) {
            installGlassAsrApp();
        } else if ("start_glass_asr".equalsIgnoreCase(command)
                || "start_glass_asr_app".equalsIgnoreCase(command)) {
            startGlassAsrApp();
        } else if ("stop_glass_asr".equalsIgnoreCase(command)
                || "stop_glass_asr_app".equalsIgnoreCase(command)) {
            stopGlassAsrApp();
        } else {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "未知 rokid_probe_command=" + command, "", "expected auth, connect_custom_view, connect_glass_app, query_glass_asr, install_glass_asr, start_glass_asr or stop_glass_asr");
            updateDashboard();
        }
    }

    private void handleNativeVoiceIntent(Intent intent) {
        handleNativeVoiceInjection(intent);
        handleNativeVoiceCommand(intent);
    }

    private void handleNativeVoiceInjection(Intent intent) {
        if (intent == null) {
            append("native voice inject skipped: intent=null");
            return;
        }
        append("native voice extras=" + describeExtras(intent));
        if (!intent.hasExtra(EXTRA_NATIVE_VOICE_MODE)) {
            return;
        }
        String mode = textExtra(intent, EXTRA_NATIVE_VOICE_MODE, "");
        String text = nativeVoiceTextExtra(intent, "Rabi 原生语音注入测试");
        String channel = textExtra(intent, EXTRA_NATIVE_VOICE_CHANNEL, "adb");
        String clientId = textExtra(intent, EXTRA_NATIVE_VOICE_CLIENT_ID, "local-inject");
        append("native voice inject mode=" + mode + " channel=" + channel + " clientId=" + clientId + " text=" + text);
        if ("asr".equalsIgnoreCase(mode)) {
            handleNativeAsrText(text, channel, clientId, false);
        } else if ("status".equalsIgnoreCase(mode)) {
            handleNativeStatus(text, channel, clientId, false);
        } else if ("tts_ack".equalsIgnoreCase(mode) || "tts".equalsIgnoreCase(mode)) {
            handleNativeTtsAck(text, channel, clientId, false);
        } else if ("error".equalsIgnoreCase(mode)
                || "asr_error".equalsIgnoreCase(mode)
                || "tts_error".equalsIgnoreCase(mode)
                || "asr_start_error".equalsIgnoreCase(mode)
                || "asr_stop_error".equalsIgnoreCase(mode)) {
            String kind = "error".equalsIgnoreCase(mode) ? "manual" : mode.replace("_error", "");
            handleNativeVoiceError(kind, text, channel, clientId, false);
        } else if ("ack".equalsIgnoreCase(mode)
                || "ping".equalsIgnoreCase(mode)
                || "asr_start".equalsIgnoreCase(mode)
                || "asr_stop".equalsIgnoreCase(mode)) {
            String kind = "ack".equalsIgnoreCase(mode) ? "manual" : mode;
            handleNativeCommandAck(kind, text, channel, clientId, false);
        } else if ("app_installed".equalsIgnoreCase(mode)) {
            handleGlassAppResult("ok", "onQueryAppResult installed=true", "");
        } else if ("app_missing".equalsIgnoreCase(mode)) {
            handleGlassAppResult("partial", "onQueryAppResult installed=false", "眼镜端应用尚未安装");
        } else if ("app_started".equalsIgnoreCase(mode)) {
            handleGlassAppResult("started", "onOpenAppResult=true", "");
        } else if ("app_stopped".equalsIgnoreCase(mode)) {
            handleGlassAppResult("ok", "onStopAppResult=true", "");
        } else if ("echo_on".equalsIgnoreCase(mode)) {
            nativeEchoNextAsr = true;
            lastNativeLoopback = "ADB 自测：等待下一条 ASR 文本";
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "ADB 自测已打开 ASR 回声模式", "", "");
        } else if ("timeout".equalsIgnoreCase(mode)) {
            markNativeVoicePending("self_timeout", "ADB 自测：等待原生语音超时");
        } else {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "未知 native_voice_mode=" + mode, "", "expected asr, status, tts_ack, *_error, ping, asr_start, asr_stop, ack, timeout or app_*");
        }
        updateDashboard();
    }

    private void handleNativeVoiceCommand(Intent intent) {
        if (intent == null || !intent.hasExtra(EXTRA_NATIVE_VOICE_COMMAND)) {
            return;
        }
        String command = textExtra(intent, EXTRA_NATIVE_VOICE_COMMAND, "").trim();
        String text = nativeVoiceTextExtra(intent, "Rabi 原生 TTS 测试");
        append("native voice command=" + command + " text=" + text);
        if ("ping".equalsIgnoreCase(command)) {
            pingNativeVoiceBridge();
        } else if ("status".equalsIgnoreCase(command)) {
            sendNativeStatusCommand();
        } else if ("diag".equalsIgnoreCase(command)
                || "native_diag".equalsIgnoreCase(command)
                || "glass_diag".equalsIgnoreCase(command)) {
            sendNativeDiagnosticsCommand();
        } else if ("save_auth".equalsIgnoreCase(command) || "auth".equalsIgnoreCase(command)) {
            saveNativeVoiceAuthorizationFromIntent(intent);
        } else if ("asr_start".equalsIgnoreCase(command) || "start_asr".equalsIgnoreCase(command)) {
            startNativeAsrRemote();
        } else if ("asr_stop".equalsIgnoreCase(command) || "stop_asr".equalsIgnoreCase(command)) {
            stopNativeAsrRemote();
        } else if ("tts".equalsIgnoreCase(command)) {
            sendNativeTtsText(text, "外部命令已向眼镜发送 TTS 文本：");
        } else if ("echo_start".equalsIgnoreCase(command) || "start_echo".equalsIgnoreCase(command)) {
            startNativeEchoTest();
        } else if ("offline_cmd_arm".equalsIgnoreCase(command)
                || "offline_arm".equalsIgnoreCase(command)
                || "arm_offline_cmd".equalsIgnoreCase(command)) {
            armOfflineVoiceCommands();
        } else if ("offline_cmd_clear".equalsIgnoreCase(command)
                || "offline_clear".equalsIgnoreCase(command)
                || "clear_offline_cmd".equalsIgnoreCase(command)) {
            clearOfflineVoiceCommands();
        } else if ("glass_android_voice_probe".equalsIgnoreCase(command)
                || "glass_android_voice".equalsIgnoreCase(command)
                || "glass_system_voice".equalsIgnoreCase(command)) {
            probeGlassAndroidVoice();
        } else if ("glass_android_asr_start".equalsIgnoreCase(command)
                || "start_glass_android_asr".equalsIgnoreCase(command)
                || "glass_system_asr_start".equalsIgnoreCase(command)) {
            startGlassAndroidAsr();
        } else if ("glass_android_asr_stop".equalsIgnoreCase(command)
                || "stop_glass_android_asr".equalsIgnoreCase(command)
                || "glass_system_asr_stop".equalsIgnoreCase(command)) {
            stopGlassAndroidAsr();
        } else if ("glass_android_tts".equalsIgnoreCase(command)
                || "glass_system_tts".equalsIgnoreCase(command)) {
            sendGlassAndroidTtsText(text);
        } else if ("glass_rokid_ai_probe".equalsIgnoreCase(command)
                || "glass_ai_probe".equalsIgnoreCase(command)
                || "glass_rokid_ai_status".equalsIgnoreCase(command)) {
            sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_PROBE");
            markNativeVoicePending("glass_rokid_ai_probe", "已向眼镜发送 RokidAiSdk readiness 查询");
        } else if ("glass_rokid_ai_save_config".equalsIgnoreCase(command)
                || "glass_ai_save_config".equalsIgnoreCase(command)
                || "glass_rokid_ai_config".equalsIgnoreCase(command)) {
            saveAndSendGlassRokidAiSdkConfigFromIntent(intent);
        } else if ("glass_rokid_ai_clear_config".equalsIgnoreCase(command)
                || "glass_ai_clear_config".equalsIgnoreCase(command)) {
            sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_CLEAR_CONFIG");
            markNativeVoicePending("glass_rokid_ai_clear_config", "已请求清空眼镜侧 RokidAiSdk 内存凭证");
        } else if ("glass_rokid_ai_start".equalsIgnoreCase(command)
                || "start_glass_rokid_ai".equalsIgnoreCase(command)
                || "glass_ai_start".equalsIgnoreCase(command)) {
            sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_START");
            markNativeVoicePending("glass_rokid_ai_start", "已向眼镜发送 RokidAiSdk 启动请求");
        } else if ("glass_rokid_ai_stop".equalsIgnoreCase(command)
                || "stop_glass_rokid_ai".equalsIgnoreCase(command)
                || "glass_ai_stop".equalsIgnoreCase(command)) {
            sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_STOP");
            markNativeVoicePending("glass_rokid_ai_stop", "已向眼镜发送 RokidAiSdk 停止请求");
        } else if ("glass_rokid_ai_tts".equalsIgnoreCase(command)
                || "glass_ai_tts".equalsIgnoreCase(command)) {
            sendNativeVoiceCustomCmd("RABI_GLASS_ROKID_AI_TTS:" + text);
            markNativeVoicePending("glass_rokid_ai_tts", "已向眼镜发送 RokidAiSdk TTS 文本");
        } else if ("phone_init".equalsIgnoreCase(command) || "init_phone".equalsIgnoreCase(command)) {
            initPhoneVoiceProbe();
        } else if ("phone_auth_probe".equalsIgnoreCase(command) || "phone_auth".equalsIgnoreCase(command) || "probe_phone_auth".equalsIgnoreCase(command)) {
            probePhoneVoiceAuthorization();
        } else if ("phone_bt_scan".equalsIgnoreCase(command)
                || "scan_phone_bt".equalsIgnoreCase(command)
                || "probe_phone_bt_scan".equalsIgnoreCase(command)) {
            scanPhoneBt();
        } else if ("phone_device_link_probe".equalsIgnoreCase(command)
                || "phone_device_link".equalsIgnoreCase(command)
                || "probe_phone_device_link".equalsIgnoreCase(command)
                || "phone_official_link_probe".equalsIgnoreCase(command)) {
            probePhoneDeviceLink();
        } else if ("phone_companion_associate".equalsIgnoreCase(command)
                || "phone_companion_pair".equalsIgnoreCase(command)
                || "associate_phone_companion".equalsIgnoreCase(command)
                || "phone_cdm_associate".equalsIgnoreCase(command)) {
            associatePhoneCompanionDevice();
        } else if ("phone_bt_connect".equalsIgnoreCase(command)
                || "connect_phone_bt".equalsIgnoreCase(command)
                || "connect_phone_bt_bonded".equalsIgnoreCase(command)) {
            connectPhoneBt();
        } else if ("phone_bt_auth".equalsIgnoreCase(command)
                || "phone_bt_probe".equalsIgnoreCase(command)
                || "probe_phone_bt_auth".equalsIgnoreCase(command)) {
            probePhoneBtAuth();
        } else if ("phone_p2p_probe".equalsIgnoreCase(command)
                || "phone_p2p".equalsIgnoreCase(command)
                || "probe_phone_p2p".equalsIgnoreCase(command)) {
            probePhoneP2p();
        } else if ("phone_system_info_probe".equalsIgnoreCase(command)
                || "phone_system_info".equalsIgnoreCase(command)
                || "probe_phone_system_info".equalsIgnoreCase(command)
                || "phone_official_system_info".equalsIgnoreCase(command)) {
            requestPhoneSystemInfo();
        } else if ("phone_device_handshake".equalsIgnoreCase(command)
                || "phone_audio_handshake".equalsIgnoreCase(command)
                || "probe_phone_device_handshake".equalsIgnoreCase(command)) {
            requestPhoneDeviceAudioHandshake();
        } else if ("phone_device_video_audio_handshake".equalsIgnoreCase(command)
                || "phone_video_audio_handshake".equalsIgnoreCase(command)
                || "phone_preview_handshake".equalsIgnoreCase(command)
                || "probe_phone_device_video_audio_handshake".equalsIgnoreCase(command)) {
            requestPhoneDeviceVideoAudioHandshake();
        } else if ("phone_device_info".equalsIgnoreCase(command)
                || "phone_glass_device".equalsIgnoreCase(command)
                || "probe_phone_device_info".equalsIgnoreCase(command)) {
            probePhoneGlassDeviceInfo();
        } else if ("phone_auth_apply".equalsIgnoreCase(command) || "apply_phone_auth".equalsIgnoreCase(command)) {
            applyPhoneVoiceAuthorization();
        } else if ("phone_asr_start".equalsIgnoreCase(command) || "start_phone_asr".equalsIgnoreCase(command)) {
            startPhoneAsrFeed();
        } else if ("phone_asr_stop".equalsIgnoreCase(command) || "stop_phone_asr".equalsIgnoreCase(command)) {
            stopPhoneAsrFeed();
        } else if ("phone_tts".equalsIgnoreCase(command)) {
            sendPhoneTtsText(text);
        } else if ("android_voice_probe".equalsIgnoreCase(command)
                || "android_system_voice".equalsIgnoreCase(command)
                || "android_voice_info".equalsIgnoreCase(command)) {
            probeAndroidSystemVoice();
        } else if ("android_voice_route_bluetooth".equalsIgnoreCase(command)
                || "android_route_bluetooth".equalsIgnoreCase(command)
                || "android_bt_route".equalsIgnoreCase(command)) {
            routeAndroidSystemBluetooth();
        } else if ("android_voice_clear_bluetooth".equalsIgnoreCase(command)
                || "android_clear_bluetooth".equalsIgnoreCase(command)
                || "android_bt_clear".equalsIgnoreCase(command)) {
            clearAndroidSystemBluetooth();
        } else if ("android_headset_voice_start".equalsIgnoreCase(command)
                || "android_bt_headset_voice".equalsIgnoreCase(command)
                || "android_headset_voice".equalsIgnoreCase(command)) {
            startAndroidHeadsetVoiceRecognition();
        } else if ("android_headset_voice_stop".equalsIgnoreCase(command)
                || "android_bt_headset_voice_stop".equalsIgnoreCase(command)) {
            stopAndroidHeadsetVoiceRecognition();
        } else if ("android_asr_start".equalsIgnoreCase(command)
                || "start_android_asr".equalsIgnoreCase(command)) {
            startAndroidSystemAsr();
        } else if ("android_asr_intent".equalsIgnoreCase(command)
                || "start_android_asr_intent".equalsIgnoreCase(command)
                || "android_recognizer_intent".equalsIgnoreCase(command)) {
            startAndroidSystemAsrIntent();
        } else if ("android_asr_stop".equalsIgnoreCase(command)
                || "stop_android_asr".equalsIgnoreCase(command)) {
            stopAndroidSystemAsr();
        } else if ("android_tts".equalsIgnoreCase(command)
                || "android_system_tts".equalsIgnoreCase(command)) {
            sendAndroidSystemTtsText(text);
        } else if ("android_asr_tts_loop".equalsIgnoreCase(command)
                || "android_loopback".equalsIgnoreCase(command)
                || "android_voice_loopback".equalsIgnoreCase(command)) {
            startAndroidSystemLoopback(text);
        } else if ("rokid_ai_probe".equalsIgnoreCase(command)
                || "ai_probe".equalsIgnoreCase(command)
                || "rokid_ai_status".equalsIgnoreCase(command)) {
            probeRokidAiSdkVoice();
        } else if ("rokid_ai_save_config".equalsIgnoreCase(command)
                || "ai_save_config".equalsIgnoreCase(command)
                || "rokid_ai_config".equalsIgnoreCase(command)) {
            saveRokidAiSdkConfigFromIntent(intent);
        } else if ("rokid_ai_clear_config".equalsIgnoreCase(command)
                || "ai_clear_config".equalsIgnoreCase(command)) {
            clearRokidAiSdkConfig();
        } else if ("rokid_ai_start".equalsIgnoreCase(command)
                || "ai_start".equalsIgnoreCase(command)
                || "rokid_ai_asr_start".equalsIgnoreCase(command)) {
            startRokidAiSdkAsr();
        } else if ("rokid_ai_stop".equalsIgnoreCase(command)
                || "ai_stop".equalsIgnoreCase(command)) {
            stopRokidAiSdkVoice();
        } else if ("rokid_ai_tts".equalsIgnoreCase(command)
                || "ai_tts".equalsIgnoreCase(command)) {
            sendRokidAiSdkTtsText(text);
        } else if ("rokid_ai_pickup".equalsIgnoreCase(command)
                || "rokid_ai_pickup_on".equalsIgnoreCase(command)
                || "ai_pickup".equalsIgnoreCase(command)
                || "ai_pickup_on".equalsIgnoreCase(command)) {
            setRokidAiSdkPickup(true);
        } else if ("rokid_ai_pickup_off".equalsIgnoreCase(command)
                || "ai_pickup_off".equalsIgnoreCase(command)) {
            setRokidAiSdkPickup(false);
        } else {
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "未知 native_voice_command=" + command, "", "expected ping, status, diag, save_auth, asr_start, asr_stop, tts, echo_start, offline_cmd_arm, offline_cmd_clear, glass_android_voice_probe, glass_android_asr_start, glass_android_asr_stop, glass_android_tts, phone_bt_scan, phone_device_link_probe, phone_companion_associate, phone_bt_connect, phone_bt_auth, phone_p2p_probe, phone_system_info_probe, phone_device_handshake, phone_device_video_audio_handshake, phone_device_info, phone_auth_probe, phone_auth_apply, phone_init, phone_asr_start, phone_asr_stop, phone_tts, android_voice_probe, android_asr_start, android_asr_intent, android_asr_stop, android_tts, rokid_ai_probe, rokid_ai_save_config, rokid_ai_clear_config, rokid_ai_start, rokid_ai_stop, rokid_ai_tts or rokid_ai_pickup");
            updateDashboard();
        }
    }

    private void clearRokidAiSdkConfig() {
        rokidAiKey = "";
        rokidAiSecret = "";
        rokidAiDeviceTypeId = "";
        rokidAiDeviceId = "";
        rokidAiSeed = "";
        rokidAiWorkDir = RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR;
        rokidAiConfigFile = RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE;
        saveRokidAiSdkPrefs();
        if (rokidAiSdkVoiceBridge != null) {
            rokidAiSdkVoiceBridge.updateCredentials(currentRokidAiSdkCredentials());
        }
        append("RokidAiSdk 配置已清空。");
        recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "checked", "RokidAiSdk 配置已清空", "", "");
        updateDashboard();
    }

    private void saveRokidAiSdkConfigFromIntent(Intent intent) {
        rokidAiKey = decodedExtra(intent, EXTRA_ROKID_AI_KEY_B64, EXTRA_ROKID_AI_KEY, "");
        rokidAiSecret = decodedExtra(intent, EXTRA_ROKID_AI_SECRET_B64, EXTRA_ROKID_AI_SECRET, "");
        rokidAiDeviceTypeId = decodedExtra(intent, EXTRA_ROKID_AI_DEVICE_TYPE_ID_B64, EXTRA_ROKID_AI_DEVICE_TYPE_ID, "");
        rokidAiDeviceId = decodedExtra(intent, EXTRA_ROKID_AI_DEVICE_ID_B64, EXTRA_ROKID_AI_DEVICE_ID, "");
        rokidAiSeed = decodedExtra(intent, EXTRA_ROKID_AI_SEED_B64, EXTRA_ROKID_AI_SEED, "");
        rokidAiWorkDir = textExtra(intent, EXTRA_ROKID_AI_WORK_DIR, RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR);
        rokidAiConfigFile = textExtra(intent, EXTRA_ROKID_AI_CONFIG_FILE, RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE);
        saveRokidAiSdkPrefs();
        if (rokidAiSdkVoiceBridge != null) {
            rokidAiSdkVoiceBridge.updateCredentials(currentRokidAiSdkCredentials());
        }
        RokidAiSdkVoiceBridge.Credentials credentials = currentRokidAiSdkCredentials();
        append("RokidAiSdk 配置已通过 ADB 保存：" + credentials.summary());
        recordResult(
                RokidGlassModule.CAP_ROKID_AI_SDK_VOICE,
                credentials.isComplete() ? "checked" : "partial",
                "ADB 已保存 RokidAiSdk 配置：" + credentials.summary(),
                "",
                credentials.isComplete() ? "" : "missing " + credentials.missingFields()
        );
        updateDashboard();
    }

    private void saveAndSendGlassRokidAiSdkConfigFromIntent(Intent intent) {
        saveRokidAiSdkCredentials(new RokidAiSdkVoiceBridge.Credentials(
                decodedExtra(intent, EXTRA_ROKID_AI_KEY_B64, EXTRA_ROKID_AI_KEY, ""),
                decodedExtra(intent, EXTRA_ROKID_AI_SECRET_B64, EXTRA_ROKID_AI_SECRET, ""),
                decodedExtra(intent, EXTRA_ROKID_AI_DEVICE_TYPE_ID_B64, EXTRA_ROKID_AI_DEVICE_TYPE_ID, ""),
                decodedExtra(intent, EXTRA_ROKID_AI_DEVICE_ID_B64, EXTRA_ROKID_AI_DEVICE_ID, ""),
                decodedExtra(intent, EXTRA_ROKID_AI_SEED_B64, EXTRA_ROKID_AI_SEED, ""),
                textExtra(intent, EXTRA_ROKID_AI_WORK_DIR, RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR),
                textExtra(intent, EXTRA_ROKID_AI_CONFIG_FILE, RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE)
        ));
        RokidAiSdkVoiceBridge.Credentials credentials = currentRokidAiSdkCredentials();
        sendRokidAiSdkConfigToGlass(credentials);
        updateDashboard();
    }

    private void sendRokidAiSdkConfigToGlass(RokidAiSdkVoiceBridge.Credentials credentials) {
        sendNativeVoiceCustomCmd(GLASS_ROKID_AI_CONFIG_PREFIX + encodedRokidAiSdkConfig(credentials));
        markNativeVoicePending("glass_rokid_ai_save_config", "已向眼镜发送 RokidAiSdk 配置；日志仅显示脱敏摘要");
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                credentials.isComplete() ? "requested" : "partial",
                "眼镜侧 RokidAiSdk 配置已发送：" + credentials.summary(),
                "",
                credentials.isComplete() ? "等待眼镜回包确认 readiness" : "missing " + credentials.missingFields()
        );
    }

    private static String encodedRokidAiSdkConfig(RokidAiSdkVoiceBridge.Credentials credentials) {
        try {
            JSONObject root = new JSONObject()
                    .put("key", credentials.key)
                    .put("secret", credentials.secret)
                    .put("deviceTypeId", credentials.deviceTypeId)
                    .put("deviceId", credentials.deviceId)
                    .put("seed", credentials.seed)
                    .put("workDir", credentials.workDir)
                    .put("configFile", credentials.configFile);
            return Base64.encodeToString(root.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        } catch (Throwable ignored) {
            return "";
        }
    }

    private void saveNativeVoiceAuthorizationFromIntent(Intent intent) {
        nativeVoiceAccessKey = decodedExtra(intent, EXTRA_NATIVE_VOICE_ACCESS_KEY_B64, EXTRA_NATIVE_VOICE_ACCESS_KEY, "");
        nativeVoiceSecretKey = decodedExtra(intent, EXTRA_NATIVE_VOICE_SECRET_KEY_B64, EXTRA_NATIVE_VOICE_SECRET_KEY, "");
        savePref(PREF_NATIVE_VOICE_ACCESS_KEY, nativeVoiceAccessKey);
        savePref(PREF_NATIVE_VOICE_SECRET_KEY, nativeVoiceSecretKey);
        if (uiViews != null) {
            uiViews.setNativeVoiceCredentials(nativeVoiceAccessKey, nativeVoiceSecretKey);
        }
        append("Rokid 在线语音授权已通过 ADB 保存 configured=" + nativeVoiceAuthConfigured());
        recordResult(
                RokidGlassModule.CAP_GLASS_ASR,
                nativeVoiceAuthConfigured() ? "checked" : "partial",
                nativeVoiceAuthConfigured()
                        ? "ADB 已配置在线语音 AK/SK；为避免 SDK logcat 泄漏，暂不自动注入 UserAuthInfo"
                        : "ADB 在线语音 AK/SK 未完整配置",
                "",
                ""
        );
        if (nativeVoiceBridge != null) {
            nativeVoiceBridge.updateUserAuth(nativeVoiceAccessKey, nativeVoiceSecretKey);
        }
        updateDashboard();
    }

    private void handleNativeAsrText(String text, String channel, String clientId, boolean fromCallbackThread) {
        Runnable action = () -> {
            clearNativeVoicePending();
            nativeVoiceReachable = true;
            lastNativeAsrText = text;
            lastNativeVoiceError = "";
            String summary = "原生 ASR 文本 channel=" + channel + " clientId=" + clientId + " text=" + text;
            recordResult(RokidGlassModule.CAP_GLASS_ASR, text == null || text.isEmpty() ? "partial" : "ok", summary, "", text == null || text.isEmpty() ? "ASR 文本为空" : "");
            append("收到眼镜端原生 ASR 文本：" + text);
            maybeSendEchoTts(text);
            updateDashboard();
        };
        if (fromCallbackThread) {
            runOnUiThread(action);
        } else {
            action.run();
        }
    }

    private void handleNativeTtsAck(String text, String channel, String clientId, boolean fromCallbackThread) {
        Runnable action = () -> {
            clearNativeVoicePending();
            nativeVoiceReachable = true;
            lastNativeTtsAck = text;
            lastNativeVoiceError = "";
            String summary = "眼镜原生 TTS ack channel=" + channel + " clientId=" + clientId + " text=" + text;
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "ok", summary, "", "");
            append("收到眼镜端 TTS ack：" + text);
            updateDashboard();
        };
        if (fromCallbackThread) {
            runOnUiThread(action);
        } else {
            action.run();
        }
    }

    private void handleAndroidSystemAsrText(String text, boolean finalResult) {
        runOnUiThread(() -> {
            lastAndroidSystemAsrText = text == null ? "" : text;
            lastAndroidSystemVoiceError = "";
            String summary = (finalResult ? "Android 系统 ASR final=" : "Android 系统 ASR partial=") + lastAndroidSystemAsrText;
            recordResult(
                    RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE,
                    finalResult && !lastAndroidSystemAsrText.isEmpty() ? "ok" : "partial",
                    summary,
                    "",
                    lastAndroidSystemAsrText.isEmpty() ? "ASR 文本为空" : ""
            );
            append(summary);
            if (finalResult && !lastAndroidSystemAsrText.isEmpty()) {
                append("RABI_ANDROID_ASR:" + lastAndroidSystemAsrText);
            }
            updateDashboard();
        });
    }

    private void handleAndroidSystemTtsAck(String text) {
        runOnUiThread(() -> {
            lastAndroidSystemTtsAck = text == null ? "" : text;
            lastAndroidSystemVoiceError = "";
            String summary = "Android 系统 TTS onDone text=" + lastAndroidSystemTtsAck;
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "ok", summary, "", "");
            append(summary);
            if (!lastAndroidSystemTtsAck.isEmpty()) {
                append("RABI_ANDROID_TTS_OK:" + lastAndroidSystemTtsAck);
            }
            updateDashboard();
        });
    }

    private void handleAndroidSystemVoiceError(String kind, String message) {
        runOnUiThread(() -> {
            lastAndroidSystemVoiceError = kind + " / " + message;
            String summary = "Android 系统语音错误 kind=" + kind;
            recordResult(RokidGlassModule.CAP_ANDROID_SYSTEM_VOICE, "failed", summary, "", message);
            append(summary + " " + message);
            updateDashboard();
        });
    }

    private void handleRokidAiSdkAsrText(String text, boolean finalResult, boolean local) {
        runOnUiThread(() -> {
            if (finalResult) {
                lastRokidAiSdkAsrText = text == null ? "" : text;
            }
            lastRokidAiSdkError = "";
            String safeText = text == null ? "" : text;
            String summary = "RokidAiSdk ASR " + (finalResult ? "final" : "partial") + " local=" + local + " text=" + safeText;
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, finalResult && !safeText.isEmpty() ? "ok" : "partial", summary, "", safeText.isEmpty() ? "ASR 文本为空" : "");
            append(summary);
            if (finalResult && !safeText.isEmpty()) {
                append("RABI_ROKID_AI_ASR:" + safeText);
            }
            updateDashboard();
        });
    }

    private void handleRokidAiSdkTtsRequested(String text) {
        runOnUiThread(() -> {
            lastRokidAiSdkTtsAck = text == null ? "" : text;
            lastRokidAiSdkError = "";
            String summary = "RokidAiSdk TTS requested text=" + lastRokidAiSdkTtsAck;
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "requested", summary, "", "");
            append(summary);
            updateDashboard();
        });
    }

    private void handleRokidAiSdkState(String state, String detail) {
        runOnUiThread(() -> {
            lastRokidAiSdkState = state + (detail == null || detail.isEmpty() ? "" : " / " + detail);
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "checked", "RokidAiSdk state=" + lastRokidAiSdkState, "", "");
            updateDashboard();
        });
    }

    private void handleRokidAiSdkError(String kind, String message) {
        runOnUiThread(() -> {
            lastRokidAiSdkError = kind + " / " + message;
            String summary = "RokidAiSdk 错误 kind=" + kind;
            recordResult(RokidGlassModule.CAP_ROKID_AI_SDK_VOICE, "failed", summary, "", message);
            append(summary + " " + message);
            updateDashboard();
        });
    }

    private void handleNativeCommandAck(String kind, String text, String channel, String clientId, boolean fromCallbackThread) {
        Runnable action = () -> {
            clearNativeVoicePending();
            nativeVoiceReachable = true;
            lastNativeCommandAck = kind + " / " + text;
            lastNativeVoiceError = "";
            String summary = "眼镜原生命令 ack kind=" + kind + " channel=" + channel + " clientId=" + clientId + " text=" + text;
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "ok", summary, "", "");
            append("收到眼镜端命令 ack：" + kind + " / " + text);
            updateDashboard();
        };
        if (fromCallbackThread) {
            runOnUiThread(action);
        } else {
            action.run();
        }
    }

    private void handleNativeStatus(String text, String channel, String clientId, boolean fromCallbackThread) {
        Runnable action = () -> {
            clearNativeVoicePending();
            nativeVoiceReachable = true;
            lastNativeVoiceStatus = RokidNativeVoiceStatus.parse(text);
            lastNativeCommandAck = "status / " + lastNativeVoiceStatus.shortSummary();
            lastNativeVoiceError = lastNativeVoiceStatus.isAsrReady() && lastNativeVoiceStatus.isTtsReady()
                    ? ""
                    : lastNativeVoiceStatus.diagnosticSummary();
            String summary = "眼镜原生状态 channel=" + channel
                    + " clientId=" + clientId
                    + "\n" + lastNativeVoiceStatus.diagnosticSummary()
                    + "\nraw=" + lastNativeVoiceStatus.raw();
            recordResult(
                    RokidGlassModule.CAP_GLASS_ASR,
                    lastNativeVoiceStatus.isAsrReady() && lastNativeVoiceStatus.isTtsReady() ? "ok" : "partial",
                    summary,
                    "",
                    lastNativeVoiceStatus.isAsrReady() && lastNativeVoiceStatus.isTtsReady() ? "" : "native ASR/TTS service is not ready"
            );
            append("收到眼镜端原生状态：" + text);
            append("原生状态诊断：" + lastNativeVoiceStatus.diagnosticSummary());
            updateDashboard();
        };
        if (fromCallbackThread) {
            runOnUiThread(action);
        } else {
            action.run();
        }
    }

    private void handleNativeVoiceError(String kind, String text, String channel, String clientId, boolean fromCallbackThread) {
        Runnable action = () -> {
            clearNativeVoicePending();
            nativeVoiceReachable = true;
            lastNativeVoiceError = kind + " / " + text;
            String summary = "眼镜原生语音错误 kind=" + kind + " channel=" + channel + " clientId=" + clientId + " text=" + text;
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", summary, "", text);
            append("收到眼镜端原生语音错误：" + kind + " / " + text);
            updateDashboard();
        };
        if (fromCallbackThread) {
            runOnUiThread(action);
        } else {
            action.run();
        }
    }

    private void handleGlassAppResult(String status, String summary, String error) {
        runOnUiThread(() -> {
            applyGlassAppState(summary, "failed".equals(status));
            recordResult(RokidGlassModule.CAP_GLASS_ASR, status, summary, "", error);
            updateDashboard();
        });
    }

    private void applyGlassAppState(String summary, boolean failed) {
        if (summary == null) {
            return;
        }
        if (summary.contains("onQueryAppResult installed=true") || summary.contains("onInstallAppResult=true")) {
            glassAsrAppInstalled = true;
        } else if (summary.contains("onQueryAppResult installed=false")) {
            glassAsrAppInstalled = false;
            glassAsrAppStarted = false;
            nativeVoiceReachable = false;
        } else if (summary.contains("onOpenAppResult=true") || summary.contains("onGlassAppResume=true")) {
            glassAsrAppInstalled = true;
            glassAsrAppStarted = true;
        } else if (summary.contains("onStopAppResult=true")) {
            glassAsrAppStarted = false;
            nativeVoiceReachable = false;
        } else if (failed && summary.contains("onOpenAppResult")) {
            glassAsrAppStarted = false;
            nativeVoiceReachable = false;
        }
    }

    private void resetGlassNativeVoiceState() {
        glassAsrAppInstalled = false;
        glassAsrAppStarted = false;
        nativeVoiceReachable = false;
        lastNativeAsrText = "";
        lastNativeCommandAck = "";
        lastNativeTtsAck = "";
        lastNativeVoiceError = "";
        lastNativeLoopback = "";
        lastNativeVoiceStatus = RokidNativeVoiceStatus.empty();
        nativeEchoNextAsr = false;
        pendingNativeVoiceKind = "";
        pendingNativeVoiceGeneration++;
    }

    private void maybeSendEchoTts(String text) {
        if (!nativeEchoNextAsr) {
            return;
        }
        nativeEchoNextAsr = false;
        if (text == null || text.trim().isEmpty()) {
            lastNativeLoopback = "ASR 文本为空，未发送 TTS";
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "partial", "ASR 回声测试未发送 TTS：ASR 文本为空", "", "empty ASR text");
            return;
        }
        if (nativeVoiceBridge == null) {
            lastNativeLoopback = "Phone SDK 消息桥未初始化";
            recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", "ASR 回声测试不能发送 TTS", "", "nativeVoiceBridge is null");
            return;
        }
        String speech = "我听到了：" + text.trim();
        lastNativeLoopback = "ASR->TTS " + speech;
        sendNativeVoiceCustomCmd("RABI_TTS:" + speech);
        nativeVoiceBridge.sendTtsTest(speech);
        markNativeVoicePending("tts_echo", "ASR 已转 TTS，等待眼镜 TTS ACK");
        append("ASR 回声测试发送 TTS：" + speech);
    }

    private void sendNativeStatusCommand() {
        sendNativeVoiceCustomCmd("RABI_STATUS");
        if (nativeVoiceBridge != null) {
            nativeVoiceBridge.queryGlassStatus();
        }
        markNativeVoicePending("status", "已向眼镜发送原生状态查询");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已向眼镜发送原生状态查询", "", "");
        updateDashboard();
    }

    private void sendNativeDiagnosticsCommand() {
        sendNativeVoiceCustomCmd("RABI_DIAG");
        if (nativeVoiceBridge != null) {
            nativeVoiceBridge.queryGlassDiagnostics();
        }
        markNativeVoicePending("diag", "已向眼镜发送原生服务诊断查询");
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "requested", "已向眼镜发送原生服务诊断查询", "", "");
        updateDashboard();
    }

    private void sendNativeVoiceCustomCmd(String payload) {
        if (cxrController == null || !cxrController.isCustomAppSession()) {
            append("CXR CustomCmd 未发送：CustomApp 会话未就绪 payload=" + redactedProtocol(payload));
            return;
        }
        boolean sent = cxrController.sendNativeVoiceCustomCmd(payload);
        append("CXR CustomCmd send payload=" + redactedProtocol(payload) + " result=" + sent);
    }

    private void markNativeVoicePending(String kind, String summary) {
        pendingNativeVoiceKind = kind;
        long generation = ++pendingNativeVoiceGeneration;
        append("原生语音等待回包：" + kind + "，timeoutMs=" + NATIVE_VOICE_TIMEOUT_MS);
        if (uiViews != null) {
            uiViews.setCapabilityStatus(RokidGlassModule.CAP_GLASS_ASR, "requested", summary);
        }
        runOnUiThread(() -> {
            if (logView != null) {
                logView.postDelayed(() -> handleNativeVoiceTimeout(kind, generation), NATIVE_VOICE_TIMEOUT_MS);
            }
        });
    }

    private void clearNativeVoicePending() {
        pendingNativeVoiceKind = "";
        pendingNativeVoiceGeneration++;
    }

    private void handleNativeVoiceTimeout(String kind, long generation) {
        if (generation != pendingNativeVoiceGeneration || !kind.equals(pendingNativeVoiceKind)) {
            return;
        }
        pendingNativeVoiceKind = "";
        pendingNativeVoiceGeneration++;
        String reason = "timeout waiting native voice response kind=" + kind + " timeoutMs=" + NATIVE_VOICE_TIMEOUT_MS;
        lastNativeVoiceError = kind + " / timeout";
        boolean phoneSdkKind = kind != null && kind.startsWith("phone_");
        if (phoneSdkKind && nativeVoiceBridge != null) {
            nativeVoiceBridge.stopPhoneVoiceProbe();
        }
        String summary = (phoneSdkKind ? "手机侧 Rokid 语音引擎超时 kind=" : "眼镜原生语音回包超时 kind=") + kind;
        recordResult(RokidGlassModule.CAP_GLASS_ASR, "failed", summary, "", reason);
        append(summary);
        updateDashboard();
    }

    private static String textExtra(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null ? fallback : value;
    }

    private static String nativeVoiceTextExtra(Intent intent, String fallback) {
        return decodedExtra(intent, EXTRA_NATIVE_VOICE_TEXT_B64, EXTRA_NATIVE_VOICE_TEXT, fallback);
    }

    private static String decodedExtra(Intent intent, String encodedKey, String plainKey, String fallback) {
        String encoded = intent.getStringExtra(encodedKey);
        if (encoded != null && !encoded.trim().isEmpty()) {
            try {
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                return new String(bytes, StandardCharsets.UTF_8);
            } catch (IllegalArgumentException ignored) {
                return fallback;
            }
        }
        return textExtra(intent, plainKey, fallback);
    }

    private static String describeExtras(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null || extras.isEmpty()) {
            return "<empty>";
        }
        StringBuilder builder = new StringBuilder();
        for (String key : extras.keySet()) {
            if (builder.length() > 0) {
                builder.append(", ");
            }
            Object value = extras.get(key);
            builder.append(key).append('=').append(redactedExtraValue(key, value));
        }
        return builder.toString();
    }

    private static String redactedExtraValue(String key, Object value) {
        if (key == null) {
            return String.valueOf(value);
        }
        String lower = key.toLowerCase();
        if (lower.contains("key") || lower.contains("secret") || lower.contains("token")
                || lower.contains("seed") || lower.contains("device_id") || lower.contains("devicetype")) {
            return "<redacted>";
        }
        if (lower.contains("b64") && (lower.contains("auth") || lower.contains("voice"))) {
            return "<redacted-b64>";
        }
        return String.valueOf(value);
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

    private void updateDashboard() {
        if (uiViews == null) {
            return;
        }
        uiViews.setDashboard(
                "token: " + tokenLabel()
                        + "\nCXRLink: " + connectionLabel(cxrController != null && cxrController.isCxrConnected())
                        + "    Glass BT: " + connectionLabel(cxrController != null && cxrController.isGlassBtConnected())
                        + "    ready: " + connectionLabel(isLinkReady())
                        + "\nsession: " + sessionModeLabel() + " / " + (cxrController == null ? "<not-initialized>" : cxrController.getSessionState())
                        + "\nglass app: installed=" + yesNo(glassAsrAppInstalled)
                        + "    started=" + yesNo(glassAsrAppStarted)
                        + "    message=" + yesNo(nativeVoiceReachable)
                        + "\naudio: " + (audioStreamStarted ? "采集中" : "未开始")
                        + "    bytes: " + (cxrController == null ? 0 : cxrController.getAudioBytes())
                        + "    WAV: " + (lastAudioUri == null ? "无" : "已保存")
                        + "\nnative ASR: " + (lastNativeAsrText == null || lastNativeAsrText.isEmpty() ? "未收到" : lastNativeAsrText)
                        + "\nnative status: " + lastNativeVoiceStatus.shortSummary()
                        + "    auth: " + (nativeVoiceAuthConfigured() ? "已配置/未注入" : "未配置")
                        + "    ack: " + (lastNativeCommandAck == null || lastNativeCommandAck.isEmpty() ? "无" : lastNativeCommandAck)
                        + "    TTS: " + (lastNativeTtsAck == null || lastNativeTtsAck.isEmpty() ? "无" : lastNativeTtsAck)
                        + "    loopback: " + (lastNativeLoopback == null || lastNativeLoopback.isEmpty() ? "无" : lastNativeLoopback)
                        + "    pending: " + (pendingNativeVoiceKind == null || pendingNativeVoiceKind.isEmpty() ? "无" : pendingNativeVoiceKind)
                        + "    error: " + (lastNativeVoiceError == null || lastNativeVoiceError.isEmpty() ? "无" : lastNativeVoiceError)
                        + "\nandroid voice: ASR=" + (lastAndroidSystemAsrText == null || lastAndroidSystemAsrText.isEmpty() ? "未收到" : lastAndroidSystemAsrText)
                        + "    TTS=" + (lastAndroidSystemTtsAck == null || lastAndroidSystemTtsAck.isEmpty() ? "无" : lastAndroidSystemTtsAck)
                        + "    error=" + (lastAndroidSystemVoiceError == null || lastAndroidSystemVoiceError.isEmpty() ? "无" : lastAndroidSystemVoiceError)
                        + "\nrokid ai sdk: config=" + (rokidAiSdkConfigured() ? "已配置" : "未配置")
                        + "    service=" + connectionLabel(rokidAiSdkVoiceBridge != null && rokidAiSdkVoiceBridge.isServiceConnected())
                        + "    recording=" + yesNo(rokidAiSdkVoiceBridge != null && rokidAiSdkVoiceBridge.isRecording())
                        + "    ASR=" + (lastRokidAiSdkAsrText == null || lastRokidAiSdkAsrText.isEmpty() ? "未收到" : lastRokidAiSdkAsrText)
                        + "    TTS=" + (lastRokidAiSdkTtsAck == null || lastRokidAiSdkTtsAck.isEmpty() ? "无" : lastRokidAiSdkTtsAck)
                        + "    state=" + (lastRokidAiSdkState == null || lastRokidAiSdkState.isEmpty() ? "无" : lastRokidAiSdkState)
                        + "    error=" + (lastRokidAiSdkError == null || lastRokidAiSdkError.isEmpty() ? "无" : lastRokidAiSdkError)
        );
        updateVisibleControls();
    }

    private void releaseAudioPlayer() {
        if (audioPlayer == null) {
            return;
        }
        try {
            if (audioPlayer.isPlaying()) {
                audioPlayer.stop();
            }
        } catch (IllegalStateException ignored) {
            // MediaPlayer state can change from completion callback while UI is updating.
        }
        audioPlayer.release();
        audioPlayer = null;
    }

    private String tokenLabel() {
        if (token == null || token.trim().isEmpty()) {
            return "未获取";
        }
        return RokidProbeText.summarizeToken(token);
    }

    private static String connectionLabel(boolean value) {
        return value ? "已连接" : "未连接";
    }

    private static String yesNo(boolean value) {
        return value ? "是" : "否";
    }

    private boolean nativeVoiceAuthConfigured() {
        return nativeVoiceAccessKey != null && !nativeVoiceAccessKey.trim().isEmpty()
                && nativeVoiceSecretKey != null && !nativeVoiceSecretKey.trim().isEmpty();
    }

    private boolean rokidAiSdkConfigured() {
        return currentRokidAiSdkCredentials().isComplete();
    }

    private void updateVisibleControls() {
        if (uiViews == null) {
            return;
        }
        boolean tokenReady = token != null && !token.trim().isEmpty();
        boolean linkReady = isLinkReady();
        boolean customViewSession = cxrController != null && cxrController.isCustomViewSession();
        boolean glassAppSession = cxrController != null && cxrController.isCustomAppSession();
        boolean glassAppReady = linkReady && glassAppSession;
        boolean glassNativeAppReady = glassAppReady && glassAsrAppStarted;
        boolean glassNativeAsrReady = glassNativeAppReady && nativeVoiceReachable && lastNativeVoiceStatus.isAsrReady();
        boolean glassNativeTtsReady = glassNativeAppReady && nativeVoiceReachable && lastNativeVoiceStatus.isTtsReady();
        boolean customViewOpened = isCustomViewOpened();
        boolean hasAudio = lastAudioUri != null;
        boolean playing = audioPlayer != null;

        uiViews.setCapabilityVisible(RokidGlassModule.CAP_APP_AUTH, true);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_LINK, tokenReady);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_CUSTOM_VIEW, linkReady && customViewSession);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_AUDIO, linkReady);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_PHOTO, linkReady);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_DEVICE_CONTROL, linkReady);
        uiViews.setCapabilityVisible(RokidGlassModule.CAP_GLASS_ASR, tokenReady);

        uiViews.setActionVisible(RokidProbeUi.ACTION_CONNECT, tokenReady && (!linkReady || !customViewSession));
        uiViews.setActionVisible(RokidProbeUi.ACTION_OPEN_CUSTOM_VIEW, linkReady && !customViewOpened);
        uiViews.setActionVisible(RokidProbeUi.ACTION_UPDATE_CUSTOM_VIEW, customViewOpened);
        uiViews.setActionVisible(RokidProbeUi.ACTION_CLOSE_CUSTOM_VIEW, customViewOpened);
        uiViews.setActionVisible(RokidProbeUi.ACTION_START_AUDIO, linkReady && !audioStreamStarted);
        uiViews.setActionVisible(RokidProbeUi.ACTION_STOP_AUDIO, linkReady && audioStreamStarted);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PLAY_AUDIO, hasAudio && !playing);
        uiViews.setActionVisible(RokidProbeUi.ACTION_STOP_PLAYBACK, playing);
        uiViews.setActionVisible(RokidProbeUi.ACTION_TAKE_PHOTO, linkReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_GET_DEVICE_INFO, linkReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_SET_DEVICE_CONTROL, linkReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_CONNECT_GLASS_APP_SESSION, tokenReady && (!glassAppReady || !glassAppSession));
        uiViews.setActionVisible(RokidProbeUi.ACTION_QUERY_GLASS_ASR, glassAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_INSTALL_GLASS_ASR, glassAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_START_GLASS_ASR, glassAppReady && glassAsrAppInstalled && !glassAsrAppStarted);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PING_NATIVE_VOICE, glassNativeAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_QUERY_NATIVE_STATUS, glassNativeAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_QUERY_NATIVE_DIAGNOSTICS, glassNativeAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_ARM_OFFLINE_VOICE_CMD, glassNativeAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_CLEAR_OFFLINE_VOICE_CMD, glassNativeAppReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_SCAN_PHONE_BT, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PROBE_PHONE_DEVICE_LINK, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_ASSOCIATE_PHONE_COMPANION, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_CONNECT_PHONE_BT, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PROBE_PHONE_BT_AUTH, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PROBE_PHONE_P2P, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_REQUEST_PHONE_SYSTEM_INFO, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_REQUEST_PHONE_DEVICE_AUDIO_HANDSHAKE, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_REQUEST_PHONE_DEVICE_VIDEO_AUDIO_HANDSHAKE, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_PROBE_PHONE_GLASS_DEVICE, tokenReady);
        uiViews.setActionVisible(RokidProbeUi.ACTION_STOP_GLASS_ASR, glassNativeAppReady);
    }

    private boolean isLinkReady() {
        return cxrController != null && cxrController.isLinkReady();
    }

    private boolean isCustomViewOpened() {
        return cxrController != null && cxrController.isCustomViewOpened();
    }

    private boolean isGlassAppLinkReady() {
        return cxrController != null && cxrController.isLinkReady() && cxrController.isCustomAppSession();
    }

    private String sessionModeLabel() {
        if (cxrController == null) {
            return "未初始化";
        }
        if (cxrController.isCustomAppSession()) {
            return "CustomApp";
        }
        if (cxrController.isCustomViewSession()) {
            return "CustomView";
        }
        return "未选择";
    }
}
