package com.rabi.link.modules.xiaomi;

import com.rabi.link.bridge.Capability;
import com.rabi.link.bridge.DeviceModule;

import java.util.Arrays;
import java.util.List;

public final class XiaomiDeviceModule implements DeviceModule {
    public static final String ID = "xiaomi";
    public static final String CAP_BLE_SCAN = "xiaomi.ble.scan";
    public static final String CAP_BLE_STOP = "xiaomi.ble.stop";
    public static final String CAP_HEALTH_CONNECT = "xiaomi.health_connect.read";
    public static final String CAP_CLOUD_AUTH = "xiaomi.cloud.auth";
    public static final String CAP_CLOUD_LIST = "xiaomi.cloud.heart_rate_list";
    public static final String CAP_CLOUD_FULL_SCAN = "xiaomi.cloud.full_scan";
    public static final String CAP_CLOUD_RESULT = "xiaomi.cloud.last_result";
    public static final String CAP_CLOUD_COPY_MD = "xiaomi.cloud.copy_markdown";
    public static final String CAP_CLOUD_SHARE_MD = "xiaomi.cloud.share_markdown";
    public static final String CAP_CLOUD_SHARE_JSON = "xiaomi.cloud.share_json";
    public static final String CAP_CLOUD_SHARE_ZIP = "xiaomi.cloud.share_zip";
    public static final String CAP_CLOUD_SAVE_FILES = "xiaomi.cloud.save_files";
    public static final String CAP_CLOUD_SAVE_ZIP = "xiaomi.cloud.save_zip";

    private final List<Capability> capabilities = Arrays.asList(
            new Capability(CAP_BLE_SCAN, "BLE 扫描", "bluetooth", true, false, "扫描广播、设备信息、电量和心率服务。"),
            new Capability(CAP_BLE_STOP, "停止扫描", "bluetooth", true, false, "停止当前 BLE 扫描。"),
            new Capability(CAP_HEALTH_CONNECT, "Health Connect", "health", true, true, "读取 Android Health Connect 心率、睡眠和步数。"),
            new Capability(CAP_CLOUD_AUTH, "小米云授权", "cloud", true, true, "打开小米账号授权页并保存 access token。"),
            new Capability(CAP_CLOUD_LIST, "拉取心率列表", "cloud", true, true, "使用已保存 token 拉取心率列表并保存诊断。"),
            new Capability(CAP_CLOUD_FULL_SCAN, "全类型深扫", "cloud", true, true, "扫描 SDK 暴露的全部 data type。"),
            new Capability(CAP_CLOUD_RESULT, "查看云结果", "cloud", false, false, "显示最近一次小米云探针结果摘要。"),
            new Capability(CAP_CLOUD_COPY_MD, "复制云MD", "export", false, false, "复制最近一次 Markdown 结果。"),
            new Capability(CAP_CLOUD_SHARE_MD, "分享云MD", "export", true, false, "通过系统分享 Markdown 结果。"),
            new Capability(CAP_CLOUD_SHARE_JSON, "分享云JSON", "export", true, false, "通过系统分享 JSON 结果。"),
            new Capability(CAP_CLOUD_SHARE_ZIP, "分享云ZIP", "export", true, false, "通过系统分享 ZIP 证据包。"),
            new Capability(CAP_CLOUD_SAVE_FILES, "保存云文件", "export", true, false, "保存 Markdown、JSON 和 raw HTTP 响应。"),
            new Capability(CAP_CLOUD_SAVE_ZIP, "保存云ZIP", "export", true, false, "保存最近一次 ZIP 证据包。")
    );

    @Override
    public String id() {
        return ID;
    }

    @Override
    public String displayName() {
        return "小米手环 / 小米运动健康";
    }

    @Override
    public String summary() {
        return "BLE、Health Connect、小米运动健康 Provider 和小米健康云能力探针。";
    }

    @Override
    public List<Capability> capabilities() {
        return capabilities;
    }
}
