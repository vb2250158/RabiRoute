package com.rabiroute.sdk

import org.json.JSONObject

/** Immutable validated cache of one authenticated Manager's timeout settings. */
class RabiTimeoutSettings(raw: JSONObject = JSONObject()) {
    private val values: Map<String, Long> = raw.keys().asSequence().mapNotNull { key ->
        val value = raw.opt(key)
        if (value is Number && value.toDouble() == value.toLong().toDouble()
            && value.toLong() in 1..2147483647L) key to value.toLong() else null
    }.toMap()
    fun get(key: String, fallback: Long): Long = values[key] ?: fallback
    fun toJson(): JSONObject = JSONObject(values)
}
