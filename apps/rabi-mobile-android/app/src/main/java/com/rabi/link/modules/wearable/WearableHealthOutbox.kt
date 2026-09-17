package com.rabi.link.modules.wearable

import android.content.Context
import android.util.AtomicFile
import com.rabiroute.sdk.RabiWearableHealthPolicy
import com.rabiroute.sdk.RabiWearableHealthSample
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Only unacknowledged transport envelopes. PC remains the health history owner. No credentials. */
internal class WearableHealthOutbox(private val context: Context) {
    companion object {
        fun identity(endpoint: String, token: String): String = if (endpoint.isBlank() || token.isBlank()) "" else
            java.security.MessageDigest.getInstance("SHA-256").digest((endpoint.trimEnd('/') + "\n" + token.trim()).toByteArray())
                .joinToString("") { "%02x".format(it) }
    }
    private val root = File(context.filesDir, "wearable-outbox").apply { mkdirs() }
    data class Entry(val file: File, val id: String, val endpoint: String, val credentialIdentity: String, val workerId: String, val processingPolicy: String, val routeProfileId: String, val capturedAt: Long,
        val config: WearableHealthConfig, val samples: List<RabiWearableHealthSample>)

    fun save(config: WearableHealthConfig, samples: List<RabiWearableHealthSample>, endpoint: String, window: Long, token: String, processingPolicy: String, routeProfileId: String, workerId: String) {
        val credentialIdentity = identity(endpoint, token)
        check((root.listFiles()?.sumOf { it.length() } ?: 0L) < 64L * 1024 * 1024) { "Health outbox full" }
        check((root.listFiles()?.size ?: 0) < 2000) { "Health outbox item limit" }
        val fingerprint = "$endpoint|$credentialIdentity|$workerId|$processingPolicy|$routeProfileId|${config.sourceDeviceId}|$window|" + samples.joinToString("|") { it.id }
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(fingerprint.toByteArray(Charsets.UTF_8))
        val id = "wearable-" + digest.joinToString("") { "%02x".format(it) }
        if (File(root, "$id.json").exists()) return
        val policy = config.policy
        val json = JSONObject().put("id", id).put("endpoint", endpoint).put("capturedAt", System.currentTimeMillis())
            .put("credentialIdentity", credentialIdentity).put("workerId", workerId)
            .put("processingPolicy", processingPolicy).put("routeProfileId", routeProfileId)
            .put("windowStartedAt", window).put("deviceId", config.sourceDeviceId).put("deviceKind", config.sourceDeviceKind)
            .put("deviceName", config.sourceDeviceName)
            .put("policy", JSONObject().put("enabled", policy.enabled).put("high", policy.heartRateHighBpm)
                .put("low", policy.heartRateLowBpm).put("cooldown", policy.heartRateAlertCooldownMinutes)
                .put("sleepAlert", policy.sleepStateAlertEnabled).put("heartStale", policy.heartRateStaleAfterMinutes)
                .put("sleepStale", policy.sleepStateStaleAfterMinutes))
            .put("samples", JSONArray(samples.map { s -> JSONObject().put("id", s.id).put("metric", s.metric)
                .put("recordedAt", s.recordedAt).put("startAt", s.startAt).put("endAt", s.endAt)
                .put("value", s.value ?: JSONObject.NULL).put("unit", s.unit).put("sleepState", s.sleepState)
                .put("sleepStage", s.sleepStage).put("source", s.source) }))
        val file = AtomicFile(File(root, "$id.json"))
        val stream = file.startWrite()
        try { stream.write(json.toString().toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
        catch (error: Throwable) { file.failWrite(stream); throw error }
    }
    fun pending(): List<Entry> = root.listFiles()?.filter { it.extension == "json" || it.extension == "bak" }
        ?.map { if (it.extension == "bak") File(it.path.removeSuffix(".bak")) else it }?.distinctBy { it.path }
        ?.sortedBy { it.lastModified() }?.map { file ->
            val j = JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() })
            val p = j.getJSONObject("policy")
            val config = WearableHealthConfig(true, WearableHealthCollectorMode.HEALTH_CONNECT,
                j.getString("deviceId"), j.getString("deviceName"), j.getString("deviceKind"), 24,
                RabiWearableHealthPolicy(p.getBoolean("enabled"), p.getInt("high"), p.getInt("low"),
                    p.getInt("cooldown"), p.getBoolean("sleepAlert"), p.getInt("heartStale"), p.getInt("sleepStale")), false)
            val array = j.getJSONArray("samples")
            val samples = (0 until array.length()).map { i -> val s = array.getJSONObject(i)
                RabiWearableHealthSample(
                    id = s.getString("id"),
                    metric = s.getString("metric"),
                    recordedAt = s.getString("recordedAt"),
                    startAt = s.getString("startAt"),
                    endAt = s.getString("endAt"),
                    value = if (s.isNull("value")) null else s.getInt("value"),
                    // unit 是后加字段：旧队列文件没有它，缺省由 metric 推导。
                    unit = s.optString("unit", ""),
                    sleepState = s.getString("sleepState"),
                    sleepStage = s.getString("sleepStage"),
                    source = s.getString("source")
                ) }
            Entry(file, j.getString("id"), j.optString("endpoint"), j.optString("credentialIdentity"), j.optString("workerId"),
                j.optString("processingPolicy", "local_only"), j.optString("routeProfileId"), j.getLong("capturedAt"), config, samples)
        } ?: emptyList()
    fun ack(entry: Entry) { AtomicFile(entry.file).delete() }
}
