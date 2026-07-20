package com.rabi.link.modules.rokid;

import android.app.Activity;
import android.content.Intent;
import android.util.Pair;

import com.rokid.sprite.aiapp.externalapp.auth.AuthResult;
import com.rokid.sprite.aiapp.externalapp.auth.AuthorizationHelper;
import com.rokid.sprite.aiapp.externalapp.auth.GlassPermission;

final class RokidAuthorizationFlow {
    Request request(Activity activity, int requestCode) {
        GlassPermission[] permissions = new GlassPermission[]{
                GlassPermission.MICROPHONE,
                GlassPermission.CAMERA,
                GlassPermission.MEDIA
        };
        Pair<Integer, Intent> result = AuthorizationHelper.INSTANCE.requestAuthorization(activity, permissions, requestCode);
        return new Request(result.first, result.second);
    }

    AuthResult parseResult(int resultCode, Intent data) {
        return AuthorizationHelper.INSTANCE.parseAuthorizationResult(resultCode, data);
    }

    String tokenFrom(AuthResult result) {
        if (result instanceof AuthResult.AuthSuccess) {
            return ((AuthResult.AuthSuccess) result).getToken();
        }
        return "";
    }

    static final class Request {
        final int resultCode;
        final Intent intent;

        Request(int resultCode, Intent intent) {
            this.resultCode = resultCode;
            this.intent = intent;
        }
    }
}
