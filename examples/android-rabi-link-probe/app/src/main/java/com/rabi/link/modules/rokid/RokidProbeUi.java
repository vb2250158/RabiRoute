package com.rabi.link.modules.rokid;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.InputType;
import android.text.method.PasswordTransformationMethod;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.View;
import android.view.ViewParent;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.rabi.link.RabiGuidanceTone;
import com.rabi.link.RabiMobileUi;

import java.util.LinkedHashMap;
import java.util.Map;

final class RokidProbeUi {
    private static final String TAG_ACTION_GROUP = "rokid-action-group";
    private static final String TAG_ACTION_GROUP_BUTTONS = "rokid-action-group-buttons";
    private static final String TAG_ACTION_GROUP_TOGGLE = "rokid-action-group-toggle";

    static final String ACTION_CONNECT = "connect";
    static final String ACTION_OPEN_CUSTOM_VIEW = "open_custom_view";
    static final String ACTION_UPDATE_CUSTOM_VIEW = "update_custom_view";
    static final String ACTION_CLOSE_CUSTOM_VIEW = "close_custom_view";
    static final String ACTION_START_AUDIO = "start_audio";
    static final String ACTION_STOP_AUDIO = "stop_audio";
    static final String ACTION_PLAY_AUDIO = "play_audio";
    static final String ACTION_STOP_PLAYBACK = "stop_playback";
    static final String ACTION_TAKE_PHOTO = "take_photo";
    static final String ACTION_GET_DEVICE_INFO = "get_device_info";
    static final String ACTION_SET_DEVICE_CONTROL = "set_device_control";
    static final String ACTION_CONNECT_GLASS_APP_SESSION = "connect_glass_app_session";
    static final String ACTION_QUERY_GLASS_ASR = "query_glass_asr";
    static final String ACTION_INSTALL_GLASS_ASR = "install_glass_asr";
    static final String ACTION_START_GLASS_ASR = "start_glass_asr";
    static final String ACTION_STOP_GLASS_ASR = "stop_glass_asr";
    static final String ACTION_SAVE_NATIVE_VOICE_AUTH = "save_native_voice_auth";
    static final String ACTION_PING_NATIVE_VOICE = "ping_native_voice";
    static final String ACTION_QUERY_NATIVE_STATUS = "query_native_status";
    static final String ACTION_QUERY_NATIVE_DIAGNOSTICS = "query_native_diagnostics";
    static final String ACTION_START_NATIVE_ASR = "start_native_asr";
    static final String ACTION_STOP_NATIVE_ASR = "stop_native_asr";
    static final String ACTION_SEND_NATIVE_TTS = "send_native_tts";
    static final String ACTION_START_NATIVE_ECHO = "start_native_echo";
    static final String ACTION_ARM_OFFLINE_VOICE_CMD = "arm_offline_voice_cmd";
    static final String ACTION_CLEAR_OFFLINE_VOICE_CMD = "clear_offline_voice_cmd";
    static final String ACTION_PROBE_GLASS_ANDROID_VOICE = "probe_glass_android_voice";
    static final String ACTION_START_GLASS_ANDROID_ASR = "start_glass_android_asr";
    static final String ACTION_STOP_GLASS_ANDROID_ASR = "stop_glass_android_asr";
    static final String ACTION_SEND_GLASS_ANDROID_TTS = "send_glass_android_tts";
    static final String ACTION_PROBE_GLASS_ROKID_AI_SDK = "probe_glass_rokid_ai_sdk";
    static final String ACTION_SAVE_GLASS_ROKID_AI_SDK_CONFIG = "save_glass_rokid_ai_sdk_config";
    static final String ACTION_START_GLASS_ROKID_AI_SDK = "start_glass_rokid_ai_sdk";
    static final String ACTION_STOP_GLASS_ROKID_AI_SDK = "stop_glass_rokid_ai_sdk";
    static final String ACTION_SEND_GLASS_ROKID_AI_SDK_TTS = "send_glass_rokid_ai_sdk_tts";
    static final String ACTION_SCAN_PHONE_BT = "scan_phone_bt";
    static final String ACTION_PROBE_PHONE_DEVICE_LINK = "probe_phone_device_link";
    static final String ACTION_ASSOCIATE_PHONE_COMPANION = "associate_phone_companion";
    static final String ACTION_CONNECT_PHONE_BT = "connect_phone_bt";
    static final String ACTION_PROBE_PHONE_BT_AUTH = "probe_phone_bt_auth";
    static final String ACTION_PROBE_PHONE_P2P = "probe_phone_p2p";
    static final String ACTION_REQUEST_PHONE_SYSTEM_INFO = "request_phone_system_info";
    static final String ACTION_REQUEST_PHONE_DEVICE_AUDIO_HANDSHAKE = "request_phone_device_audio_handshake";
    static final String ACTION_REQUEST_PHONE_DEVICE_VIDEO_AUDIO_HANDSHAKE = "request_phone_device_video_audio_handshake";
    static final String ACTION_PROBE_PHONE_GLASS_DEVICE = "probe_phone_glass_device";
    static final String ACTION_PROBE_PHONE_VOICE_AUTH = "probe_phone_voice_auth";
    static final String ACTION_APPLY_PHONE_VOICE_AUTH = "apply_phone_voice_auth";
    static final String ACTION_INIT_PHONE_VOICE = "init_phone_voice";
    static final String ACTION_START_PHONE_ASR_FEED = "start_phone_asr_feed";
    static final String ACTION_STOP_PHONE_ASR_FEED = "stop_phone_asr_feed";
    static final String ACTION_SEND_PHONE_TTS = "send_phone_tts";
    static final String ACTION_PROBE_ANDROID_SYSTEM_VOICE = "probe_android_system_voice";
    static final String ACTION_ROUTE_ANDROID_SYSTEM_BLUETOOTH = "route_android_system_bluetooth";
    static final String ACTION_CLEAR_ANDROID_SYSTEM_BLUETOOTH = "clear_android_system_bluetooth";
    static final String ACTION_START_ANDROID_HEADSET_VOICE = "start_android_headset_voice";
    static final String ACTION_STOP_ANDROID_HEADSET_VOICE = "stop_android_headset_voice";
    static final String ACTION_START_ANDROID_SYSTEM_ASR = "start_android_system_asr";
    static final String ACTION_START_ANDROID_SYSTEM_ASR_INTENT = "start_android_system_asr_intent";
    static final String ACTION_STOP_ANDROID_SYSTEM_ASR = "stop_android_system_asr";
    static final String ACTION_SEND_ANDROID_SYSTEM_TTS = "send_android_system_tts";
    static final String ACTION_START_ANDROID_SYSTEM_LOOPBACK = "start_android_system_loopback";
    static final String ACTION_PROBE_ROKID_AI_SDK = "probe_rokid_ai_sdk";
    static final String ACTION_SAVE_ROKID_AI_SDK_CONFIG = "save_rokid_ai_sdk_config";
    static final String ACTION_START_ROKID_AI_SDK_ASR = "start_rokid_ai_sdk_asr";
    static final String ACTION_STOP_ROKID_AI_SDK = "stop_rokid_ai_sdk";
    static final String ACTION_SEND_ROKID_AI_SDK_TTS = "send_rokid_ai_sdk_tts";
    static final String ACTION_ROKID_AI_SDK_PICKUP_ON = "rokid_ai_sdk_pickup_on";
    static final String ACTION_ROKID_AI_SDK_PICKUP_OFF = "rokid_ai_sdk_pickup_off";

