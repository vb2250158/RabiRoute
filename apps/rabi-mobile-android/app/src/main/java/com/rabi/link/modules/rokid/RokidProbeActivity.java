package com.rabi.link.modules.rokid;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import com.rabi.link.BuildConfig;

/**
 * Dependency-safe entry point for optional Rokid diagnostics.
 *
 * <p>The mobile-slim APK intentionally omits local Rokid ASR/TTS runtimes.
 * This activity exposes CXR-only diagnostics instead of loading the full
 * diagnostic activity and crashing on absent SDK classes.</p>
 */
public final class RokidProbeActivity extends Activity {
    private RokidCustomCommandProbe customProbe;
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
        customProbe = new RokidCustomCommandProbe(this);
        customProbe.show();
    }

    @Override protected void onDestroy() {
        if (customProbe != null) customProbe.close();
        super.onDestroy();
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

}
