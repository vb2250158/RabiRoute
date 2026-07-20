package com.rabi.link.modules.rokid;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

final class RokidProbeEnvironment {
    private RokidProbeEnvironment() {
    }

    static List<String> inspect(Activity activity, String tokenSummary, boolean cxrConnected, boolean glassBtConnected, Object sessionState) {
        List<String> lines = new ArrayList<>();
        lines.add("");
        lines.add("== Rokid 环境检查 ==");
        lines.add("时间：" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date()));
        lines.add(permissionLine(activity, "RECORD_AUDIO", Manifest.permission.RECORD_AUDIO));
        lines.add(permissionLine(activity, "CAMERA", Manifest.permission.CAMERA));
        lines.add(permissionLine(activity, "ACCESS_FINE_LOCATION", Manifest.permission.ACCESS_FINE_LOCATION));
        lines.add(permissionLine(activity, "ACCESS_COARSE_LOCATION", Manifest.permission.ACCESS_COARSE_LOCATION));
        lines.add(permissionLine(activity, "BLUETOOTH_CONNECT", Manifest.permission.BLUETOOTH_CONNECT));
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            lines.add(permissionLine(activity, "NEARBY_WIFI_DEVICES", Manifest.permission.NEARBY_WIFI_DEVICES));
        }
        lines.add(packageLine(activity, "Rokid AI App", "com.rokid.sprite.aiapp"));
        lines.add(packageLine(activity, "Hi Rokid 候选", "com.rokid.ai.glass"));
        lines.add(classLine("CXRLink", "com.rokid.cxr.link.CXRLink"));
        lines.add(classLine("Phone SDK", "com.rokid.security.phone.sdk.api.PSecuritySDK"));
        lines.add(classLine("Phone SDK ASR Engine", "com.rokid.security.phone.core.ability.asr.AsrEngine"));
        lines.add(classLine("Phone SDK ASR Client", "com.rokid.security.phone.core.ability.asr.AsrConnectClient"));
        lines.add(classLine("Phone SDK TTS Engine", "com.rokid.security.phone.core.ability.tts.TtsEngine"));
        lines.add(classLine("Phone SDK TTS Client", "com.rokid.security.phone.core.ability.tts.TtsConnectClient"));
        lines.add(classLine("Phone SDK BaseConfig", "com.rokid.security.phone.core.ability.bean.BaseConfig"));
        lines.add(classLine("Phone SDK UrlConfig", "com.rokid.security.phone.sdk.server.UrlConfig"));
        lines.add(classLine("Phone SDK SecuritySDKEnv", "com.rokid.security.phone.sdk.base.utils.net.SecuritySDKEnv"));
        lines.add(classLine("AuthorizationHelper", "com.rokid.sprite.aiapp.externalapp.auth.AuthorizationHelper"));
        lines.add(classLine("GlassPermission", "com.rokid.sprite.aiapp.externalapp.auth.GlassPermission"));
        lines.add("官方前置条件：手机端 CXR-L client-l:1.1.0，minSdk 31，Rokid AI App 大陆版 >= 1.9.0 或 Hi Rokid 海外版。");
        lines.add("当前状态：token=" + tokenSummary + " cxrConnected=" + cxrConnected + " glassBtConnected=" + glassBtConnected + " session=" + sessionState);
        return lines;
    }

    private static String permissionLine(Activity activity, String label, String permission) {
        boolean granted = activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
        return "权限 " + label + "：" + (granted ? "已授权" : "未授权");
    }

    private static String packageLine(Activity activity, String label, String packageName) {
        PackageManager packageManager = activity.getPackageManager();
        try {
            PackageInfo info = packageManager.getPackageInfo(packageName, 0);
            return label + "：" + packageName + " 已安装，versionName=" + info.versionName + "，versionCode=" + info.getLongVersionCode();
        } catch (PackageManager.NameNotFoundException error) {
            return label + "：" + packageName + " 未安装或包名不匹配";
        }
    }

    private static String classLine(String label, String className) {
        try {
            Class<?> klass = Class.forName(className);
            return "SDK 类 " + label + "：" + klass.getName() + " 可加载";
        } catch (Throwable error) {
            return "SDK 类 " + label + "：" + className + " 不可加载（" + error.getClass().getSimpleName() + "）";
        }
    }
}