    interface Actions {
        void runEnvironmentProbe();

        void requestAndroidPermissions();

        void requestRokidAuthorization();

        void connectCustomViewSession();

        void connectGlassAppSession();

        void getGlassDeviceInfo();

        void setBrightnessAndVolume();

        void openHelloCustomView();

        void updateHelloCustomView();

        void closeCustomView();

        void startAudioStream();

        void stopAudioStream();

        void playLastAudio();

        void stopAudioPlayback();

        void takePhoto();

        void queryGlassAsrApp();

        void installGlassAsrApp();

        void startGlassAsrApp();

        void stopGlassAsrApp();

        void saveNativeVoiceAuthorization();

        void pingNativeVoiceBridge();

        void queryNativeVoiceStatus();

        void queryNativeVoiceDiagnostics();

        void startNativeAsrRemote();

        void stopNativeAsrRemote();

        void sendNativeTtsTest();

        void startNativeEchoTest();

        void armOfflineVoiceCommands();

        void clearOfflineVoiceCommands();

        void probeGlassAndroidVoice();

        void startGlassAndroidAsr();

        void stopGlassAndroidAsr();

        void sendGlassAndroidTtsTest();

        void probeGlassRokidAiSdk();

        void saveAndSendGlassRokidAiSdkConfig();

        void startGlassRokidAiSdk();

        void stopGlassRokidAiSdk();

        void sendGlassRokidAiSdkTtsTest();

        void scanPhoneBt();

        void probePhoneDeviceLink();

        void associatePhoneCompanionDevice();

        void connectPhoneBt();

        void probePhoneBtAuth();

        void probePhoneP2p();

        void requestPhoneSystemInfo();

        void requestPhoneDeviceAudioHandshake();

        void requestPhoneDeviceVideoAudioHandshake();

        void probePhoneGlassDeviceInfo();

        void probePhoneVoiceAuthorization();

        void applyPhoneVoiceAuthorization();

        void initPhoneVoiceProbe();

        void startPhoneAsrFeed();

        void stopPhoneAsrFeed();

        void sendPhoneTtsTest();

        void probeAndroidSystemVoice();

        void routeAndroidSystemBluetooth();

        void clearAndroidSystemBluetooth();

        void startAndroidHeadsetVoiceRecognition();

        void stopAndroidHeadsetVoiceRecognition();

        void startAndroidSystemAsr();

        void startAndroidSystemAsrIntent();

        void stopAndroidSystemAsr();

        void sendAndroidSystemTtsTest();

        void startAndroidSystemLoopback();

        void probeRokidAiSdkVoice();

        void saveRokidAiSdkConfig();

        void startRokidAiSdkAsr();

        void stopRokidAiSdkVoice();

        void sendRokidAiSdkTtsTest();

        void enableRokidAiSdkPickup();

        void disableRokidAiSdkPickup();

        void copyReport();
    }

    static final class Views {
        final TextView guidanceView;
        final TextView dashboardView;
        final TextView logView;
        final EditText nativeTtsInputView;
        final EditText nativeVoiceAccessKeyView;
        final EditText nativeVoiceSecretKeyView;
        final EditText rokidAiKeyView;
        final EditText rokidAiSecretView;
        final EditText rokidAiDeviceTypeIdView;
        final EditText rokidAiDeviceIdView;
        final EditText rokidAiSeedView;
        final EditText rokidAiWorkDirView;
        final EditText rokidAiConfigFileView;
        private final Map<String, TextView> capabilityStatusViews;
        private final Map<String, View> capabilityBlockViews;
        private final Map<String, Button> actionButtonViews;

        Views(
                TextView guidanceView,
                TextView dashboardView,
                TextView logView,
                EditText nativeTtsInputView,
                EditText nativeVoiceAccessKeyView,
                EditText nativeVoiceSecretKeyView,
                EditText rokidAiKeyView,
                EditText rokidAiSecretView,
                EditText rokidAiDeviceTypeIdView,
                EditText rokidAiDeviceIdView,
                EditText rokidAiSeedView,
                EditText rokidAiWorkDirView,
                EditText rokidAiConfigFileView,
                Map<String, TextView> capabilityStatusViews,
                Map<String, View> capabilityBlockViews,
                Map<String, Button> actionButtonViews
        ) {
            this.guidanceView = guidanceView;
            this.dashboardView = dashboardView;
            this.logView = logView;
            this.nativeTtsInputView = nativeTtsInputView;
            this.nativeVoiceAccessKeyView = nativeVoiceAccessKeyView;
            this.nativeVoiceSecretKeyView = nativeVoiceSecretKeyView;
            this.rokidAiKeyView = rokidAiKeyView;
            this.rokidAiSecretView = rokidAiSecretView;
            this.rokidAiDeviceTypeIdView = rokidAiDeviceTypeIdView;
            this.rokidAiDeviceIdView = rokidAiDeviceIdView;
            this.rokidAiSeedView = rokidAiSeedView;
            this.rokidAiWorkDirView = rokidAiWorkDirView;
            this.rokidAiConfigFileView = rokidAiConfigFileView;
            this.capabilityStatusViews = capabilityStatusViews;
            this.capabilityBlockViews = capabilityBlockViews;
            this.actionButtonViews = actionButtonViews;
        }

