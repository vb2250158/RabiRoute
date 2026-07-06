package com.rabi.link.modules.xiaomi

import org.json.JSONArray
import org.json.JSONObject

internal object MiHealthCloudRawHttpSummary {
    fun summarizeJsonBody(body: String): JSONObject {
        if (body.isBlank()) {
            return JSONObject().put("kind", "empty")
        }
        return try {
            val root = JSONObject(body)
            val summary = JSONObject()
                .put("kind", "object")
                .put("keys", JSONArray(root.keys().asSequence().toList()))
            val data = root.opt("data")
            if (data is JSONObject) {
                summary.put("dataKeys", JSONArray(data.keys().asSequence().toList()))
            } else if (data is JSONArray) {
                summary.put("dataLength", data.length())
            }
            summary
        } catch (error: Throwable) {
            JSONObject()
                .put("kind", "non-json")
                .put("error", "${error.javaClass.simpleName}: ${error.message}")
        }
    }
}
