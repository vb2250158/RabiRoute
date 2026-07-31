package com.rabi.link.modules.rokid;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.rabi.link.BuildConfig;

/**
 * Dependency-safe entry point for optional Rokid diagnostics.
 *
 * <p>The mobile-slim APK intentionally omits local Rokid ASR/TTS runtimes.
 * This activity therefore explains the boundary instead of loading the full
 * diagnostic activity and crashing on absent SDK classes.</p>
 */
public final class RokidProbeActivity extends Activity {
    private static final String PHONE_SDK_CLASS =
            "com.rokid.security.phone.sdk.api.PSecuritySDK";
    private static final String AI_SDK_CLASS =
            "com.rokid.ai.basic.AudioAiConfig";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (!BuildConfig.MOBILE_SLIM && optionalSdkAvailable()) {
            startActivity(new Intent(this, RokidProbeFullActivity.class)
                    .putExtras(getIntent()));
            finish();
            return;
        }
        showSlimExplanation();
    }

    private boolean optionalSdkAvailable() {
        try {
            ClassLoader loader = getClassLoader();
            Class.forName(PHONE_SDK_CLASS, false, loader);
            Class.forName(AI_SDK_CLASS, false, loader);
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void showSlimExplanation() {
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(padding, padding, padding, padding);
        root.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = new TextView(this);
        title.setText("RabiLink 手机精简模式");
        title.setTextSize(22);
        title.setTextColor(Color.rgb(19, 45, 78));
        root.addView(title);

        TextView body = new TextView(this);
        body.setText("这台手机只负责麦克风采集、网络重连、通知和语音播放。"
                + "ASR、说话人区分与人格 TTS 统一由 RabiPC 处理，"
                + "因此手机包不包含 Rokid 本地模型和诊断运行时。");
        body.setTextSize(16);
        body.setTextColor(Color.rgb(75, 85, 99));
        body.setPadding(0, padding / 2, 0, padding);
        root.addView(body);

        Button close = new Button(this);
        close.setText("返回");
        close.setOnClickListener(view -> finish());
        root.addView(close);
        setContentView(root);
    }
}
