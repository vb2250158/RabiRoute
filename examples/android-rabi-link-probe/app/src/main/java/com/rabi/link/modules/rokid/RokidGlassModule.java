package com.rabi.link.modules.rokid;

import com.rabi.link.bridge.Capability;
import com.rabi.link.bridge.DeviceModule;

import java.util.Arrays;
import java.util.List;

public final class RokidGlassModule implements DeviceModule {
    public static final String ID = "rokid-glass";
    public static final String CAP_APP_AUTH = "rokid.app_auth";
    public static final String CAP_LINK = "rokid.link";
    public static final String CAP_CUSTOM_VIEW = "rokid.custom_view";
    public static final String CAP_AUDIO = "rokid.audio";
    public static final String CAP_PHOTO = "rokid.photo";
    public static final String CAP_DEVICE_CONTROL = "rokid.device_control";
    public static final String CAP_GLASS_ASR = "rokid.glass_asr";
    public static final String CAP_ANDROID_SYSTEM_VOICE = "rokid.android_system_voice";
    public static final String CAP_ROKID_AI_SDK_VOICE = "rokid.ai_sdk_voice";

    private final List<Capability> capabilities = Arrays.asList(
            new Capability(CAP_APP_AUTH, "Rokid App 检测与授权", "auth", true, true, "检测 Rokid AI App / Hi Rokid 并请求眼镜授权。"),
            new Capability(CAP_LINK, "连接层 / CXRLink", "connection", true, true, "验证手机 APK 到眼镜的桥接通道，供 GUI、音频、拍照和设备状态接口复用。"),
            new Capability(CAP_CUSTOM_VIEW, "CustomView", "display", true, true, "打开、更新和关闭 Hello World 级别眼镜端自定义 View。"),
            new Capability(CAP_AUDIO, "音频流", "audio", true, true, "短时接收 PCM 音频并保存 WAV 证据。"),
            new Capability(CAP_PHOTO, "拍照", "camera", true, true, "调用拍照接口并保存 JPEG 证据。"),
            new Capability(CAP_DEVICE_CONTROL, "设备信息与控制", "device", true, true, "读取设备信息并测试亮度、音量设置。"),
            new Capability(CAP_GLASS_ASR, "眼镜端 ASR/TTS", "glass-app", true, true, "安装并启动眼镜端最小应用，验证眼镜原生语音转文本和 TTS。"),
            new Capability(CAP_ANDROID_SYSTEM_VOICE, "Android 系统 ASR/TTS", "system-voice", true, true, "验证 Android 原生 SpeechRecognizer 和 TextToSpeech 是否能通过已连接眼镜输入/输出。"),
            new Capability(CAP_ROKID_AI_SDK_VOICE, "RokidAiSdk ASR/TTS", "rokid-ai-sdk", true, true, "调用 RokidAiSdk 官方 AudioAi service，验证是否能拿到 ASR 文本和发起 TTS 播报。")
    );

    @Override
    public String id() {
        return ID;
    }

    @Override
    public String displayName() {
        return "Rokid 眼镜";
    }

    @Override
    public String summary() {
        return "Rokid 手机侧 SDK 能力探针，保持一个手机 APK 入口，并内置眼镜端测试 APK。";
    }

    @Override
    public List<Capability> capabilities() {
        return capabilities;
    }
}
