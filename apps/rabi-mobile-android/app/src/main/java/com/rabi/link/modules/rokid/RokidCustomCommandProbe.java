package com.rabi.link.modules.rokid;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Switch;
import com.rokid.cxr.link.utils.GlassInfo;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.UUID;

/** CXR-L-only, foreground diagnostic. No capture or arbitrary channel commands. */
final class RokidCustomCommandProbe implements RokidCxrController.Listener {
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final RokidProbeReport report = new RokidProbeReport();
    private final RokidCxrController controller;
    private TextView log;
    private boolean installed;
    private boolean appReady;
    private boolean closed;
    private String pending = "";

    RokidCustomCommandProbe(Activity activity) {
        this.activity = activity;
        controller = new RokidCxrController(activity, this, "com.rabi.link.glass.video");
    }

    void show() {
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * activity.getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);
        TextView title = new TextView(activity);
        title.setText("CXR 自定义消息测试"); title.setTextSize(22); root.addView(title);
        TextView note = new TextView(activity);
        note.setText("目标：Rabi 眼镜组件。此测试不录音、不拍摄；回包不代表深深收到消息。按顺序连接、查询安装、启动，再发送测试。");
        root.addView(note);
        Switch output = new Switch(activity);
        output.setText("收到的文字显示到眼镜（不录音）");
        output.setChecked(RabiGlassTextOutput.enabled(activity));
        output.setOnCheckedChangeListener((button, checked) -> RabiGlassTextOutput.setEnabled(activity, checked));
        root.addView(output);
        button(root, "连接 CXR", () -> {
            installed = false; appReady = false; pending = "";
            String token = activity.getSharedPreferences("rokid_probe", Activity.MODE_PRIVATE).getString("rokid_token", "");
            if (token == null || token.isEmpty()) { append("缺少乐奇授权，请先在设备设置完成授权。"); return; }
            controller.connectGlassAppSession(token);
        });
        button(root, "查询眼镜组件", () -> { if (linkReady()) { installed = false; appReady = false; controller.queryGlassAsrApp(); } });
        button(root, "安装随包眼镜组件", this::install);
        button(root, "启动眼镜组件（无采集）", () -> {
            if (!linkReady()) return;
            if (!installed) { append("请先查询并确认组件已安装。"); return; }
            appReady = false; controller.startGlassVideoApp();
        });
        button(root, "发送一次 Ping", this::ping);
        button(root, "测试眼镜文字显示", () -> {
            controller.disconnect();
            installed = false; appReady = false; pending = "";
            new Thread(() -> {
                RabiGlassTextOutput target = new RabiGlassTextOutput(activity);
                boolean shown = target.deliver("diagnostic-" + UUID.randomUUID(), "Rabi 文字投递测试");
                target.close(); append(shown ? "眼镜已确认显示测试文字。" : "眼镜未确认显示测试文字。");
            }, "rabi-glass-text-test").start();
        });
        button(root, "复制结果", () -> new RokidReportClipboard().copy(activity, report.text()));
        log = new TextView(activity); log.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(activity); scroll.addView(log);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        activity.setContentView(root);
        append("仅测试 rabi_video_control → rabi_video_status；SDK 发送成功与匹配回包分别记录。");
    }

    private void button(LinearLayout root, String label, Runnable action) {
        Button button = new Button(activity); button.setText(label);
        button.setOnClickListener(v -> { try { action.run(); } catch (Exception e) { append("操作失败：" + e.getClass().getSimpleName()); } });
        root.addView(button);
    }

    private boolean linkReady() {
        if (controller.isLinkReady()) return true;
        append("等待 CXR 服务与眼镜蓝牙连接。"); return false;
    }

    private void install() {
        if (!linkReady()) return;
        installed = false; appReady = false;
        try {
            File apk = new File(activity.getCacheDir(), "rabi-glass-video.apk");
            try (InputStream input = activity.getAssets().open("rabi-glass-video.apk"); FileOutputStream output = new FileOutputStream(apk)) {
                byte[] buffer = new byte[32768]; int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            controller.installGlassAsrApp(apk.getAbsolutePath());
        } catch (Exception e) { append("安装准备失败：" + e.getClass().getSimpleName()); }
    }

    private void ping() {
        if (!linkReady()) return;
        if (!installed || !appReady) { append("未确认当前安装与眼镜组件启动，未发送。"); return; }
        if (!pending.isEmpty()) { append("上一条测试仍在等待回包。"); return; }
        String id = UUID.randomUUID().toString(); pending = id;
        boolean sent = controller.sendVideoCommand("RABI_VIDEO:{\"action\":\"ping\",\"session\":\"" + id + "\"}");
        append("sendCustomCmd accepted=" + sent + " requestId=" + id);
        if (!sent) { pending = ""; return; }
        main.postDelayed(() -> {
            if (id.equals(pending)) { pending = ""; append("回包超时（15 秒）：SDK 接受不代表接收方已处理。"); }
        }, 15000);
    }

    private void append(String line) { main.post(() -> { if (!closed) report.append(log, line); }); }
    @Override public void onLog(String line) { append(line); }
    @Override public void onCxrConnectionChanged(boolean value) { main.post(() -> { if (!value) { installed = false; appReady = false; pending = ""; } }); }
    @Override public void onGlassBtConnectionChanged(boolean value) { onCxrConnectionChanged(value); }
    @Override public void onGlassDeviceInfo(GlassInfo info) { }
    @Override public void onPhoto(byte[] data) { }
    @Override public void onAudioPcm(byte[] data, int offset, int length) { }
    @Override public void onGlassAppResult(String status, String summary, String error) {
        main.post(() -> {
            if (summary.startsWith("onQueryAppResult")) installed = "ok".equals(status);
            if (summary.startsWith("onInstallAppResult")) { installed = false; append("安装回调后请重新查询安装状态。"); }
            if (summary.startsWith("onOpenAppResult") || summary.startsWith("onGlassAppResume")) appReady = "started".equals(status);
        });
    }
    @Override public void onNativeVoiceProtocol(String payload, String channel, String clientId) {
        main.post(() -> {
            if (!pending.isEmpty() && payload.equals("RABI_VIDEO_STATUS:pong:" + pending)) {
                append("匹配回包：requestId=" + pending + "；仅证明 Rabi 组件收发成功。"); pending = "";
            }
        });
    }
    void close() { closed = true; main.removeCallbacksAndMessages(null); controller.disconnect(); }
}
