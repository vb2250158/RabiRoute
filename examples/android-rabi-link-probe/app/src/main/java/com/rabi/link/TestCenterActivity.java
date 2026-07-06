package com.rabi.link;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.rabi.link.modules.rabiroute.RabiRouteSdkProbeActivity;
import com.rabi.link.modules.rokid.RokidProbeActivity;
import com.rabi.link.modules.xiaomi.XiaomiProbeActivity;

public class TestCenterActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        buildUi();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(24, 24, 24, 24);

        TextView title = new TextView(this);
        title.setText("RabiLink 接口测试中心");
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER_VERTICAL);
        root.addView(title, new LinearLayout.LayoutParams(-1, -2));

        TextView version = new TextView(this);
        version.setText("构建：" + BuildConfig.BUILD_TIME);
        version.setTextSize(12);
        root.addView(version, new LinearLayout.LayoutParams(-1, -2));

        TextView summary = new TextView(this);
        summary.setText("这里保留设备能力探针。正式连接入口请回到 RabiLink 首页。");
        summary.setTextSize(14);
        summary.setPadding(0, 16, 0, 12);
        root.addView(summary, new LinearLayout.LayoutParams(-1, -2));

        addTestCard(
                root,
                "RabiRoute API / SDK 测试",
                "局域网扫描 + Agent 绑定",
                "扫描局域网 RabiRoute\n读取路由列表与 Agent 可选目录/会话\n设置 Route 的 Codex 工作目录和线程名",
                () -> startActivity(new Intent(this, RabiRouteSdkProbeActivity.class))
        );
        addTestCard(
                root,
                "小米接口测试",
                "13 项测试接口",
                "BLE 广播 / 设备信息 / 电量 / 心率服务\nHealth Connect 心率、睡眠、步数\n小米云授权、心率列表、全类型深扫、证据包\n小米健康 Provider 权限边界",
                () -> startActivity(new Intent(this, XiaomiProbeActivity.class))
        );
        addTestCard(
                root,
                "Rokid 眼镜接口测试",
                "6 项测试接口",
                "Rokid App 检测与授权\nCXRLink 连接与会话状态\nCustomView Hello World\n音频流 WAV、拍照 JPEG、设备信息、亮度和音量",
                () -> startActivity(new Intent(this, RokidProbeActivity.class))
        );

        ScrollView scrollView = new ScrollView(this);
        scrollView.addView(root);
        setContentView(scrollView);
    }

    private void addTestCard(LinearLayout root, String title, String meta, String body, Runnable action) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(24, 20, 24, 20);
        card.setBackground(cardBackground());
        card.setOnClickListener(v -> action.run());

        TextView cardTitle = new TextView(this);
        cardTitle.setText(title);
        cardTitle.setTextSize(18);
        card.addView(cardTitle, new LinearLayout.LayoutParams(-1, -2));

        TextView cardMeta = new TextView(this);
        cardMeta.setText(meta);
        cardMeta.setTextSize(12);
        cardMeta.setTextColor(Color.rgb(88, 92, 98));
        cardMeta.setPadding(0, 4, 0, 8);
        card.addView(cardMeta, new LinearLayout.LayoutParams(-1, -2));

        TextView cardBody = new TextView(this);
        cardBody.setText(body);
        cardBody.setTextSize(13);
        cardBody.setPadding(0, 0, 0, 10);
        card.addView(cardBody, new LinearLayout.LayoutParams(-1, -2));

        Button button = new Button(this);
        button.setText("开始测试");
        button.setAllCaps(false);
        button.setOnClickListener(v -> action.run());
        card.addView(button, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, 18);
        root.addView(card, params);
    }

    private GradientDrawable cardBackground() {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(Color.WHITE);
        drawable.setStroke(2, Color.rgb(218, 222, 228));
        drawable.setCornerRadius(18);
        return drawable;
    }
}
