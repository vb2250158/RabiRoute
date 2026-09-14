package com.rabi.link.modules.xiaomi

import org.json.JSONObject

internal object MiHealthCloudMarkdownFormat {
    fun pointValueText(point: JSONObject): String {
        val value = point.optJSONArray("value") ?: return ""
        if (value.length() == 1) {
            val first = value.opt(0)
            if (first is JSONObject) {
                val bpm = first.opt("fpVal") ?: first.opt("intVal") ?: first.opt("value")
                if (bpm != null) {
                    return bpm.toString()
                }
            }
        }
        return value.toString()
    }

    fun pointNumericValue(point: JSONObject): Double? {
        val value = point.optJSONArray("value") ?: return null
        if (value.length() == 0) {
            return null
        }
        val first = value.optJSONObject(0) ?: return null
        return when {
            first.has("fpVal") -> first.optDouble("fpVal")
            first.has("intVal") -> first.optInt("intVal").toDouble()
            first.has("value") -> first.optDouble("value")
            else -> null
        }
    }

    fun escape(text: String): String {
        return text.replace("|", "\\|").replace("\n", " ")
    }

    fun formatNs(ns: Long): String {
        if (ns <= 0L) {
            return "unknown"
        }
        return MiHealthCloudTimeFormatter.formatNs(ns)
    }
}