        void setDashboard(String text) {
            dashboardView.setText(text);
            updateGuidance(text);
        }

        private void updateGuidance(String text) {
            String normalized = text == null ? "" : text;
            if (normalized.contains("failed") || normalized.contains("失败") || normalized.contains("异常")) {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "自动检查发现问题",
                        "眼镜环境或连接步骤返回了失败状态，详细原始结果已保留在高级诊断里。",
                        "先按提示补齐权限或授权，再点“自动检查环境”；仍失败时展开高级诊断复制日志。",
                        RabiGuidanceTone.ERROR
                );
            } else if (normalized.contains("token") && (normalized.contains("未获取") || normalized.contains("missing"))) {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "还需要一次 Rokid 安全授权",
                        "手机不能替你确认系统级账号授权，所以这一步无法静默自动完成。",
                        "点“Rokid 安全授权”，在系统页面确认后返回；App 会继续检查连接状态。",
                        RabiGuidanceTone.WARNING
                );
            } else if (normalized.contains("installed=否") || normalized.contains("installed=no")) {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "眼镜已可连接，还缺眼镜端 Rabi",
                        "手机端不能绕过眼镜的安装确认，首次安装需要你保持眼镜在线。",
                        "点“安装眼镜端”，按设备提示确认；安装完成后再点“启动眼镜端”。",
                        RabiGuidanceTone.INFO
                );
            } else if (normalized.contains("installed=是") && (normalized.contains("started=否") || normalized.contains("started=no"))) {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "眼镜端已安装",
                        "Rabi 眼镜端还没有启动，因此暂时不能收发界面和语音指令。",
                        "点“启动眼镜端”，启动后 App 会继续确认通信状态。",
                        RabiGuidanceTone.INFO
                );
            } else if (normalized.contains("started=是") || normalized.contains("ready")) {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "Rokid 眼镜已准备好",
                        "授权、连接和眼镜端运行状态均已通过。",
                        "返回首页继续使用；只有排障时才需要展开高级诊断。",
                        RabiGuidanceTone.SUCCESS
                );
            } else {
                RabiMobileUi.styleGuidance(
                        guidanceView.getContext(), guidanceView,
                        "正在自动检查眼镜环境",
                        "App 会自动识别 Rokid 应用、权限、授权和连接状态。",
                        "先点“自动检查环境”；遇到必须由你确认的系统步骤时，这里会说明原因和下一步。",
                        RabiGuidanceTone.INFO
                );
            }
        }

        void setCapabilityStatus(String capabilityId, String status, String summary) {
            TextView view = capabilityStatusViews.get(capabilityId);
            if (view == null) {
                return;
            }
            view.setText("状态：" + status + "\n" + summary);
            view.setTextColor(statusColor(status));
        }

        void setCapabilityVisible(String capabilityId, boolean visible) {
            View view = capabilityBlockViews.get(capabilityId);
            if (view != null) {
                view.setVisibility(visible ? View.VISIBLE : View.GONE);
            }
        }

        void setActionVisible(String actionId, boolean visible) {
            Button button = actionButtonViews.get(actionId);
            if (button != null) {
                button.setVisibility(visible ? View.VISIBLE : View.GONE);
                refreshActionGroupFor(button);
            }
        }

        String nativeTtsText(String fallback) {
            if (nativeTtsInputView == null || nativeTtsInputView.getText() == null) {
                return fallback;
            }
            String text = nativeTtsInputView.getText().toString().trim();
            return text.isEmpty() ? fallback : text;
        }

        void setNativeVoiceCredentials(String accessKey, String secretKey) {
            if (nativeVoiceAccessKeyView != null) {
                nativeVoiceAccessKeyView.setText(accessKey == null ? "" : accessKey);
            }
            if (nativeVoiceSecretKeyView != null) {
                nativeVoiceSecretKeyView.setText(secretKey == null ? "" : secretKey);
            }
        }

        String nativeVoiceAccessKey() {
            return editTextValue(nativeVoiceAccessKeyView);
        }

        String nativeVoiceSecretKey() {
            return editTextValue(nativeVoiceSecretKeyView);
        }

        void setRokidAiSdkCredentials(RokidAiSdkVoiceBridge.Credentials credentials) {
            if (credentials == null) {
                return;
            }
            setText(rokidAiKeyView, credentials.key);
            setText(rokidAiSecretView, credentials.secret);
            setText(rokidAiDeviceTypeIdView, credentials.deviceTypeId);
            setText(rokidAiDeviceIdView, credentials.deviceId);
            setText(rokidAiSeedView, credentials.seed);
            setText(rokidAiWorkDirView, credentials.workDir);
            setText(rokidAiConfigFileView, credentials.configFile);
        }

        RokidAiSdkVoiceBridge.Credentials rokidAiSdkCredentials() {
            return new RokidAiSdkVoiceBridge.Credentials(
                    editTextValue(rokidAiKeyView),
                    editTextValue(rokidAiSecretView),
                    editTextValue(rokidAiDeviceTypeIdView),
                    editTextValue(rokidAiDeviceIdView),
                    editTextValue(rokidAiSeedView),
                    valueOrDefault(editTextValue(rokidAiWorkDirView), RokidAiSdkVoiceBridge.DEFAULT_WORK_DIR),
                    valueOrDefault(editTextValue(rokidAiConfigFileView), RokidAiSdkVoiceBridge.DEFAULT_CONFIG_FILE)
            );
        }

        private static void setText(EditText view, String value) {
            if (view != null) {
                view.setText(value == null ? "" : value);
            }
        }

        private static String valueOrDefault(String value, String fallback) {
            return value == null || value.trim().isEmpty() ? fallback : value.trim();
        }

        private static String editTextValue(EditText view) {
            if (view == null || view.getText() == null) {
                return "";
            }
            return view.getText().toString().trim();
        }
    }

    private RokidProbeUi() {
    }

    static Views install(Activity activity, Actions actions) {
        Map<String, TextView> statusViews = new LinkedHashMap<>();
        Map<String, View> blockViews = new LinkedHashMap<>();
        Map<String, Button> actionViews = new LinkedHashMap<>();

        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(activity, 18), dp(activity, 16), dp(activity, 18), dp(activity, 18));
        content.setBackgroundColor(RabiMobileUi.backgroundColor());

        addHeader(activity, content);

        TextView guidanceView = new TextView(activity);
        RabiMobileUi.styleGuidance(
                activity, guidanceView,
                "正在自动检查眼镜环境",
                "App 会自动识别 Rokid 应用、权限、授权和连接状态。",
                "先点“自动检查环境”；遇到必须由你确认的系统步骤时，这里会说明原因和下一步。",
                RabiGuidanceTone.INFO
        );
        content.addView(guidanceView, fullWidthWithMargins(activity, 0, 12, 0, 12));

        addBeginnerSetup(activity, content, actions);

        LinearLayout diagnostics = new LinearLayout(activity);
        diagnostics.setOrientation(LinearLayout.VERTICAL);
        diagnostics.setVisibility(View.GONE);

        Button diagnosticsToggle = button(activity, "显示高级诊断", null);
        diagnosticsToggle.setOnClickListener(v -> {
            boolean show = diagnostics.getVisibility() != View.VISIBLE;
            diagnostics.setVisibility(show ? View.VISIBLE : View.GONE);
            diagnosticsToggle.setText(show ? "收起高级诊断" : "显示高级诊断");
        });
        content.addView(diagnosticsToggle, fullWidthWithMargins(activity, 0, 0, 0, 10));

        TextView dashboardView = addDashboard(activity, diagnostics);
        EditText nativeTtsInput = nativeTtsInput(activity);
        EditText nativeVoiceAccessKeyInput = nativeVoiceCredentialInput(activity, "Rokid 在线语音 AccessKey");
        EditText nativeVoiceSecretKeyInput = nativeVoiceCredentialInput(activity, "Rokid 在线语音 SecretKey");
        EditText rokidAiKeyInput = credentialInput(activity, "RokidAiSdk Key");
        EditText rokidAiSecretInput = credentialInput(activity, "RokidAiSdk Secret");
        EditText rokidAiDeviceTypeIdInput = credentialInput(activity, "RokidAiSdk deviceTypeId");
        EditText rokidAiDeviceIdInput = credentialInput(activity, "RokidAiSdk deviceId / SN");
        EditText rokidAiSeedInput = credentialInput(activity, "RokidAiSdk seed");
        EditText rokidAiWorkDirInput = plainInput(activity, "workDir，默认 workdir_asr_cn");
        EditText rokidAiConfigFileInput = plainInput(activity, "configFile，默认 lothal_single.ini");
        View nativeVoiceExtra = nativeVoiceExtraContent(activity, nativeTtsInput, nativeVoiceAccessKeyInput, nativeVoiceSecretKeyInput);
        View rokidAiSdkExtra = rokidAiSdkExtraContent(
                activity,
                rokidAiKeyInput,
                rokidAiSecretInput,
                rokidAiDeviceTypeIdInput,
                rokidAiDeviceIdInput,
                rokidAiSeedInput,
                rokidAiWorkDirInput,
                rokidAiConfigFileInput
        );

        addSectionTitle(activity, diagnostics, "完整测试矩阵");
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_APP_AUTH,
                "01 前置环境与授权",
                "先确认 Rokid AI App、SDK 类、Android 权限和授权 token。",
                "用途：判断这台手机是否具备接入眼镜的基础条件，后续所有接口都依赖这里的授权结果。",
                "前置：安装 Rokid AI App；手机允许相机/麦克风权限。",
                "证据：包名、版本、SDK 类、权限状态、token 摘要。",
                new ActionButton("check_environment", "检查环境", v -> actions.runEnvironmentProbe()),
                new ActionButton("android_permissions", "Android 权限", v -> actions.requestAndroidPermissions()),
                new ActionButton("rokid_auth", "Rokid 授权", v -> actions.requestRokidAuthorization())
        );
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_LINK,
                "02 连接层 / CXRLink",
                "验证手机 APK 是否已经通过 Rokid SDK 接到眼镜。",
                "用途：它不是一个具体业务功能，而是下面 GUI、音频、拍照和设备状态接口共用的桥接通道。",
                "前置：已有 token；眼镜蓝牙已连接并处于可用状态。",
                "证据：connect 返回值、手机链路回调、眼镜蓝牙回调、session reason。",
                new ActionButton(ACTION_CONNECT, "连接会话", v -> actions.connectCustomViewSession())
        );
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_CUSTOM_VIEW,
                "03 眼镜 GUI / CustomView",
                "验证能否在眼镜端画自定义界面，并测试打开、刷新和关闭。",
                "用途：在眼镜视野里显示提示、确认框、短回复、状态面板或 Codex/Rabi 的轻量交互界面。",
                "前置：CustomView 会话 available；眼镜亮屏、佩戴中。",
                "证据：customViewOpen/Update/Close 返回值和回调。",
                new ActionButton(ACTION_OPEN_CUSTOM_VIEW, "打开 Hello", v -> actions.openHelloCustomView()),
                new ActionButton(ACTION_UPDATE_CUSTOM_VIEW, "更新", v -> actions.updateHelloCustomView()),
                new ActionButton(ACTION_CLOSE_CUSTOM_VIEW, "关闭", v -> actions.closeCustomView())
        );
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_AUDIO,
                "04 音频流",
                "验证眼镜音频流输入，停止后保存 WAV 证据文件。",
                "用途：确认眼镜麦克风是否能作为语音输入源，用于语音指令、实时转写或对话采样；回放用于确认录到的是有效声音。",
                "前置：会话已连接并 ready；麦克风权限已允许；开始后需要对着眼镜说话。",
                "证据：start/stop 返回值、非零 PCM 字节数、WAV URI、手机扬声器回放。",
                new ActionButton(ACTION_START_AUDIO, "开始音频", v -> actions.startAudioStream()),
                new ActionButton(ACTION_STOP_AUDIO, "停止并保存", v -> actions.stopAudioStream()),
                new ActionButton(ACTION_PLAY_AUDIO, "播放最近 WAV", v -> actions.playLastAudio()),
                new ActionButton(ACTION_STOP_PLAYBACK, "停止播放", v -> actions.stopAudioPlayback())
        );
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_PHOTO,
                "05 拍照",
                "验证眼镜拍照接口，保存 JPEG 证据。",
                "用途：让眼镜把当前视野作为上下文输入，可用于看物识别、截图取证、环境理解和任务确认。",
                "前置：会话已连接；相机权限已允许。",
                "证据：takePhoto 返回值、JPEG 字节数、保存 URI。",
                new ActionButton(ACTION_TAKE_PHOTO, RokidProbeDefaults.photoLabel(), v -> actions.takePhoto())
        );
        addCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_DEVICE_CONTROL,
                "06 设备信息与控制",
                "读取眼镜状态，并测试亮度、音量写入。",
                "用途：判断眼镜是否佩戴、是否亮屏、电量是否足够，并验证基础控制能否服务于长时间交互。",
                "前置：眼镜在线；最好佩戴且屏幕亮起。",
                "证据：设备名、电量、佩戴、充电、屏幕、系统版本、亮度和音量返回值。",
                new ActionButton(ACTION_GET_DEVICE_INFO, "读取设备信息", v -> actions.getGlassDeviceInfo()),
                new ActionButton(ACTION_SET_DEVICE_CONTROL, RokidProbeDefaults.brightnessAndVolumeLabel(), v -> actions.setBrightnessAndVolume())
        );
        addGlassAppCapabilityBlock(
                activity,
                diagnostics,
                statusViews,
                blockViews,
                actionViews,
                RokidGlassModule.CAP_GLASS_ASR,
                "07 Rabi Glass / CustomApp",
                "安装并启动内置眼镜 APK，验证 CustomApp 会话、CXR CustomCmd 和基础回包。",
                "用途：保留眼镜端测试负载，用来验证安装、启动、消息桥和后续非 ASR 方向的实验。",
                "前置：已有 token；需要切换到 CustomApp 会话；眼镜允许安装和启动测试 APK。",
                "证据：CustomApp 会话状态、安装/查询/启动回调、Ping/状态/诊断回包。",
                new ActionGroup(
                        "核心流程",
                        "按顺序完成会话、安装和启动；平时主要用这一组。",
                        false,
                        new ActionButton(ACTION_CONNECT_GLASS_APP_SESSION, "连接应用会话", v -> actions.connectGlassAppSession()),
                        new ActionButton(ACTION_QUERY_GLASS_ASR, "查询安装", v -> actions.queryGlassAsrApp()),
                        new ActionButton(ACTION_INSTALL_GLASS_ASR, "安装眼镜 APK", v -> actions.installGlassAsrApp()),
                        new ActionButton(ACTION_START_GLASS_ASR, "启动眼镜 APK", v -> actions.startGlassAsrApp()),
                        new ActionButton(ACTION_STOP_GLASS_ASR, "停止应用", v -> actions.stopGlassAsrApp())
                ),
                new ActionGroup(
                        "常用回包",
                        "确认眼镜端 CustomCmd 是否能收发消息。",
                        false,
                        new ActionButton(ACTION_PING_NATIVE_VOICE, "Ping 眼镜", v -> actions.pingNativeVoiceBridge()),
                        new ActionButton(ACTION_QUERY_NATIVE_STATUS, "查询原生状态", v -> actions.queryNativeVoiceStatus()),
                        new ActionButton(ACTION_QUERY_NATIVE_DIAGNOSTICS, "原生诊断", v -> actions.queryNativeVoiceDiagnostics()),
                        new ActionButton(ACTION_PROBE_PHONE_GLASS_DEVICE, "检查手机设备信息", v -> actions.probePhoneGlassDeviceInfo())
                ),
                new ActionGroup(
                        "高级探针",
                        "低频排障动作，默认收起，避免 07 卡片被按钮挤满。",
                        true,
                        new ActionButton(ACTION_ARM_OFFLINE_VOICE_CMD, "注册离线指令", v -> actions.armOfflineVoiceCommands()),
                        new ActionButton(ACTION_CLEAR_OFFLINE_VOICE_CMD, "清除离线指令", v -> actions.clearOfflineVoiceCommands()),
                        new ActionButton(ACTION_SCAN_PHONE_BT, "扫描手机 BT", v -> actions.scanPhoneBt()),
                        new ActionButton(ACTION_PROBE_PHONE_DEVICE_LINK, "官方连接探针", v -> actions.probePhoneDeviceLink()),
                        new ActionButton(ACTION_ASSOCIATE_PHONE_COMPANION, "系统关联眼镜", v -> actions.associatePhoneCompanionDevice()),
                        new ActionButton(ACTION_CONNECT_PHONE_BT, "连接已配对眼镜 BT", v -> actions.connectPhoneBt()),
                        new ActionButton(ACTION_PROBE_PHONE_BT_AUTH, "检查手机 BT/Auth", v -> actions.probePhoneBtAuth()),
                        new ActionButton(ACTION_PROBE_PHONE_P2P, "P2P 探针", v -> actions.probePhoneP2p()),
                        new ActionButton(ACTION_REQUEST_PHONE_SYSTEM_INFO, "官方系统信息", v -> actions.requestPhoneSystemInfo()),
                        new ActionButton(ACTION_REQUEST_PHONE_DEVICE_AUDIO_HANDSHAKE, "触发手机设备握手", v -> actions.requestPhoneDeviceAudioHandshake()),
                        new ActionButton(ACTION_REQUEST_PHONE_DEVICE_VIDEO_AUDIO_HANDSHAKE, "视频+音频握手", v -> actions.requestPhoneDeviceVideoAudioHandshake())
                )
        );

        content.addView(diagnostics, new LinearLayout.LayoutParams(-1, -2));

        ScrollView page = new ScrollView(activity);
        page.addView(content);

        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(RabiMobileUi.backgroundColor());
        root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));

        TextView logView = addFixedLogPanel(activity, root, actions);
        activity.setContentView(root);

        return new Views(
                guidanceView,
                dashboardView,
                logView,
                nativeTtsInput,
                nativeVoiceAccessKeyInput,
                nativeVoiceSecretKeyInput,
                rokidAiKeyInput,
                rokidAiSecretInput,
                rokidAiDeviceTypeIdInput,
                rokidAiDeviceIdInput,
                rokidAiSeedInput,
                rokidAiWorkDirInput,
                rokidAiConfigFileInput,
                statusViews,
                blockViews,
                actionViews
        );
    }

    private static void addBeginnerSetup(Activity activity, LinearLayout content, Actions actions) {
        LinearLayout card = new LinearLayout(activity);
        RabiMobileUi.styleCard(activity, card);

        TextView title = text(activity, "连接向导", 17, RabiMobileUi.primaryColor());
        title.setTypeface(Typeface.DEFAULT_BOLD);
        card.addView(title, new LinearLayout.LayoutParams(-1, -2));
        card.addView(
                text(
                        activity,
                        "App 会先自动检查；只有 Android 权限、Rokid 账号授权和眼镜安装确认需要你亲自同意。按这里的顺序操作，不必理解下面的 SDK 参数。",
                        13,
                        RabiMobileUi.mutedColor()
                ),
                fullWidthWithMargins(activity, 0, 5, 0, 10)
        );

        Button autoCheck = button(activity, "1. 自动检查环境", v -> actions.runEnvironmentProbe());
        RabiMobileUi.stylePrimaryButton(activity, autoCheck);
        card.addView(autoCheck, fullWidthWithMargins(activity, 0, 0, 0, 7));
        card.addView(button(activity, "2. 允许手机权限", v -> actions.requestAndroidPermissions()), fullWidthWithMargins(activity, 0, 0, 0, 7));
        card.addView(button(activity, "3. Rokid 安全授权", v -> actions.requestRokidAuthorization()), fullWidthWithMargins(activity, 0, 0, 0, 7));
        card.addView(button(activity, "4. 连接眼镜", v -> actions.connectGlassAppSession()), fullWidthWithMargins(activity, 0, 0, 0, 7));
        card.addView(button(activity, "5. 安装眼镜端", v -> actions.installGlassAsrApp()), fullWidthWithMargins(activity, 0, 0, 0, 7));
        card.addView(button(activity, "6. 启动眼镜端", v -> actions.startGlassAsrApp()), fullWidthWithMargins(activity, 0, 0, 0, 0));
        content.addView(card, fullWidthWithMargins(activity, 0, 0, 0, 12));
    }

    private static TextView addFixedLogPanel(Activity activity, LinearLayout root, Actions actions) {
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(activity, 12), dp(activity, 10), dp(activity, 12), dp(activity, 12));
        panel.setBackground(panelBackground(Color.WHITE, RabiMobileUi.borderColor()));

        LinearLayout header = new LinearLayout(activity);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(activity);
        title.setText("运行日志");
        title.setTextSize(14);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.rgb(32, 38, 46));
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));

        Button toggleButton = button(activity, "展开日志", null);
        header.addView(toggleButton, new LinearLayout.LayoutParams(dp(activity, 106), -2));

        Button copyButton = button(activity, "复制", v -> actions.copyReport());
        header.addView(copyButton, new LinearLayout.LayoutParams(dp(activity, 76), -2));
        panel.addView(header, new LinearLayout.LayoutParams(-1, -2));

        TextView logView = new TextView(activity);
        logView.setTextSize(11);
        logView.setTextColor(Color.rgb(36, 39, 44));
        logView.setPadding(dp(activity, 10), dp(activity, 8), dp(activity, 10), dp(activity, 8));
        logView.setMovementMethod(new ScrollingMovementMethod());
        logView.setBackground(panelBackground(Color.rgb(247, 248, 250), Color.rgb(224, 228, 234)));

        ScrollView logScroll = new ScrollView(activity);
        logScroll.addView(logView);
        logScroll.setVisibility(View.GONE);
        panel.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        root.addView(panel, new LinearLayout.LayoutParams(-1, dp(activity, 76)));
        toggleButton.setOnClickListener(v -> {
            boolean expand = logScroll.getVisibility() != View.VISIBLE;
            logScroll.setVisibility(expand ? View.VISIBLE : View.GONE);
            toggleButton.setText(expand ? "收起日志" : "展开日志");
            LinearLayout.LayoutParams params = (LinearLayout.LayoutParams) panel.getLayoutParams();
            params.height = dp(activity, expand ? 260 : 76);
            panel.setLayoutParams(params);
        });
        return logView;
    }

    private static void addHeader(Activity activity, LinearLayout content) {
        content.addView(
                RabiMobileUi.hero(
                        activity,
                        "连接 Rokid 眼镜",
                        "能自动检查的由 Rabi 完成；必须由你确认的权限、授权和安装会说明原因。"
                ),
                new LinearLayout.LayoutParams(-1, -2)
        );
    }

    private static TextView addDashboard(Activity activity, LinearLayout content) {
        TextView dashboard = new TextView(activity);
        dashboard.setTextSize(13);
        dashboard.setTextColor(RabiMobileUi.textColor());
        dashboard.setPadding(dp(activity, 14), dp(activity, 12), dp(activity, 14), dp(activity, 12));
        dashboard.setBackground(panelBackground(Color.rgb(239, 253, 255), Color.rgb(165, 227, 229)));
        dashboard.setText("状态面板初始化中...");
        content.addView(dashboard, fullWidthWithMargins(activity, 0, 0, 0, 14));
        return dashboard;
    }

    private static void addSectionTitle(Activity activity, LinearLayout content, String text) {
        TextView title = new TextView(activity);
        title.setText(text);
        title.setTextSize(15);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(RabiMobileUi.primaryColor());
        title.setPadding(0, dp(activity, 8), 0, dp(activity, 8));
        content.addView(title, new LinearLayout.LayoutParams(-1, -2));
    }

    private static void addCapabilityBlock(
            Activity activity,
            LinearLayout content,
            Map<String, TextView> statusViews,
            Map<String, View> blockViews,
            Map<String, Button> actionViews,
            String capabilityId,
            String title,
            String summary,
            String useCase,
            String prerequisite,
            String evidence,
            ActionButton... actions
    ) {
        addCapabilityBlockWithExtra(
                activity,
                content,
                statusViews,
                blockViews,
                actionViews,
                capabilityId,
                title,
                summary,
                useCase,
                prerequisite,
                evidence,
                null,
                actions
        );
    }

    private static void addCapabilityBlockWithExtra(
            Activity activity,
            LinearLayout content,
            Map<String, TextView> statusViews,
            Map<String, View> blockViews,
            Map<String, Button> actionViews,
            String capabilityId,
            String title,
            String summary,
            String useCase,
            String prerequisite,
            String evidence,
            View extraContent,
            ActionButton... actions
    ) {
        LinearLayout block = new LinearLayout(activity);
        blockViews.put(capabilityId, block);
        RabiMobileUi.styleCard(activity, block);

        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextSize(16);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextColor(RabiMobileUi.primaryColor());
        block.addView(titleView, new LinearLayout.LayoutParams(-1, -2));

        TextView summaryView = text(activity, summary, 13, Color.rgb(70, 77, 88));
        summaryView.setPadding(0, dp(activity, 4), 0, dp(activity, 6));
        block.addView(summaryView, new LinearLayout.LayoutParams(-1, -2));

        block.addView(text(activity, useCase, 12, Color.rgb(58, 76, 102)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(activity, prerequisite, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(activity, evidence, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));

        TextView status = text(activity, "状态：待测", 12, Color.rgb(111, 118, 128));
        status.setPadding(0, dp(activity, 8), 0, dp(activity, 8));
        statusViews.put(capabilityId, status);
        block.addView(status, new LinearLayout.LayoutParams(-1, -2));

        if (extraContent != null) {
            block.addView(extraContent, fullWidthWithMargins(activity, 0, 0, 0, 8));
        }

        LinearLayout buttonRow = new LinearLayout(activity);
        buttonRow.setOrientation(LinearLayout.VERTICAL);
        for (ActionButton action : actions) {
            Button button = button(activity, action.label, action.listener);
            actionViews.put(action.id, button);
            buttonRow.addView(button, fullWidthWithMargins(activity, 0, 0, 0, 6));
        }
        block.addView(buttonRow, new LinearLayout.LayoutParams(-1, -2));

        content.addView(block, fullWidthWithMargins(activity, 0, 0, 0, 12));
    }

    private static void addGlassAppCapabilityBlock(
            Activity activity,
            LinearLayout content,
            Map<String, TextView> statusViews,
            Map<String, View> blockViews,
            Map<String, Button> actionViews,
            String capabilityId,
            String title,
            String summary,
            String useCase,
            String prerequisite,
            String evidence,
            ActionGroup... groups
    ) {
        LinearLayout block = new LinearLayout(activity);
        blockViews.put(capabilityId, block);
        RabiMobileUi.styleCard(activity, block);

        TextView titleView = new TextView(activity);
        titleView.setText(title);
        titleView.setTextSize(16);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextColor(RabiMobileUi.primaryColor());
        block.addView(titleView, new LinearLayout.LayoutParams(-1, -2));

        TextView summaryView = text(activity, summary, 13, Color.rgb(70, 77, 88));
        summaryView.setPadding(0, dp(activity, 4), 0, dp(activity, 6));
        block.addView(summaryView, new LinearLayout.LayoutParams(-1, -2));

        block.addView(text(activity, useCase, 12, Color.rgb(58, 76, 102)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(activity, prerequisite, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(activity, evidence, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));

        TextView status = text(activity, "状态：待测", 12, Color.rgb(111, 118, 128));
        status.setPadding(0, dp(activity, 8), 0, dp(activity, 8));
        statusViews.put(capabilityId, status);
        block.addView(status, new LinearLayout.LayoutParams(-1, -2));

        for (ActionGroup group : groups) {
            addActionGroup(activity, block, actionViews, group);
        }

        content.addView(block, fullWidthWithMargins(activity, 0, 0, 0, 12));
    }

    private static void addActionGroup(
            Activity activity,
            LinearLayout block,
            Map<String, Button> actionViews,
            ActionGroup group
    ) {
        LinearLayout groupContainer = new LinearLayout(activity);
        groupContainer.setOrientation(LinearLayout.VERTICAL);
        groupContainer.setTag(TAG_ACTION_GROUP);
        groupContainer.setPadding(dp(activity, 10), dp(activity, 8), dp(activity, 10), dp(activity, 8));
        groupContainer.setBackground(panelBackground(Color.rgb(247, 249, 252), Color.rgb(226, 231, 238)));

        TextView title = text(activity, group.title, 13, Color.rgb(36, 44, 56));
        title.setTypeface(Typeface.DEFAULT_BOLD);
        groupContainer.addView(title, new LinearLayout.LayoutParams(-1, -2));
        groupContainer.addView(text(activity, group.summary, 11, Color.rgb(100, 108, 120)), fullWidthWithMargins(activity, 0, 2, 0, 8));

        LinearLayout buttonColumn = new LinearLayout(activity);
        buttonColumn.setOrientation(LinearLayout.VERTICAL);
        buttonColumn.setTag(TAG_ACTION_GROUP_BUTTONS);
        for (ActionButton action : group.actions) {
            Button button = button(activity, action.label, action.listener);
            actionViews.put(action.id, button);
            buttonColumn.addView(button, fullWidthWithMargins(activity, 0, 0, 0, 6));
        }

        if (!group.collapsible) {
            groupContainer.addView(buttonColumn, new LinearLayout.LayoutParams(-1, -2));
            block.addView(groupContainer, fullWidthWithMargins(activity, 0, 0, 0, 8));
            refreshActionGroup(groupContainer);
            return;
        }

        buttonColumn.setVisibility(View.GONE);
        Button toggle = button(activity, "展开" + group.title, null);
        toggle.setTag(TAG_ACTION_GROUP_TOGGLE);
        toggle.setOnClickListener(v -> {
            boolean expand = buttonColumn.getVisibility() != View.VISIBLE;
            buttonColumn.setVisibility(expand ? View.VISIBLE : View.GONE);
            refreshActionGroup(groupContainer);
        });
        groupContainer.addView(toggle, fullWidthWithMargins(activity, 0, 0, 0, 6));
        groupContainer.addView(buttonColumn, new LinearLayout.LayoutParams(-1, -2));
        block.addView(groupContainer, fullWidthWithMargins(activity, 0, 0, 0, 8));
        refreshActionGroup(groupContainer);
    }

    private static void refreshActionGroupFor(View child) {
        ViewParent parent = child.getParent();
        while (parent instanceof View) {
            View view = (View) parent;
            if (TAG_ACTION_GROUP.equals(view.getTag())) {
                refreshActionGroup(view);
                return;
            }
            parent = parent.getParent();
        }
    }

    private static void refreshActionGroup(View groupView) {
        if (!(groupView instanceof LinearLayout)) {
            return;
        }
        LinearLayout group = (LinearLayout) groupView;
        LinearLayout buttonColumn = null;
        Button toggle = null;
        for (int i = 0; i < group.getChildCount(); i++) {
            View child = group.getChildAt(i);
            if (TAG_ACTION_GROUP_BUTTONS.equals(child.getTag()) && child instanceof LinearLayout) {
                buttonColumn = (LinearLayout) child;
            } else if (TAG_ACTION_GROUP_TOGGLE.equals(child.getTag()) && child instanceof Button) {
                toggle = (Button) child;
            }
        }
        if (buttonColumn == null) {
            return;
        }
        int visibleActions = 0;
        for (int i = 0; i < buttonColumn.getChildCount(); i++) {
            if (buttonColumn.getChildAt(i).getVisibility() == View.VISIBLE) {
                visibleActions++;
            }
        }
        group.setVisibility(visibleActions > 0 ? View.VISIBLE : View.GONE);
        if (toggle != null) {
            String label = buttonColumn.getVisibility() == View.VISIBLE ? "收起高级探针" : "展开高级探针";
            toggle.setText(label + "（" + visibleActions + "）");
        }
    }

    private static EditText nativeTtsInput(Activity activity) {
        EditText input = new EditText(activity);
        input.setSingleLine(false);
        input.setMinLines(2);
        input.setMaxLines(4);
        input.setText("Rabi 原生 TTS 测试");
        input.setHint("输入要让眼镜播报的 TTS 文本");
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        RabiMobileUi.styleInput(activity, input, true);
        return input;
    }

    private static EditText nativeVoiceCredentialInput(Activity activity, String hint) {
        return credentialInput(activity, hint);
    }

    private static EditText credentialInput(Activity activity, String hint) {
        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        input.setTransformationMethod(PasswordTransformationMethod.getInstance());
        RabiMobileUi.styleInput(activity, input);
        return input;
    }

    private static EditText plainInput(Activity activity, String hint) {
        EditText input = new EditText(activity);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT);
        RabiMobileUi.styleInput(activity, input);
        return input;
    }

    private static LinearLayout nativeVoiceExtraContent(
            Activity activity,
            EditText nativeTtsInput,
            EditText nativeVoiceAccessKeyInput,
            EditText nativeVoiceSecretKeyInput
    ) {
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.addView(text(activity, "在线语音授权仅保存在本机；当前因 SDK 会打印 UserAuthInfo，暂不自动注入初始化参数。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(text(activity, "手机语音按钮会使用 Rokid Phone SDK 的 ASR/TTS WebSocket 引擎；ASR 会把 CXR 音频流 PCM 旁路喂入。未通过手机语音授权 readiness 前，在线 ASR/TTS 测试按钮会隐藏。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(nativeVoiceAccessKeyInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(nativeVoiceSecretKeyInput, fullWidthWithMargins(activity, 0, 0, 0, 8));
        layout.addView(nativeTtsInput, fullWidthWithMargins(activity, 0, 0, 0, 0));
        return layout;
    }

    private static LinearLayout rokidAiSdkExtraContent(
            Activity activity,
            EditText keyInput,
            EditText secretInput,
            EditText deviceTypeIdInput,
            EditText deviceIdInput,
            EditText seedInput,
            EditText workDirInput,
            EditText configFileInput
    ) {
        LinearLayout layout = new LinearLayout(activity);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.addView(text(activity, "RokidAiSdk 凭证只保存在本机 SharedPreferences；日志、报告和眼镜 CustomCmd 回包只显示脱敏摘要。", 12, Color.rgb(92, 98, 108)), fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(keyInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(secretInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(deviceTypeIdInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(deviceIdInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(seedInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(workDirInput, fullWidthWithMargins(activity, 0, 0, 0, 6));
        layout.addView(configFileInput, fullWidthWithMargins(activity, 0, 0, 0, 0));
        return layout;
    }

    private static TextView text(Activity activity, String text, int size, int color) {
        TextView view = new TextView(activity);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private static Button button(Activity activity, String text, View.OnClickListener listener) {
        Button button = new Button(activity);
        button.setText(text);
        button.setGravity(Gravity.CENTER);
        button.setOnClickListener(listener);
        RabiMobileUi.styleSecondaryButton(activity, button);
        return button;
    }

    private static LinearLayout.LayoutParams fullWidthWithMargins(Activity activity, int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(dp(activity, left), dp(activity, top), dp(activity, right), dp(activity, bottom));
        return params;
    }

    private static GradientDrawable panelBackground(int color, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setStroke(1, stroke);
        drawable.setCornerRadius(12);
        return drawable;
    }

    private static int statusColor(String status) {
        if ("ok".equals(status) || "started".equals(status) || "requested".equals(status) || "checked".equals(status)) {
            return Color.rgb(24, 128, 72);
        }
        if ("failed".equals(status)) {
            return Color.rgb(176, 48, 48);
        }
        if ("partial".equals(status)) {
            return Color.rgb(148, 104, 20);
        }
        return Color.rgb(111, 118, 128);
    }

    private static int dp(Activity activity, int value) {
        return RabiMobileUi.dp(activity, value);
    }

    private static final class ActionButton {
        final String id;
        final String label;
        final View.OnClickListener listener;

        ActionButton(String id, String label, View.OnClickListener listener) {
            this.id = id;
            this.label = label;
            this.listener = listener;
        }
    }

    private static final class ActionGroup {
        final String title;
        final String summary;
        final boolean collapsible;
        final ActionButton[] actions;

        ActionGroup(String title, String summary, boolean collapsible, ActionButton... actions) {
            this.title = title;
            this.summary = summary;
            this.collapsible = collapsible;
            this.actions = actions;
        }
    }
}
