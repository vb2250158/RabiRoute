package com.rabi.link;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
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
        root.setPadding(dp(16), dp(16), dp(16), dp(28));
        root.setBackgroundColor(RabiMobileUi.backgroundColor());

        root.addView(
                RabiMobileUi.hero(
                        this,
                        "高级诊断中心",
                        "这里只给排障和硬件验证使用。首次连接、健康同步和眼镜日常使用请回到 Rabi 首页。"
                ),
                full(0, 0, 0, 12)
        );

        TextView guidance = new TextView(this);
        RabiMobileUi.styleGuidance(
                this,
                guidance,
                "普通使用不需要打开这里",
                "这些页面会显示接口名、日志和实验能力，属于开发者诊断，不是日常配置步骤。",
                "如果只是连接 Rabi，请点下方“返回 Rabi 首页”；遇到客服或开发者要求时再打开对应诊断。",
                RabiGuidanceTone.INFO
        );
        root.addView(guidance, full(0, 0, 0, 12));

        Button home = new Button(this);
        home.setText("返回 Rabi 首页");
        RabiMobileUi.stylePrimaryButton(this, home);
        home.setOnClickListener(v -> finish());
        root.addView(home, full(0, 0, 0, 12));

        TextView build = new TextView(this);
        build.setText("诊断包构建：" + BuildConfig.BUILD_TIME);
        RabiMobileUi.styleNoteText(this, build);
        root.addView(build, full(0, 0, 0, 10));

        addTestCard(
                root,
                "RabiRoute API / SDK 测试",
                "检查电脑发现与连接链路",
                "自动扫描局域网 RabiRoute，验证 Manager 与 RabiLink，并查看高级 Route / Codex 绑定。",
                () -> startActivity(new Intent(this, RabiRouteSdkProbeActivity.class))
        );
        addTestCard(
                root,
                "小米接口测试",
                "检查手环数据来源",
                "验证 BLE、Health Connect、小米合作方云接口和证据导出。普通健康同步优先使用首页里的健康设置。",
                () -> startActivity(new Intent(this, XiaomiProbeActivity.class))
        );
        addTestCard(
                root,
                "Rokid 眼镜接口测试",
                "检查眼镜连接与能力",
                "验证 Rokid App、手机权限、安全授权、眼镜连接、安装启动和媒体能力。",
                () -> startActivity(new Intent(this, RokidProbeActivity.class))
        );

        ScrollView scrollView = new ScrollView(this);
        scrollView.addView(root);
        setContentView(scrollView);
    }

    private void addTestCard(LinearLayout root, String title, String meta, String body, Runnable action) {
        LinearLayout card = new LinearLayout(this);
        RabiMobileUi.styleCard(this, card);
        card.setOnClickListener(v -> action.run());

        TextView cardTitle = new TextView(this);
        cardTitle.setText(title);
        RabiMobileUi.styleTitleText(this, cardTitle, 17f);
        card.addView(cardTitle, new LinearLayout.LayoutParams(-1, -2));

        TextView cardMeta = new TextView(this);
        cardMeta.setText(meta);
        RabiMobileUi.styleNoteText(this, cardMeta);
        cardMeta.setPadding(0, 4, 0, 8);
        card.addView(cardMeta, new LinearLayout.LayoutParams(-1, -2));

        TextView cardBody = new TextView(this);
        cardBody.setText(body);
        RabiMobileUi.styleNoteText(this, cardBody);
        cardBody.setPadding(0, 0, 0, 10);
        card.addView(cardBody, new LinearLayout.LayoutParams(-1, -2));

        Button button = new Button(this);
        button.setText("打开诊断");
        RabiMobileUi.styleSecondaryButton(this, button);
        button.setOnClickListener(v -> action.run());
        card.addView(button, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(0, 0, 0, dp(12));
        root.addView(card, params);
    }

    private LinearLayout.LayoutParams full(int left, int top, int right, int bottom) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.setMargins(dp(left), dp(top), dp(right), dp(bottom));
        return params;
    }

    private int dp(int value) {
        return RabiMobileUi.dp(this, value);
    }
}
