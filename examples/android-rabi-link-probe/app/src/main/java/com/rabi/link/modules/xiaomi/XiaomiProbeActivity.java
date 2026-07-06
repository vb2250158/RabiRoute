package com.rabi.link.modules.xiaomi;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.rabi.link.BuildConfig;
import com.rabi.link.bridge.Capability;
import com.rabi.link.bridge.DeviceModule;
import com.rabi.link.bridge.ProbeResultLog;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class XiaomiProbeActivity extends Activity {
    private static final int REQUEST_PERMISSIONS = 1001;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final StringBuilder report = new StringBuilder();
    private final ProbeResultLog resultLog = new ProbeResultLog();
    private MiHealthCloudResultActions miCloudResultActions;
    private XiaomiBleProbeController bleProbeController;

    private LinearLayout deviceList;
    private TextView logView;
    private Button scanButton;
    private Button stopButton;
    private Button copyButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        miCloudResultActions = new MiHealthCloudResultActions(this, this::append);
        bleProbeController = new XiaomiBleProbeController(this, handler, new XiaomiBleProbeController.Listener() {
            @Override
            public void onLog(String message) {
                append(message);
            }

            @Override
            public void onDevicesChanged(List<XiaomiBleProbeController.DeviceEntry> devices) {
                renderDeviceList(devices);
            }

            @Override
            public void onScanningChanged(boolean scanning) {
                setScanning(scanning);
            }
        });
        buildUi();
        append("小米接口测试页已启动。");
        append("版本：" + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")，构建时间：" + BuildConfig.BUILD_TIME);
        append("本页用于测试小米相关接口能拿到什么信息：BLE、Health Connect、小米健康 Provider 和小米云。");
        ensurePermissions();
    }

    @Override
    protected void onDestroy() {
        if (bleProbeController != null) {
            bleProbeController.close();
        }
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(18), dp(16), dp(18), dp(18));
        content.setBackgroundColor(Color.rgb(246, 247, 249));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(246, 247, 249));

        TextView title = new TextView(this);
        title.setText("小米手环接口实验台");
        title.setTextSize(23);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.rgb(24, 28, 34));
        content.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView version = new TextView(this);
        version.setText("按 BLE、Health Connect、小米云和证据导出逐项验证。构建：" + BuildConfig.BUILD_TIME);
        version.setTextSize(13);
        version.setTextColor(Color.rgb(86, 92, 102));
        version.setPadding(0, dp(4), 0, dp(12));
        content.addView(version, new LinearLayout.LayoutParams(-1, -2));

        addSummary(content);
        addSectionTitle(content, "测试矩阵");
        addModuleCapabilityControls(content);

        ScrollView page = new ScrollView(this);
        page.addView(content);
        root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));

        addFixedLogPanel(root);

        setContentView(root);
        setScanning(false);
    }

    private void addFixedLogPanel(LinearLayout root) {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(12), dp(10), dp(12), dp(12));
        panel.setBackground(panelBackground(Color.WHITE, Color.rgb(198, 204, 214)));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("固定日志");
        title.setTextSize(14);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.rgb(32, 38, 46));
        header.addView(title, new LinearLayout.LayoutParams(0, -2, 1));

        copyButton = new Button(this);
        copyButton.setText("复制");
        copyButton.setAllCaps(false);
        copyButton.setOnClickListener(v -> copyReport());
        header.addView(copyButton, new LinearLayout.LayoutParams(dp(96), -2));
        panel.addView(header, new LinearLayout.LayoutParams(-1, -2));

        logView = new TextView(this);
        logView.setTextSize(11);
        logView.setTextColor(Color.rgb(36, 39, 44));
        logView.setPadding(dp(10), dp(8), dp(10), dp(8));
        logView.setMovementMethod(new ScrollingMovementMethod());
        logView.setBackground(panelBackground(Color.rgb(247, 248, 250), Color.rgb(224, 228, 234)));
        ScrollView logScroll = new ScrollView(this);
        logScroll.addView(logView);
        panel.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));
        root.addView(panel, new LinearLayout.LayoutParams(-1, dp(260)));
    }

    private void addSummary(LinearLayout root) {
        TextView summary = new TextView(this);
        summary.setText("当前结论：小米路线仍是证据探针；完整历史心率还没有稳定普通 APK 后台接口。这里主要收集 BLE、Health Connect、小米云和导出证据。");
        summary.setTextSize(13);
        summary.setTextColor(Color.rgb(35, 42, 52));
        summary.setPadding(dp(14), dp(12), dp(14), dp(12));
        summary.setBackground(panelBackground(Color.rgb(236, 244, 255), Color.rgb(180, 204, 240)));
        root.addView(summary, fullWidthWithMargins(0, 0, 0, 14));
    }

    private void addSectionTitle(LinearLayout root, String text) {
        TextView heading = new TextView(this);
        heading.setText(text);
        heading.setTextSize(15);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setTextColor(Color.rgb(42, 47, 55));
        heading.setPadding(0, dp(8), 0, dp(8));
        root.addView(heading, new LinearLayout.LayoutParams(-1, -2));
    }

    private void addModuleCapabilityControls(LinearLayout root) {
        Map<String, Runnable> actions = createCapabilityActions();
        XiaomiDeviceModule module = new XiaomiDeviceModule();

        deviceList = new LinearLayout(this);
        deviceList.setOrientation(LinearLayout.VERTICAL);
        LinearLayout devicePanel = new LinearLayout(this);
        devicePanel.setOrientation(LinearLayout.VERTICAL);
        devicePanel.setPadding(0, dp(8), 0, dp(2));
        devicePanel.addView(text("附近设备会出现在这里；点设备行会连接并读取公开 GATT 信息。", 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));
        ScrollView deviceScroll = new ScrollView(this);
        deviceScroll.addView(deviceList);
        devicePanel.addView(deviceScroll, new LinearLayout.LayoutParams(-1, dp(150)));

        scanButton = capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_BLE_SCAN), actions);
        stopButton = capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_BLE_STOP), actions);
        addCapabilityCard(
                root,
                "01 BLE 近场探针",
                "扫描附近蓝牙设备，连接后尝试读取公开服务、电量和心率服务。",
                "用途：验证手环是否在广播、能否被手机发现，以及是否存在可读 GATT/心率特征。",
                "前置：手机蓝牙打开；Android 12+ 需要蓝牙权限；手环可能需要开启心率广播。",
                "证据：设备名、地址、RSSI、服务 UUID、特征属性和实时心率通知。",
                devicePanel,
                scanButton,
                stopButton
        );
        addCapabilityCard(
                root,
                "02 Health Connect",
                "读取 Android Health Connect 内的心率、睡眠和步数。",
                "用途：如果小米健康已同步到 Health Connect，这条路线比反编译 Provider 更干净。",
                "前置：安装 Health Connect，并给本 APK 授权读取健康数据。",
                "证据：记录条数、时间范围、心率样本、睡眠合计和步数合计。",
                null,
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_HEALTH_CONNECT), actions)
        );
        addCapabilityCard(
                root,
                "03 小米云",
                "走小米账号授权后拉取云端心率列表，并可做全类型深扫。",
                "用途：确认云端是否能拿到历史健康数据；目前这条是最有希望的完整列表路线。",
                "前置：完成授权并保存 access token；网络可用。",
                "证据：HTTP 摘要、心率列表、data type 深扫结果和原始响应文件。",
                null,
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_AUTH), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_LIST), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_FULL_SCAN), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_RESULT), actions)
        );
        addCapabilityCard(
                root,
                "04 证据导出",
                "把最近一次小米云探针结果复制、分享或保存成文件。",
                "用途：把手机侧证据带回电脑分析，避免每次都靠截图和手抄日志。",
                "前置：至少跑过一次小米云心率列表或全类型深扫。",
                "证据：Markdown、JSON、raw HTTP 响应和 ZIP 证据包。",
                null,
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_COPY_MD), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_SHARE_MD), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_SHARE_JSON), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_SHARE_ZIP), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_SAVE_FILES), actions),
                capabilityButton(module, findCapability(module, XiaomiDeviceModule.CAP_CLOUD_SAVE_ZIP), actions)
        );
    }

    private Capability findCapability(DeviceModule module, String id) {
        for (Capability capability : module.capabilities()) {
            if (capability.id().equals(id)) {
                return capability;
            }
        }
        throw new IllegalArgumentException("Unknown capability " + id);
    }

    private Button capabilityButton(DeviceModule module, Capability capability, Map<String, Runnable> actions) {
        Button button = new Button(this);
        button.setText(capability.displayName());
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        Runnable action = actions.get(capability.id());
        button.setOnClickListener(action == null
                ? missingCapabilityAction(module, capability)
                : capabilityAction(module.id(), capability, action));
        return button;
    }

    private void addCapabilityCard(
            LinearLayout root,
            String title,
            String summary,
            String useCase,
            String prerequisite,
            String evidence,
            View extraContent,
            Button... buttons
    ) {
        LinearLayout block = new LinearLayout(this);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setPadding(dp(14), dp(12), dp(14), dp(12));
        block.setBackground(panelBackground(Color.WHITE, Color.rgb(218, 222, 228)));

        TextView titleView = text(title, 16, Color.rgb(22, 28, 36));
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        block.addView(titleView, new LinearLayout.LayoutParams(-1, -2));

        TextView summaryView = text(summary, 13, Color.rgb(70, 77, 88));
        summaryView.setPadding(0, dp(4), 0, dp(6));
        block.addView(summaryView, new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(useCase, 12, Color.rgb(58, 76, 102)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(prerequisite, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));
        block.addView(text(evidence, 12, Color.rgb(92, 98, 108)), new LinearLayout.LayoutParams(-1, -2));
        if (extraContent != null) {
            block.addView(extraContent, fullWidthWithMargins(0, 0, 0, 8));
        }
        for (Button button : buttons) {
            block.addView(button, fullWidthWithMargins(0, 0, 0, 6));
        }
        root.addView(block, fullWidthWithMargins(0, 0, 0, 12));
    }

    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private LinearLayout.LayoutParams fullWidthWithMargins(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private GradientDrawable panelBackground(int color, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setStroke(1, stroke);
        drawable.setCornerRadius(dp(8));
        return drawable;
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private Map<String, Runnable> createCapabilityActions() {
        Map<String, Runnable> actions = new HashMap<>();
        actions.put(XiaomiDeviceModule.CAP_BLE_SCAN, this::startScan);
        actions.put(XiaomiDeviceModule.CAP_BLE_STOP, this::stopScan);
        actions.put(XiaomiDeviceModule.CAP_HEALTH_CONNECT, () -> startActivity(new Intent(this, HealthConnectActivity.class)));
        actions.put(XiaomiDeviceModule.CAP_CLOUD_AUTH, () -> startActivity(new Intent(this, MiHealthOAuthActivity.class)));
        actions.put(XiaomiDeviceModule.CAP_CLOUD_LIST, this::triggerMiCloudHeartRateList);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_FULL_SCAN, this::triggerMiCloudFullScan);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_RESULT, miCloudResultActions::showLastResult);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_COPY_MD, miCloudResultActions::copyLastMarkdown);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_SHARE_MD, miCloudResultActions::shareLastMarkdown);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_SHARE_JSON, miCloudResultActions::shareLastJson);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_SHARE_ZIP, miCloudResultActions::shareLastZip);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_SAVE_FILES, miCloudResultActions::saveLastFilesToDownloads);
        actions.put(XiaomiDeviceModule.CAP_CLOUD_SAVE_ZIP, miCloudResultActions::saveLastZipToDownloads);
        return actions;
    }

    private View.OnClickListener missingCapabilityAction(DeviceModule module, Capability capability) {
        return v -> {
            String summary = capability.displayName() + " 尚未接入：" + capability.description();
            append(summary + " (" + capability.id() + ")");
            recordResult(module.id(), capability.id(), "missing", summary, "", "");
        };
    }

    private View.OnClickListener capabilityAction(String moduleId, Capability capability, Runnable action) {
        return v -> {
            String summary = capability.displayName() + "：" + capability.description();
            try {
                action.run();
                recordResult(moduleId, capability.id(), "dispatched", summary, "", "");
            } catch (Throwable error) {
                String message = error.getClass().getSimpleName() + ": " + error.getMessage();
                recordResult(moduleId, capability.id(), "failed", summary, "", message);
                append("能力执行失败：" + message);
            }
        };
    }

    private void recordResult(String moduleId, String capabilityId, String status, String summary, String evidencePath, String error) {
        resultLog.record(moduleId, capabilityId, status, summary, evidencePath, error);
        append(resultLog.formatLastLine());
    }

    private String formatModule(DeviceModule module) {
        StringBuilder builder = new StringBuilder();
        builder.append(module.displayName()).append("：").append(module.summary());
        builder.append("\n能力：");
        List<Capability> capabilities = module.capabilities();
        for (int i = 0; i < capabilities.size(); i++) {
            if (i > 0) {
                builder.append(" / ");
            }
            builder.append(capabilities.get(i).displayName());
        }
        return builder.toString();
    }

    private void ensurePermissions() {
        List<String> permissions = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            permissions.add(Manifest.permission.BLUETOOTH_SCAN);
            permissions.add(Manifest.permission.BLUETOOTH_CONNECT);
        } else {
            permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }

        List<String> missing = new ArrayList<>();
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        if (!missing.isEmpty()) {
            requestPermissions(missing.toArray(new String[0]), REQUEST_PERMISSIONS);
        }
    }

    private void triggerMiCloudHeartRateList() {
        MiHealthCloudProbeIntents.ProbeRequest request = MiHealthCloudProbeIntents.heartRateList(this);
        startMiCloudProbeService(request.intent);
        append(request.logMessage);
    }

    private void triggerMiCloudFullScan() {
        MiHealthCloudProbeIntents.ProbeRequest request = MiHealthCloudProbeIntents.fullScan(this);
        startMiCloudProbeService(request.intent);
        append(request.logMessage);
    }

    private void startMiCloudProbeService(Intent intent) {
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void startScan() {
        ensurePermissions();
        bleProbeController.startScan();
    }

    private void stopScan() {
        bleProbeController.stopScan();
    }

    private void setScanning(boolean value) {
        if (scanButton != null) {
            scanButton.setEnabled(!value);
        }
        if (stopButton != null) {
            stopButton.setEnabled(value);
        }
    }

    private void renderDeviceList(List<XiaomiBleProbeController.DeviceEntry> devices) {
        deviceList.removeAllViews();
        for (XiaomiBleProbeController.DeviceEntry device : devices) {
            Button row = new Button(this);
            row.setAllCaps(false);
            row.setText(device.name + "\n" + device.address + " 信号 " + device.rssi + device.signalLabel);
            row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
            row.setOnClickListener(v -> bleProbeController.connect(device.address));
            deviceList.addView(row, new LinearLayout.LayoutParams(-1, -2));
        }
    }

    private void append(String message) {
        String time = new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date());
        String line = "[" + time + "] " + message + "\n";
        report.append(line);
        handler.post(() -> {
            logView.append(line);
            int scrollAmount = logView.getLayout() == null ? 0 : logView.getLayout().getLineTop(logView.getLineCount()) - logView.getHeight();
            if (scrollAmount > 0) {
                logView.scrollTo(0, scrollAmount);
            }
        });
    }

    private void copyReport() {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Rabi Link 设备探针日志", report.toString()));
            Toast.makeText(this, "日志已复制", Toast.LENGTH_SHORT).show();
        }
    }
}
