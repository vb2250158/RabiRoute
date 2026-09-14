package com.rabi.link;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.text.DateFormat;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONObject;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Mobile-only, read-only view of the phone audio stream and successful ASR records. */
public final class RabiSpeechPreviewActivity extends Activity {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private LinearLayout content;
    private TextView status;
    private Button refresh;
    private Button clearQuarantine;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        setTitle("录音与转写");
        setContentView(buildView());
        refresh();
    }

    @Override protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    private View buildView() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(RabiMobileUi.backgroundColor());
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int padding = RabiMobileUi.dp(this, 16);
        root.setPadding(padding, padding, padding, padding);
        root.addView(RabiMobileUi.hero(this, "录音与转写", "查看这台手机的实时音频链路，以及最近 24 小时成功转写的语段。"), full(0, 0, 0, 12));
        status = RabiMobileUi.guidance(this, new RabiSetupGuidance("正在读取", "正在联系所选 Rabi PC。", "请稍候。", RabiGuidanceTone.INFO));
        root.addView(status, full(0, 0, 0, 12));
        refresh = new Button(this);
        refresh.setText("刷新");
        RabiMobileUi.stylePrimaryButton(this, refresh);
        refresh.setOnClickListener(ignored -> refresh());
        root.addView(refresh, full(0, 0, 0, 12));
        clearQuarantine = new Button(this);
        clearQuarantine.setText("清理隔离录音");
        RabiMobileUi.styleSecondaryButton(this, clearQuarantine);
        clearQuarantine.setVisibility(View.GONE);
        clearQuarantine.setOnClickListener(ignored -> confirmClearQuarantine());
        root.addView(clearQuarantine, full(0, 0, 0, 12));
        content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        root.addView(content, new LinearLayout.LayoutParams(-1, -2));
        scroll.addView(root, new ScrollView.LayoutParams(-1, -2));
        return scroll;
    }

    private void refresh() {
        refresh.setEnabled(false);
        content.removeAllViews();
        showStatus("正在读取", "正在联系所选 Rabi PC。", "请稍候。", RabiGuidanceTone.INFO);
        RabiLinkRelayConfig config = RabiLinkRelaySettings.load(this);
        if (!config.getConfigured()) {
            refresh.setEnabled(true);
            showStatus("还没有连接 Rabi", "预览页需要已保存的 RabiLink 地址和登录码。", "返回首页完成连接后再刷新。", RabiGuidanceTone.WARNING);
            return;
        }
        executor.execute(() -> {
            try {
                String deviceId = RabiMobileDeviceIdentity.load(getApplicationContext());
                RabiSpeechPreviewSnapshot snapshot = new RabiSpeechPreviewClient().load(config, deviceId);
                runOnUiThread(() -> render(snapshot));
            } catch (Throwable error) {
                runOnUiThread(() -> {
                    refresh.setEnabled(true);
                    String detail = error.getMessage() == null || error.getMessage().trim().isEmpty()
                            ? error.getClass().getSimpleName() : error.getMessage().trim();
                    showStatus("暂时无法刷新", detail, "确认网络、RabiLink Relay、所选 Rabi PC 和 RabiSpeech 均在线后重试。已有 PC 记录不会因此被删除。", RabiGuidanceTone.ERROR);
                });
            }
        });
    }

    private void render(RabiSpeechPreviewSnapshot snapshot) {
        refresh.setEnabled(true);
        String streamState = !snapshot.stream.found ? "未发现这台手机的音频流"
                : snapshot.stream.online ? (snapshot.stream.selected ? "在线，正在进入识别" : "在线，但当前未被选作识别输入")
                : "音频流已离线";
        showStatus("已读取真实记录", streamState, "需要最新状态时点“刷新”；打开本页不会延长音频的 24 小时缓存。", snapshot.stream.online ? RabiGuidanceTone.SUCCESS : RabiGuidanceTone.WARNING);

        LinearLayout summary = RabiMobileUi.styleCard(this, new LinearLayout(this));
        summary.addView(title("当前音频链路"));
        summary.addView(metric("收到 PCM 分块", formatNumber(snapshot.stream.acceptedChunks) + " 个"));
        summary.addView(metric("收到数据", formatBytes(snapshot.stream.receivedBytes)));
        if (snapshot.runtimeStats.attributableToDevice) {
            summary.addView(metric("进入识别", formatNumber(snapshot.runtimeStats.captured) + " 段"));
            summary.addView(metric("转写成功", formatNumber(snapshot.runtimeStats.recognized) + " 段"));
            summary.addView(metric("空结果", formatNumber(snapshot.runtimeStats.empty) + " 段"));
            summary.addView(metric("队列丢弃", formatNumber(snapshot.runtimeStats.dropped) + " 段"));
        } else {
            summary.addView(note("RabiSpeech 当前没有选择这台手机作为识别输入，因此不把全局识别计数冒充为这台手机的数据。"));
        }
        content.addView(summary, full(0, 0, 0, 12));
        renderLocalDurability();

        LinearLayout records = RabiMobileUi.styleCard(this, new LinearLayout(this));
        records.addView(title("最近 24 小时成功转写 · " + snapshot.successfulCountLabel() + " 条"));
        if (snapshot.recordCountTruncated) records.addView(note("已达到单次读取上限，仅显示最近 1000 条。"));
        if (snapshot.successfulRecords.isEmpty()) {
            records.addView(note("没有找到属于这台手机、带非空文字的成功 ASR 记录。"));
        } else {
            for (RabiSpeechPreviewSnapshot.Record record : snapshot.successfulRecords) {
                records.addView(recordView(record));
            }
        }
        content.addView(records, full(0, 0, 0, 16));
    }

    private void renderLocalDurability() {
        long pending = 0L;
        long stored = 0L;
        long rejected = 0L;
        long quarantineItems = 0L;
        long quarantineBytes = 0L;
        try {
            File state = new File(getFilesDir(), "rabi-conversation/audio-spool/state.json");
            JSONObject value = new JSONObject(new String(Files.readAllBytes(state.toPath()), StandardCharsets.UTF_8));
            pending = value.optLong("pendingSegments", 0L);
            stored = value.optLong("storedBytes", 0L);
            rejected = value.optLong("rejectedBytes", 0L);
            quarantineItems = value.optLong("quarantineItems", 0L);
            quarantineBytes = value.optLong("quarantineBytes", 0L);
        } catch (Throwable ignored) { }
        LinearLayout local = RabiMobileUi.styleCard(this, new LinearLayout(this));
        local.addView(title("手机本地耐久录音"));
        local.addView(metric("待确认分片", formatNumber(pending) + " 个"));
        local.addView(metric("本地占用", formatBytes(stored)));
        local.addView(metric("已记录缺口", formatBytes(rejected)));
        local.addView(metric("隔离项目", formatNumber(quarantineItems) + " 个 · " + formatBytes(quarantineBytes)));
        if (quarantineItems > 0L) {
            local.addView(note("损坏或归属不明的文件不会自动删除，也不会阻塞后续可验证分片。只有你在本页确认后才会清理。"));
        }
        clearQuarantine.setVisibility(quarantineItems > 0L ? View.VISIBLE : View.GONE);
        content.addView(local, full(0, 0, 0, 12));
    }

    private void confirmClearQuarantine() {
        new AlertDialog.Builder(this)
                .setTitle("清理隔离录音？")
                .setMessage("这些文件可能用于排查录音缺口。清理后无法恢复；待上传和已确认的正常分片不会受影响。")
                .setNegativeButton("取消", null)
                .setPositiveButton("确认清理", (dialog, which) -> {
                    clearQuarantine.setEnabled(false);
                    RabiConversationService.clearAudioQuarantineAfterUserConfirmation(this);
                    clearQuarantine.postDelayed(() -> {
                        clearQuarantine.setEnabled(true);
                        refresh();
                    }, 1200L);
                })
                .show();
    }

    private View recordView(RabiSpeechPreviewSnapshot.Record record) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.VERTICAL);
        row.setPadding(0, RabiMobileUi.dp(this, 11), 0, RabiMobileUi.dp(this, 11));
        TextView meta = note(formatTime(record.time) + "  ·  " + String.format(Locale.CHINA, "%.1f 秒", record.durationSeconds));
        meta.setPadding(0, 0, 0, RabiMobileUi.dp(this, 4));
        row.addView(meta);
        TextView transcript = new TextView(this);
        transcript.setText(record.text);
        transcript.setTextColor(RabiMobileUi.textColor());
        transcript.setTextSize(15f);
        transcript.setLineSpacing(0f, 1.15f);
        row.addView(transcript);
        String audio = record.audioAvailable ? "原音仍在 24 小时缓存内" : "原音已过期或当前不可回听";
        String engine = (record.provider + " / " + record.model).replaceAll("^\\s*/\\s*|\\s*/\\s*$", "");
        row.addView(note(audio + (engine.isEmpty() ? "" : "  ·  " + engine) + "  ·  " + record.id));
        return row;
    }

    private TextView metric(String label, String value) {
        TextView view = new TextView(this);
        view.setText(label + "\n" + value);
        view.setTextColor(RabiMobileUi.textColor());
        view.setTextSize(14f);
        view.setGravity(Gravity.START);
        view.setPadding(0, RabiMobileUi.dp(this, 7), 0, RabiMobileUi.dp(this, 7));
        view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private TextView title(String value) {
        return RabiMobileUi.title(this, value, 17f);
    }

    private TextView note(String value) {
        return RabiMobileUi.note(this, value);
    }

    private void showStatus(String title, String reason, String action, RabiGuidanceTone tone) {
        RabiMobileUi.styleGuidance(this, status, title, reason, action, tone);
    }

    private LinearLayout.LayoutParams full(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams value = new LinearLayout.LayoutParams(-1, -2);
        value.setMargins(RabiMobileUi.dp(this, left), RabiMobileUi.dp(this, top), RabiMobileUi.dp(this, right), RabiMobileUi.dp(this, bottom));
        return value;
    }

    private static String formatBytes(long bytes) {
        if (bytes < 1024L) return bytes + " B";
        if (bytes < 1024L * 1024L) return String.format(Locale.CHINA, "%.1f KiB", bytes / 1024d);
        return String.format(Locale.CHINA, "%.1f MiB", bytes / (1024d * 1024d));
    }

    private static String formatNumber(long value) {
        return String.format(Locale.CHINA, "%,d", value);
    }

    private static String formatTime(long value) {
        if (value <= 0L) return "时间未知";
        long millis = value < 10_000_000_000L ? value * 1000L : value;
        return DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.MEDIUM, Locale.CHINA).format(new Date(millis));
    }
}
