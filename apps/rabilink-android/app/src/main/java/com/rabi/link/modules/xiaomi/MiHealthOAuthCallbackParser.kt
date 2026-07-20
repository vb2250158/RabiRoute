package com.rabi.link.modules.xiaomi

import android.net.Uri

internal object MiHealthOAuthCallbackParser {
    fun parse(uri: Uri): Map<String, String> {
        val text = listOfNotNull(uri.fragment, uri.encodedQuery).joinToString("&")
        if (text.isBlank()) {
            return emptyMap()
        }
        return text.split("&")
            .mapNotNull { part ->
                val index = part.indexOf("=")
                if (index <= 0) {
                    null
                } else {
                    val key = Uri.decode(part.substring(0, index))
                    val value = Uri.decode(part.substring(index + 1))
                    key to value
                }
            }
            .toMap()
    }
}
