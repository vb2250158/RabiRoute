package com.rabi.link.recording

import android.content.Context
import android.util.AtomicFile
import com.rabi.link.RabiLinkRelayConfig
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiMobileDeviceIdentity
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

/** Read-only PC query plus an account/worker/device-isolated, disposable local view cache. */
class RecordingTranscriptProjection(private val context: Context) {
    data class Scope(val config: RabiLinkRelayConfig, val device: String, val worker: String, val key: String)
    data class Transcript(val id: String, val captureId: String, val text: String, val processedAt: Long)
    data class Snapshot(val fetchedAt: Long, val records: List<Transcript>, val unassigned: Int)
    fun scope(): Scope {
        val config = RabiLinkRelaySettings.load(context)
        check(config.configured) { "未配置电脑连接；转写仅可查看同账号缓存" }
        val worker = TargetWorkerIdentity.load(context, config.baseUrl, config.token)
        check(worker.isNotBlank()) { "尚无已验证的处理电脑，请先在连接设置确认电脑" }
        val device = RabiMobileDeviceIdentity.load(context)
        val identity = listOf(config.baseUrl.trimEnd('/'), config.token, worker, device).joinToString("\n")
        val key = MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
        return Scope(config, device, worker, key)
    }
    fun isCurrent(scope: Scope): Boolean = runCatching { this.scope().key == scope.key }.getOrDefault(false)
    private fun file(scope: Scope) = File(context.filesDir, "recording-transcript-cache/${scope.key}.json")
    fun cached(scope: Scope): Snapshot? {
        val file = file(scope)
        if(!file.exists()) return null
        val root = JSONObject(file.bufferedReader().use { it.readText() })
        check(root.getString("scope") == scope.key) { "转写缓存身份不匹配" }
        val rows = root.getJSONArray("records")
        return Snapshot(root.getLong("fetchedAt"), (0 until rows.length()).map { i ->
            val row = rows.getJSONObject(i)
            Transcript(row.getString("id"), row.getString("captureId"), row.getString("text"), row.optLong("processedAt"))
        }, root.optInt("unassigned"))
    }
    /** Explicit user refresh only. No stream polling or audio reads; queries last 24h, max 200 results. */
    fun refresh(scope: Scope): Snapshot {
        check(isCurrent(scope)) { "账号或电脑已切换，请重新打开时间线" }
        val capabilityRoot = get(scope, CAPABILITIES_PATH)
        check(supportsFencedRecords(capabilityRoot)) { "电脑尚不支持目标身份围栏，未查询转写" }
        val now = System.currentTimeMillis()
        val root = get(scope, "/api/rabilink/speech/v1/records?kind=asr&source_device_id=${URLEncoder.encode(scope.device, "UTF-8")}&since=${now / 1000 - 86400}&limit=200")
        val snapshot = parse(root, scope.device, now)
        check(isCurrent(scope)) { "刷新期间账号或电脑已切换，结果未写入当前缓存" }
        val target = file(scope); check(target.parentFile!!.mkdirs() || target.parentFile!!.isDirectory)
        val rows = JSONArray(); snapshot.records.forEach { rows.put(JSONObject().put("id", it.id).put("captureId", it.captureId).put("text", it.text).put("processedAt", it.processedAt)) }
        val data = JSONObject().put("scope", scope.key).put("fetchedAt", snapshot.fetchedAt).put("unassigned", snapshot.unassigned).put("records", rows)
        val atomic = AtomicFile(target); val out = atomic.startWrite()
        try { out.write(data.toString().toByteArray()); atomic.finishWrite(out) }
        catch(error: Exception) { atomic.failWrite(out); throw error }
        return snapshot
    }
    private fun get(scope: Scope, path: String): JSONObject {
        val connection = URL(scope.config.baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"; connection.connectTimeout = 5000; connection.readTimeout = 15000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("X-RabiLink-Token", scope.config.token)
            connection.setRequestProperty("X-RabiLink-Expected-Worker-Id", scope.worker)
            connection.setRequestProperty("Accept", "application/json")
            val code = connection.responseCode
            check(code in 200..299) { "转写刷新未完成（HTTP $code），保留原缓存" }
            val text = connection.inputStream.bufferedReader().use { reader ->
                val result = StringBuilder(); val buffer = CharArray(4096)
                while(true) { val size = reader.read(buffer); if(size < 0) break; result.append(buffer, 0, size); check(result.length <= 2_000_000) { "转写响应超过安全上限" } }
                result.toString()
            }
            return JSONObject(text)
        } finally { connection.disconnect() }
    }
    companion object {
        const val CAPABILITIES_PATH = "/api/rabilink/speech/v1/capabilities"
        fun supportsFencedRecords(root: JSONObject): Boolean {
            val capabilities = root.optJSONObject("rabilinkAudioStream") ?: root.optJSONObject("data")?.optJSONObject("rabilinkAudioStream")
            return capabilities?.optBoolean("expectedWorkerFencing") == true
        }
        /** captureId is the only association key. Processing timestamps never substitute capture time. */
        fun parse(root: JSONObject, device: String, now: Long): Snapshot {
            val rows = root.optJSONArray("data") ?: root.optJSONArray("records") ?: JSONArray()
            val records = mutableListOf<Transcript>(); var unassigned = 0
            for(i in 0 until rows.length()) {
                val row = rows.optJSONObject(i) ?: continue
                if(row.optString("kind") != "asr") continue
                if(row.optString("source_device_id", row.optString("sourceDeviceId")) != device) continue
                val text = row.optString("text").trim(); if(text.isEmpty()) continue
                val capture = if(row.isNull("captureId")) "" else row.optString("captureId").trim()
                if(capture.isEmpty()) { unassigned++; continue }
                val processed = row.optDouble("processedAt", 0.0) // Contract: Unix seconds; never infer from legacy time.
                val processedMs = if(!processed.isFinite() || processed <= 0) 0L else (processed * 1000).toLong()
                records.add(Transcript(row.optString("id", row.optString("record_id")), capture, text, processedMs))
            }
            return Snapshot(now, records.distinctBy { listOf(it.id, it.captureId, it.processedAt.toString(), it.text) }.sortedBy { it.processedAt }, unassigned)
        }
    }
}
