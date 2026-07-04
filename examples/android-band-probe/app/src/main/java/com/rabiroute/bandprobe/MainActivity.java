package com.rabiroute.bandprobe;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.method.ScrollingMovementMethod;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Queue;
import java.util.Set;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

public class MainActivity extends Activity {
    private static final int REQUEST_PERMISSIONS = 1001;
    private static final UUID DEVICE_INFORMATION_SERVICE = uuid16(0x180A);
    private static final UUID BATTERY_SERVICE = uuid16(0x180F);
    private static final UUID HEART_RATE_SERVICE = uuid16(0x180D);
    private static final UUID HEART_RATE_MEASUREMENT = uuid16(0x2A37);
    private static final UUID CLIENT_CHARACTERISTIC_CONFIG = uuid16(0x2902);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<String, ScanResult> scanResults = new HashMap<>();
    private final Queue<BluetoothGattCharacteristic> readQueue = new ArrayDeque<>();
    private final StringBuilder report = new StringBuilder();

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private LinearLayout deviceList;
    private TextView logView;
    private Button scanButton;
    private Button stopButton;
    private Button copyButton;
    private Button healthButton;
    private Button miCloudAuthButton;
    private Button miCloudListButton;
    private Button miCloudFullScanButton;
    private Button miCloudResultButton;
    private Button miCloudMarkdownButton;
    private Button miCloudShareMarkdownButton;
    private Button miCloudShareJsonButton;
    private Button miCloudShareZipButton;
    private Button miCloudSaveFilesButton;
    private Button miCloudSaveZipButton;
    private boolean scanning;

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String address = safeAddress(device);
            if (address == null) {
                return;
            }
            scanResults.put(address, result);
            renderDeviceList();
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult result : results) {
                BluetoothDevice device = result.getDevice();
                String address = safeAddress(device);
                if (address != null) {
                    scanResults.put(address, result);
                }
            }
            renderDeviceList();
        }

        @Override
        public void onScanFailed(int errorCode) {
            append("扫描失败：" + errorCode);
            setScanning(false);
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt bluetoothGatt, int status, int newState) {
            append("GATT 状态变化：status=" + status + "，state=" + newState);
            if (newState == android.bluetooth.BluetoothProfile.STATE_CONNECTED) {
                append("已连接，正在发现 GATT 服务...");
                bluetoothGatt.discoverServices();
            } else if (newState == android.bluetooth.BluetoothProfile.STATE_DISCONNECTED) {
                append("已断开连接。");
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt bluetoothGatt, int status) {
            append("服务发现完成：status=" + status);
            if (status != BluetoothGatt.GATT_SUCCESS) {
                return;
            }
            inspectServices(bluetoothGatt);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt bluetoothGatt, BluetoothGattCharacteristic characteristic, int status) {
            append("读取 " + shortUuid(characteristic.getUuid()) + "：status=" + status + "，值=" + decodeValue(characteristic));
            handler.postDelayed(() -> readNext(), 150);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt bluetoothGatt, BluetoothGattCharacteristic characteristic) {
            if (HEART_RATE_MEASUREMENT.equals(characteristic.getUuid())) {
                append("实时心率：" + parseHeartRate(characteristic.getValue()) + " bpm，原始数据=" + bytesToHex(characteristic.getValue()));
            } else {
                append("收到通知 " + shortUuid(characteristic.getUuid()) + "：" + bytesToHex(characteristic.getValue()));
            }
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt bluetoothGatt, BluetoothGattDescriptor descriptor, int status) {
            append("写入描述符 " + shortUuid(descriptor.getUuid()) + "：status=" + status);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        BluetoothManager manager = (BluetoothManager) getSystemService(BLUETOOTH_SERVICE);
        bluetoothAdapter = manager == null ? null : manager.getAdapter();
        if (bluetoothAdapter != null) {
            scanner = bluetoothAdapter.getBluetoothLeScanner();
        }
        buildUi();
        append("Rabi 手环探针已启动。");
        append("版本：" + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")，构建时间：" + BuildConfig.BUILD_TIME);
        append("本工具只探测公开 BLE 数据：广播、设备信息、电量、心率服务。");
        ensurePermissions();
    }

    @Override
    protected void onDestroy() {
        stopScan();
        if (gatt != null) {
            gatt.close();
            gatt = null;
        }
        super.onDestroy();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(24, 24, 24, 24);

        TextView title = new TextView(this);
        title.setText("Rabi 手环探针 v" + BuildConfig.VERSION_NAME);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView version = new TextView(this);
        version.setText("构建：" + BuildConfig.BUILD_TIME);
        version.setTextSize(12);
        root.addView(version, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        scanButton = new Button(this);
        scanButton.setText("扫描");
        scanButton.setOnClickListener(v -> startScan());
        stopButton = new Button(this);
        stopButton.setText("停止");
        stopButton.setOnClickListener(v -> stopScan());
        copyButton = new Button(this);
        copyButton.setText("复制日志");
        copyButton.setOnClickListener(v -> copyReport());
        healthButton = new Button(this);
        healthButton.setText("读取健康心率");
        healthButton.setOnClickListener(v -> startActivity(new Intent(this, HealthConnectActivity.class)));
        miCloudAuthButton = new Button(this);
        miCloudAuthButton.setText("小米云授权");
        miCloudAuthButton.setOnClickListener(v -> startActivity(new Intent(this, MiHealthOAuthActivity.class)));
        miCloudListButton = new Button(this);
        miCloudListButton.setText("拉取心率列表");
        miCloudListButton.setOnClickListener(v -> triggerMiCloudHeartRateList());
        miCloudFullScanButton = new Button(this);
        miCloudFullScanButton.setText("全类型深扫");
        miCloudFullScanButton.setOnClickListener(v -> triggerMiCloudFullScan());
        miCloudResultButton = new Button(this);
        miCloudResultButton.setText("查看云结果");
        miCloudResultButton.setOnClickListener(v -> showLastMiCloudResult());
        miCloudMarkdownButton = new Button(this);
        miCloudMarkdownButton.setText("复制云MD");
        miCloudMarkdownButton.setOnClickListener(v -> copyLastMiCloudMarkdown());
        miCloudShareMarkdownButton = new Button(this);
        miCloudShareMarkdownButton.setText("分享云MD");
        miCloudShareMarkdownButton.setOnClickListener(v -> shareLastMiCloudText("last_probe_markdown", "小米健康云心率列表.md", "text/markdown"));
        miCloudShareJsonButton = new Button(this);
        miCloudShareJsonButton.setText("分享云JSON");
        miCloudShareJsonButton.setOnClickListener(v -> shareLastMiCloudText("last_probe_json", "小米健康云心率列表.json", "application/json"));
        miCloudShareZipButton = new Button(this);
        miCloudShareZipButton.setText("分享云ZIP");
        miCloudShareZipButton.setOnClickListener(v -> shareLastMiCloudZip());
        miCloudSaveFilesButton = new Button(this);
        miCloudSaveFilesButton.setText("保存云文件");
        miCloudSaveFilesButton.setOnClickListener(v -> saveLastMiCloudFilesToDownloads());
        miCloudSaveZipButton = new Button(this);
        miCloudSaveZipButton.setText("保存云ZIP");
        miCloudSaveZipButton.setOnClickListener(v -> saveLastMiCloudZipToDownloads());
        buttons.addView(scanButton, new LinearLayout.LayoutParams(0, -2, 1));
        buttons.addView(stopButton, new LinearLayout.LayoutParams(0, -2, 1));
        buttons.addView(copyButton, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(buttons, new LinearLayout.LayoutParams(-1, -2));
        root.addView(healthButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudAuthButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudListButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudFullScanButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudResultButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudMarkdownButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudShareMarkdownButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudShareJsonButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudShareZipButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudSaveFilesButton, new LinearLayout.LayoutParams(-1, -2));
        root.addView(miCloudSaveZipButton, new LinearLayout.LayoutParams(-1, -2));

        TextView hint = new TextView(this);
        hint.setText("提示：全天心率列表走“小米云授权 -> 拉取心率列表”；BLE 实时心率只用于验证广播能力。");
        hint.setTextSize(13);
        root.addView(hint, new LinearLayout.LayoutParams(-1, -2));

        deviceList = new LinearLayout(this);
        deviceList.setOrientation(LinearLayout.VERTICAL);
        ScrollView deviceScroll = new ScrollView(this);
        deviceScroll.addView(deviceList);
        root.addView(deviceScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        logView = new TextView(this);
        logView.setTextSize(12);
        logView.setMovementMethod(new ScrollingMovementMethod());
        ScrollView logScroll = new ScrollView(this);
        logScroll.addView(logView);
        root.addView(logScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        setContentView(root);
        setScanning(false);
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
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String dataTypes = prefs.getString("data_types", "com.xiaomi.micloud.fit.heart_rate.bpm,com.xiaomi.micloud.fit.heart_rate.summary");
        long hours = prefs.getLong("hours", 24L);
        long sliceHours = prefs.getLong("slice_hours", 0L);
        int limit = prefs.getInt("limit", 500);
        int maxPages = prefs.getInt("max_pages", 20);
        startMiCloudProbeService(new Intent(this, MiHealthCloudProbeService.class)
                .putExtra("data_types", dataTypes)
                .putExtra("hours", hours)
                .putExtra("slice_hours", sliceHours)
                .putExtra("limit", limit)
                .putExtra("max_pages", maxPages)
                .putExtra("auto_save_zip", true));
        append("已触发小米健康云心率列表拉取：" + dataTypes + "，最近 " + hours + " 小时，分片 " + sliceHours + " 小时，每页 " + limit + " 条，最多 " + maxPages + " 页。完成后会自动保存 ZIP 到下载目录。");
    }

    private void triggerMiCloudFullScan() {
        long hours = 168L;
        long sliceHours = 24L;
        int limit = 1000;
        int maxPages = 50;
        getSharedPreferences("mi_health_cloud", MODE_PRIVATE).edit()
                .putString("data_types", "__all_sdk__")
                .putLong("hours", hours)
                .putLong("slice_hours", sliceHours)
                .putInt("limit", limit)
                .putInt("max_pages", maxPages)
                .apply();
        startMiCloudProbeService(new Intent(this, MiHealthCloudProbeService.class)
                .putExtra("data_types", "__all_sdk__")
                .putExtra("hours", hours)
                .putExtra("slice_hours", sliceHours)
                .putExtra("limit", limit)
                .putExtra("max_pages", maxPages)
                .putExtra("auto_save_zip", true));
        append("已触发小米健康云全类型深扫：SDK 全部 data type，最近 168 小时，按 24 小时分片，每页 1000 条，最多 50 页。完成后会自动保存 ZIP 到下载目录。");
    }

    private void startMiCloudProbeService(Intent intent) {
        if (Build.VERSION.SDK_INT >= 26) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void showLastMiCloudResult() {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String log = prefs.getString("last_probe_log", "");
        String json = prefs.getString("last_probe_json", "");
        String jsonPath = prefs.getString("last_probe_json_path", "");
        String markdown = prefs.getString("last_probe_markdown", "");
        String markdownPath = prefs.getString("last_probe_markdown_path", "");
        String zipUri = prefs.getString("last_probe_zip_uri", "");
        long timestamp = prefs.getLong("last_probe_at", 0L);
        append("");
        append("最近一次小米云心率列表结果：");
        if (timestamp > 0L) {
            append("保存时间戳：" + timestamp);
        }
        if (jsonPath != null && !jsonPath.trim().isEmpty()) {
            append("JSON 文件：" + jsonPath);
        }
        if (json != null && !json.trim().isEmpty()) {
            append("JSON 字节数：" + json.getBytes(StandardCharsets.UTF_8).length);
        }
        if (markdownPath != null && !markdownPath.trim().isEmpty()) {
            append("Markdown 文件：" + markdownPath);
        }
        if (markdown != null && !markdown.trim().isEmpty()) {
            append("Markdown 字节数：" + markdown.getBytes(StandardCharsets.UTF_8).length);
        }
        if (zipUri != null && !zipUri.trim().isEmpty()) {
            append("自动保存 ZIP：" + zipUri);
        }
        appendMiCloudJsonSummary(json);
        if (log == null || log.trim().isEmpty()) {
            append("暂无云端拉取结果。请先完成小米云授权，再点“拉取心率列表”。");
        } else {
            append(log.trim());
        }
    }

    private void appendMiCloudJsonSummary(String jsonText) {
        if (jsonText == null || jsonText.trim().isEmpty()) {
            return;
        }
        try {
            JSONObject root = new JSONObject(jsonText);
            JSONArray points = root.optJSONArray("points");
            if (points == null) {
                append("云端 JSON 摘要：没有 points 数组。");
                return;
            }
            append("云端状态：" + root.optString("status", "<未知>"));
            JSONArray dataSources = root.optJSONArray("dataSources");
            JSONArray pages = root.optJSONArray("pages");
            JSONArray rawHttp = root.optJSONArray("rawHttp");
            JSONArray errors = root.optJSONArray("errors");
            append("云端诊断汇总：dataSources=" + lengthOf(dataSources)
                    + " pages=" + lengthOf(pages)
                    + " rawHttp=" + lengthOf(rawHttp)
                    + " errors=" + lengthOf(errors));
            appendMiCloudDataSourceDiagnostics(dataSources);
            appendMiCloudPageDiagnostics(pages);
            appendMiCloudRawHttpDiagnostics(rawHttp);
            appendMiCloudErrors(errors);
            Map<String, Integer> counts = new HashMap<>();
            long firstNs = Long.MAX_VALUE;
            long lastNs = Long.MIN_VALUE;
            double min = Double.MAX_VALUE;
            double max = -Double.MAX_VALUE;
            double sum = 0.0;
            int valueCount = 0;
            Set<String> uniqueKeys = new HashSet<>();

            for (int i = 0; i < points.length(); i++) {
                JSONObject point = points.optJSONObject(i);
                if (point == null) {
                    continue;
                }
                String dataType = point.optString("dataType", "<unknown>");
                counts.put(dataType, counts.containsKey(dataType) ? counts.get(dataType) + 1 : 1);
                uniqueKeys.add(point.optString("uniqueKey", dataType + "|" + point.optString("sourceId") + "|" + point.optLong("startTimeNanos") + "|" + point.optLong("endTimeNanos") + "|" + point.optJSONArray("value")));
                long startNs = point.optLong("startTimeNanos", -1L);
                if (startNs > 0L) {
                    firstNs = Math.min(firstNs, startNs);
                    lastNs = Math.max(lastNs, startNs);
                }
                Double value = extractNumericValue(point.optJSONArray("value"));
                if (value != null) {
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                    sum += value;
                    valueCount += 1;
                }
            }

            append("云端 JSON 摘要：points=" + points.length());
            append("去重后样本数：" + uniqueKeys.size() + "，疑似重复：" + (points.length() - uniqueKeys.size()));
            if (firstNs != Long.MAX_VALUE) {
                append("时间范围：" + formatNanos(firstNs) + " ~ " + formatNanos(lastNs));
            }
            for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                append("类型计数：" + entry.getKey() + " = " + entry.getValue());
            }
            if (valueCount > 0) {
                append(String.format(Locale.US, "数值统计：count=%d min=%.1f max=%.1f avg=%.1f", valueCount, min, max, sum / valueCount));
            }
        } catch (Exception error) {
            append("云端 JSON 摘要解析失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private int lengthOf(JSONArray array) {
        return array == null ? 0 : array.length();
    }

    private void appendMiCloudDataSourceDiagnostics(JSONArray dataSources) {
        if (dataSources == null || dataSources.length() == 0) {
            append("数据源诊断：无记录");
            return;
        }
        for (int i = 0; i < dataSources.length(); i++) {
            JSONObject item = dataSources.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("数据源诊断：" + item.optString("dataType", "<unknown>")
                    + " success=" + item.optBoolean("success")
                    + " response=" + item.optInt("responseCode")
                    + " count=" + item.optInt("sourceCount")
                    + " desc=" + item.optString("desc", ""));
        }
    }

    private void appendMiCloudErrors(JSONArray errors) {
        if (errors == null || errors.length() == 0) {
            return;
        }
        for (int i = 0; i < errors.length(); i++) {
            JSONObject item = errors.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("云端错误：" + item.optString("stage")
                    + " " + item.optString("dataType")
                    + " " + item.optString("type")
                    + ": " + item.optString("message"));
        }
    }

    private void appendMiCloudPageDiagnostics(JSONArray pages) {
        if (pages == null || pages.length() == 0) {
            return;
        }
        for (int i = 0; i < pages.length(); i++) {
            JSONObject item = pages.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("分页诊断：" + item.optString("dataType", "<unknown>")
                    + " page=" + item.optInt("page")
                    + " count=" + item.optInt("pointCount")
                    + " next=" + item.optBoolean("hasNextPageToken"));
        }
    }

    private void appendMiCloudRawHttpDiagnostics(JSONArray rawHttp) {
        if (rawHttp == null || rawHttp.length() == 0) {
            return;
        }
        for (int i = 0; i < rawHttp.length(); i++) {
            JSONObject item = rawHttp.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("原始HTTP：" + item.optString("stage")
                    + " " + item.optString("dataType")
                    + " http=" + item.optInt("httpCode")
                    + " bytes=" + item.optInt("responseLength"));
        }
    }

    private Double extractNumericValue(JSONArray valueArray) {
        if (valueArray == null || valueArray.length() == 0) {
            return null;
        }
        JSONObject first = valueArray.optJSONObject(0);
        if (first == null) {
            return null;
        }
        if (first.has("fpVal")) {
            return first.optDouble("fpVal");
        }
        if (first.has("intVal")) {
            return (double) first.optInt("intVal");
        }
        if (first.has("value")) {
            return first.optDouble("value");
        }
        return null;
    }

    private String formatNanos(long nanos) {
        long millis = nanos / 1000000L;
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date(millis));
    }

    private void copyLastMiCloudMarkdown() {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String markdown = prefs.getString("last_probe_markdown", "");
        if (markdown == null || markdown.trim().isEmpty()) {
            append("暂无可复制的云端 Markdown。请先拉取心率列表。");
            return;
        }
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("小米健康云心率列表", markdown));
            Toast.makeText(this, "云端心率 Markdown 已复制", Toast.LENGTH_SHORT).show();
        }
    }

    private void shareLastMiCloudText(String prefsKey, String title, String mimeType) {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String text = prefs.getString(prefsKey, "");
        if (text == null || text.trim().isEmpty()) {
            append("暂无可分享的云端结果。请先拉取心率列表。");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mimeType);
        send.putExtra(Intent.EXTRA_TITLE, title);
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.putExtra(Intent.EXTRA_TEXT, text);
        startActivity(Intent.createChooser(send, "分享" + title));
    }

    private void shareLastMiCloudZip() {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String zipUriText = prefs.getString("last_probe_zip_uri", "");
        if (zipUriText == null || zipUriText.trim().isEmpty()) {
            append("暂无可分享的云端 ZIP。请先拉取心率列表或点“保存云ZIP”。");
            return;
        }
        try {
            Uri zipUri = Uri.parse(zipUriText);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/zip");
            send.putExtra(Intent.EXTRA_TITLE, "小米健康云心率列表.zip");
            send.putExtra(Intent.EXTRA_SUBJECT, "小米健康云心率列表.zip");
            send.putExtra(Intent.EXTRA_STREAM, zipUri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, "分享小米健康云 ZIP"));
        } catch (Exception error) {
            append("分享云端 ZIP 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void saveLastMiCloudFilesToDownloads() {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String markdown = prefs.getString("last_probe_markdown", "");
        String json = prefs.getString("last_probe_json", "");
        if ((markdown == null || markdown.trim().isEmpty()) && (json == null || json.trim().isEmpty())) {
            append("暂无可保存的云端结果。请先拉取心率列表。");
            return;
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        try {
            if (Build.VERSION.SDK_INT < 29) {
                append("当前 Android 版本不支持免权限写入下载目录，请使用“分享云MD/JSON”或“复制云MD”。");
                return;
            }
            if (markdown != null && !markdown.trim().isEmpty()) {
                Uri uri = saveTextToDownloads("mi-health-heart-rate-" + stamp + ".md", "text/markdown", markdown);
                append("Markdown 已保存：" + uri);
            }
            if (json != null && !json.trim().isEmpty()) {
                Uri uri = saveTextToDownloads("mi-health-heart-rate-" + stamp + ".json", "application/json", json);
                append("JSON 已保存：" + uri);
            }
            saveRawMiCloudFilesToDownloads(stamp);
            Toast.makeText(this, "云端结果已保存到下载目录", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            append("保存云端文件失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private Uri saveTextToDownloads(String fileName, String mimeType, String text) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/RabiRouteBandProbe");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        try (OutputStream stream = getContentResolver().openOutputStream(uri)) {
            if (stream == null) {
                throw new IllegalStateException("无法打开输出流");
            }
            stream.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return uri;
    }

    private void saveRawMiCloudFilesToDownloads(String stamp) throws Exception {
        File dir = new File(getFilesDir(), "mi-health-cloud-raw");
        File[] files = dir.listFiles();
        if (files == null || files.length == 0) {
            append("没有 raw HTTP 文件需要保存。");
            return;
        }
        int saved = 0;
        for (File file : files) {
            if (!file.isFile()) {
                continue;
            }
            Uri uri = saveFileToDownloads("raw-" + stamp + "-" + file.getName(), "application/json", file);
            saved += 1;
            append("raw HTTP 已保存：" + uri);
        }
        append("raw HTTP 文件数量：" + saved);
    }

    private Uri saveFileToDownloads(String fileName, String mimeType, File source) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeType);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/RabiRouteBandProbe/raw");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        try (InputStream input = new FileInputStream(source);
             OutputStream output = getContentResolver().openOutputStream(uri)) {
            if (output == null) {
                throw new IllegalStateException("无法打开输出流");
            }
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
        return uri;
    }

    private void saveLastMiCloudZipToDownloads() {
        SharedPreferences prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE);
        String markdown = prefs.getString("last_probe_markdown", "");
        String json = prefs.getString("last_probe_json", "");
        if ((markdown == null || markdown.trim().isEmpty()) && (json == null || json.trim().isEmpty())) {
            append("暂无可打包的云端结果。请先拉取心率列表。");
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            append("当前 Android 版本不支持免权限写入下载目录，请使用“分享云MD/JSON”。");
            return;
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        try {
            Uri uri = saveMiCloudZipToDownloads("mi-health-cloud-" + stamp + ".zip", markdown, json);
            getSharedPreferences("mi_health_cloud", MODE_PRIVATE)
                    .edit()
                    .putString("last_probe_zip_uri", uri.toString())
                    .apply();
            append("云端 ZIP 已保存：" + uri);
            Toast.makeText(this, "云端 ZIP 已保存到下载目录", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            append("保存云端 ZIP 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private Uri saveMiCloudZipToDownloads(String fileName, String markdown, String json) throws Exception {
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, fileName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/RabiRouteBandProbe");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("MediaStore 返回空 URI");
        }
        OutputStream stream = getContentResolver().openOutputStream(uri);
        if (stream == null) {
            throw new IllegalStateException("无法打开输出流");
        }
        try (ZipOutputStream zip = new ZipOutputStream(stream)) {
            if (markdown != null && !markdown.trim().isEmpty()) {
                writeZipText(zip, "mi-health-heart-rate.md", markdown);
            }
            if (json != null && !json.trim().isEmpty()) {
                writeZipText(zip, "mi-health-heart-rate.json", json);
            }
            File dir = new File(getFilesDir(), "mi-health-cloud-raw");
            File[] files = dir.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (file.isFile()) {
                        writeZipFile(zip, "raw/" + file.getName(), file);
                    }
                }
            }
        }
        return uri;
    }

    private void writeZipText(ZipOutputStream zip, String name, String text) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        zip.write(text.getBytes(StandardCharsets.UTF_8));
        zip.closeEntry();
    }

    private void writeZipFile(ZipOutputStream zip, String name, File file) throws Exception {
        zip.putNextEntry(new ZipEntry(name));
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                zip.write(buffer, 0, read);
            }
        }
        zip.closeEntry();
    }

    private void startScan() {
        ensurePermissions();
        if (bluetoothAdapter == null || scanner == null) {
            append("蓝牙低功耗扫描器不可用。");
            return;
        }
        if (!bluetoothAdapter.isEnabled()) {
            append("蓝牙未开启。");
            return;
        }
        scanResults.clear();
        renderDeviceList();
        append("正在扫描附近的 BLE 设备...");
        scanner.startScan(scanCallback);
        setScanning(true);
        handler.postDelayed(this::stopScan, 15000);
    }

    private void stopScan() {
        if (scanner != null && scanning) {
            scanner.stopScan(scanCallback);
        }
        setScanning(false);
    }

    private void setScanning(boolean value) {
        scanning = value;
        if (scanButton != null) {
            scanButton.setEnabled(!value);
        }
        if (stopButton != null) {
            stopButton.setEnabled(value);
        }
    }

    private void renderDeviceList() {
        handler.post(() -> {
            deviceList.removeAllViews();
            List<ScanResult> results = new ArrayList<>(scanResults.values());
            results.sort((a, b) -> Integer.compare(b.getRssi(), a.getRssi()));
            for (ScanResult result : results) {
                BluetoothDevice device = result.getDevice();
                Button row = new Button(this);
                String name = safeName(device);
                String address = safeAddress(device);
                row.setAllCaps(false);
                row.setText(name + "\n" + address + " 信号 " + result.getRssi() + signalLabel(result));
                row.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
                row.setOnClickListener(v -> connect(result));
                deviceList.addView(row, new LinearLayout.LayoutParams(-1, -2));
            }
        });
    }

    private void connect(ScanResult result) {
        stopScan();
        BluetoothDevice device = result.getDevice();
        append("");
        append("已选择：" + safeName(device) + " " + safeAddress(device) + "，信号=" + result.getRssi());
        append("广播信息：" + describeAdvertisement(result));
        if (gatt != null) {
            gatt.close();
            gatt = null;
        }
        append("正在连接 GATT...");
        gatt = device.connectGatt(this, false, gattCallback);
    }

    private void inspectServices(BluetoothGatt bluetoothGatt) {
        List<BluetoothGattService> services = bluetoothGatt.getServices();
        append("服务数量：" + services.size());
        for (BluetoothGattService service : services) {
            append("服务 " + shortUuid(service.getUuid()) + "，特征数量=" + service.getCharacteristics().size());
        }

        enqueueReadable(bluetoothGatt, DEVICE_INFORMATION_SERVICE);
        enqueueReadable(bluetoothGatt, BATTERY_SERVICE);
        subscribeHeartRate(bluetoothGatt);
        readNext();
    }

    private void enqueueReadable(BluetoothGatt bluetoothGatt, UUID serviceUuid) {
        BluetoothGattService service = bluetoothGatt.getService(serviceUuid);
        if (service == null) {
            append("未发现服务：" + shortUuid(serviceUuid));
            return;
        }
        for (BluetoothGattCharacteristic characteristic : service.getCharacteristics()) {
            if ((characteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_READ) != 0) {
                readQueue.add(characteristic);
            }
        }
    }

    private void readNext() {
        if (gatt == null) {
            return;
        }
        BluetoothGattCharacteristic next = readQueue.poll();
        if (next == null) {
            append("公开可读特征读取完成。");
            return;
        }
        boolean started = gatt.readCharacteristic(next);
        append("请求读取 " + shortUuid(next.getUuid()) + "：" + started);
        if (!started) {
            handler.postDelayed(this::readNext, 150);
        }
    }

    private void subscribeHeartRate(BluetoothGatt bluetoothGatt) {
        BluetoothGattService service = bluetoothGatt.getService(HEART_RATE_SERVICE);
        if (service == null) {
            append("未发现心率服务。请先在手环开启“心率广播 / Share HR”，然后重新扫描。");
            return;
        }
        BluetoothGattCharacteristic measurement = service.getCharacteristic(HEART_RATE_MEASUREMENT);
        if (measurement == null) {
            append("未发现心率测量特征。");
            return;
        }
        boolean notifyEnabled = bluetoothGatt.setCharacteristicNotification(measurement, true);
        append("启用本地心率通知：" + notifyEnabled);
        BluetoothGattDescriptor descriptor = measurement.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG);
        if (descriptor == null) {
            append("未发现心率 CCC 描述符。");
            return;
        }
        descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
        boolean writeStarted = bluetoothGatt.writeDescriptor(descriptor);
        append("启用远端心率通知：" + writeStarted);
    }

    private String describeAdvertisement(ScanResult result) {
        if (result.getScanRecord() == null) {
            return "<没有广播记录>";
        }
        StringBuilder builder = new StringBuilder();
        builder.append("名称=").append(result.getScanRecord().getDeviceName());
        builder.append("，服务=").append(result.getScanRecord().getServiceUuids());
        builder.append("，厂商数据=");
        android.util.SparseArray<byte[]> manufacturer = result.getScanRecord().getManufacturerSpecificData();
        if (manufacturer == null || manufacturer.size() == 0) {
            builder.append("{}");
        } else {
            builder.append("{");
            for (int i = 0; i < manufacturer.size(); i++) {
                if (i > 0) {
                    builder.append(", ");
                }
                builder.append(manufacturer.keyAt(i)).append(":").append(bytesToHex(manufacturer.valueAt(i)));
            }
            builder.append("}");
        }
        return builder.toString();
    }

    private String signalLabel(ScanResult result) {
        if (result.getScanRecord() == null) {
            return "";
        }
        List<android.os.ParcelUuid> uuids = result.getScanRecord().getServiceUuids();
        if (uuids != null) {
            for (android.os.ParcelUuid parcelUuid : uuids) {
                if (HEART_RATE_SERVICE.equals(parcelUuid.getUuid())) {
                    return " HR";
                }
            }
        }
        return "";
    }

    private String decodeValue(BluetoothGattCharacteristic characteristic) {
        byte[] value = characteristic.getValue();
        if (value == null) {
            return "<null>";
        }
        if (BATTERY_SERVICE.equals(characteristic.getService().getUuid()) && value.length > 0) {
            return (value[0] & 0xFF) + "%，原始数据=" + bytesToHex(value);
        }
        if (looksText(value)) {
            return "\"" + new String(value, StandardCharsets.UTF_8).trim() + "\"，原始数据=" + bytesToHex(value);
        }
        return bytesToHex(value);
    }

    private int parseHeartRate(byte[] value) {
        if (value == null || value.length < 2) {
            return -1;
        }
        boolean sixteenBit = (value[0] & 0x01) == 0x01;
        if (sixteenBit && value.length >= 3) {
            return (value[1] & 0xFF) | ((value[2] & 0xFF) << 8);
        }
        return value[1] & 0xFF;
    }

    private boolean looksText(byte[] value) {
        if (value.length == 0) {
            return false;
        }
        for (byte b : value) {
            int c = b & 0xFF;
            if (c == 0) {
                return false;
            }
            if (c < 0x20 || c > 0x7E) {
                return false;
            }
        }
        return true;
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
            clipboard.setPrimaryClip(ClipData.newPlainText("Rabi 手环探针日志", report.toString()));
            Toast.makeText(this, "日志已复制", Toast.LENGTH_SHORT).show();
        }
    }

    private String safeName(BluetoothDevice device) {
        try {
            String name = device.getName();
            return name == null || name.trim().isEmpty() ? "<未命名设备>" : name;
        } catch (SecurityException e) {
            return "<权限不足>";
        }
    }

    private String safeAddress(BluetoothDevice device) {
        try {
            return device.getAddress();
        } catch (SecurityException e) {
            return null;
        }
    }

    private static UUID uuid16(int value) {
        return UUID.fromString(String.format(Locale.US, "0000%04x-0000-1000-8000-00805f9b34fb", value));
    }

    private static String shortUuid(UUID uuid) {
        String text = uuid.toString();
        if (text.startsWith("0000") && text.endsWith("-0000-1000-8000-00805f9b34fb")) {
            return "0x" + text.substring(4, 8).toUpperCase(Locale.US);
        }
        return text;
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return "<null>";
        }
        char[] hexArray = "0123456789ABCDEF".toCharArray();
        char[] hexChars = new char[bytes.length * 2];
        for (int j = 0; j < bytes.length; j++) {
            int v = bytes[j] & 0xFF;
            hexChars[j * 2] = hexArray[v >>> 4];
            hexChars[j * 2 + 1] = hexArray[v & 0x0F];
        }
        return new String(hexChars);
    }
}
