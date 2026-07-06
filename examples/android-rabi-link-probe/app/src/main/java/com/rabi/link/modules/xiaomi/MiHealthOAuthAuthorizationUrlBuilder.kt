package com.rabi.link.modules.xiaomi

import java.net.URLEncoder
import java.nio.charset.StandardCharsets

internal object MiHealthOAuthAuthorizationUrlBuilder {
    fun build(appId: String, redirectUri: String, scope: String, state: String): String {
        return buildString {
            append("https://account.xiaomi.com/oauth2/authorize")
            append("?client_id=").append(enc(appId))
            append("&redirect_uri=").append(enc(redirectUri))
            append("&response_type=token")
            if (scope.isNotBlank()) {
                append("&scope=").append(enc(scope))
            }
            append("&state=").append(enc(state))
            append("&skip_confirm=false")
        }
    }

    private fun enc(value: String): String {
        return URLEncoder.encode(value, StandardCharsets.UTF_8.name())
    }
}
