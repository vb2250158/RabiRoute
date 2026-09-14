package com.rabi.link.modules.rokid;

import android.content.Context;
import android.util.Log;

import java.lang.reflect.Constructor;

/**
 * Loads the optional Rokid Phone SDK bridge without linking it into the
 * foreground-service class verifier.
 */
public final class RabiGlassBridgeFactory {
    private static final String TAG = "RabiGlassBridgeFactory";
    private static final String IMPLEMENTATION =
            "com.rabi.link.modules.rokid.RokidNativeVoiceBridge";

    private RabiGlassBridgeFactory() {
    }

    public static RabiGlassBridge create(
            Context context,
            RabiGlassBridge.Listener listener,
            String accessKey,
            String secretKey
    ) {
        try {
            Class<?> type = Class.forName(IMPLEMENTATION, true, context.getClassLoader());
            Constructor<?> constructor = type.getDeclaredConstructor(
                    Context.class,
                    RabiGlassBridge.Listener.class,
                    String.class,
                    String.class
            );
            constructor.setAccessible(true);
            Object bridge = constructor.newInstance(context, listener, accessKey, secretKey);
            return bridge instanceof RabiGlassBridge ? (RabiGlassBridge) bridge : null;
        } catch (Throwable error) {
            Log.w(TAG, "Optional Rokid Phone SDK bridge is unavailable: "
                    + error.getClass().getSimpleName());
            return null;
        }
    }
}
