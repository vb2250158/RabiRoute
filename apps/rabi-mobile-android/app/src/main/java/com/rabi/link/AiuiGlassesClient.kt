package com.rabi.link

import org.json.JSONArray
import org.json.JSONObject
import android.content.Context
import com.rabi.link.transport.RabiManagerHttpTransport
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiRouteSdk
import java.net.URLEncoder
import java.security.MessageDigest

/** Business requests belong to a PC and use the same LAN -> P2P -> Relay tunnel as audio. */
class AiuiGlassesClient(private val context: Context, val connection: RabiLinkRelayConfig) : AutoCloseable {
    val scope: String = accountScope(connection)
    private val sdk = RabiRouteSdk()
    private val transport = RabiManagerHttpTransport(context.applicationContext)
    private var directory: List<RabiLinkPc>? = null
    private var selectedPc = ""
    @Volatile private var closed = false
    @Synchronized fun computers(): List<RabiLinkPc> {
        check(!closed)
        val state = sdk.getMobileState(connection.baseUrl, connection.token)
        directory = state.workers; selectedPc = state.selectedTargetDeviceId
        return state.workers
    }
    fun defaultTarget(): String { if(directory == null) computers(); return selectedPc.ifBlank { directory?.singleOrNull()?.id.orEmpty() }.also { check(it.isNotBlank()) { "请选择配置所在电脑" } } }
    @Synchronized fun request(targetDeviceId: String, path: String, method: String = "GET", body: JSONObject? = null, headers: JSONObject = JSONObject()): JSONObject {
        check(connection.configured) { "请先在 RabiLink 连接电脑" }
        check(!closed) { "Connection closed" }
        if(directory == null) computers()
        val worker = directory!!.firstOrNull { it.id == targetDeviceId } ?: error("目标电脑不在已鉴权连接目录")
        val inputHeaders = JSONObject(headers.toString()).put("accept", "application/json").put("content-type", "application/json; charset=utf-8")
        val reply = transport.request(connection.baseUrl,connection.token,worker,method,path,inputHeaders.keys().asSequence().associateWith { inputHeaders.getString(it) },body?.toString()?.toByteArray(Charsets.UTF_8) ?: ByteArray(0))
        check(reply.body.size <= 2 * 1024 * 1024) { "响应过大，请缩小查询范围" }
        val json = runCatching { JSONObject(String(reply.body,Charsets.UTF_8)) }.getOrNull()
        check(reply.statusCode in 200..299 && json != null && json.optInt("code",0) == 0 && json.optBoolean("ok",true)) { "请求未确认，请检查连接后刷新（HTTP ${reply.statusCode}）" }
        return json.optJSONObject("data") ?: json
    }
    fun devices(): JSONObject {
        val rows = JSONArray()
        val workers = computers()
        val roster = sdk.getDeviceConnections(connection.baseUrl,connection.token).optJSONArray("devices") ?: JSONArray()
        for(index in 0 until roster.length()) {
            val device = JSONObject(roster.getJSONObject(index).toString())
            val owner = device.optString("connectionTargetDeviceId")
            device.put("ownerDeviceId",owner)
            if(workers.any { it.id == owner && it.online }) {
                val current = profile(owner,device.getString("id"))
                current.keys().forEach { key -> device.put(key,current.get(key)) }
            } else device.put("ownerUnavailable",true)
            rows.put(device)
        }
        return JSONObject().put("devices",rows)
    }
    fun personas(sourceDeviceId: String) = request(sourceDeviceId,"/api/personas")
    fun skills(sourceDeviceId: String,roleId: String) = request(sourceDeviceId,"/api/roles/" + encode(roleId) + "/skills")
    fun profile(ownerDeviceId: String,bindingId: String) = request(ownerDeviceId,"/api/rabilink/agent-devices/" + encode(bindingId) + "/profile")
    fun template(sourceDeviceId: String,roleId: String,skills: List<String> = emptyList()): JSONObject = request(sourceDeviceId,"/api/rabilink/persona-template","POST",JSONObject().put("roleId",roleId).put("skillIds",JSONArray(skills))).getJSONObject("profile")
    fun operation(ownerDeviceId: String,bindingId: String,key: String) = request(ownerDeviceId,"/api/rabilink/agent-devices/" + encode(bindingId) + "/profile/operations/" + encode(key))
    fun saveProfile(ownerDeviceId: String,input: JSONObject): JSONObject = request(ownerDeviceId,"/api/rabilink/agent-devices/" + encode(input.getString("bindingId")) + "/profile","PUT",
        JSONObject().put("expectedRevision",input.getInt("expectedRevision")).put("idempotencyKey",input.getString("idempotencyKey")).put("profile",input.getJSONObject("profile")),JSONObject().put("Idempotency-Key",input.getString("idempotencyKey")))
    data class HistoryMessage(val id: String, val role: String, val text: String, val conversationId: String, val name: String, val receivedAt: String)
    fun history(routeIds: Map<String, String>, routeSourceId: String): List<HistoryMessage> {
        val source = devices()
        val roles = linkedMapOf<Pair<String,String>, String>()
        val devices = source.optJSONArray("devices") ?: JSONArray()
        for (index in 0 until devices.length()) {
            val device = devices.getJSONObject(index)
            val profiles = device.optJSONArray("historyPersonas") ?: JSONArray()
            device.optJSONObject("profile")?.optJSONObject("personaRef")?.let { ref -> profiles.put(JSONObject(ref.toString()).put("name", device.getJSONObject("profile").optString("name"))) }
            for (item in 0 until profiles.length()) {
                val ref = profiles.getJSONObject(item)
                val sourcePc = ref.optString("sourceDeviceId")
                if (sourcePc.isNotBlank()) roles[sourcePc to ref.getString("roleId")] = ref.optString("name", ref.getString("roleId"))
            }
        }
        val result = mutableListOf<HistoryMessage>()
        for ((reference, name) in roles) {
            val (sourcePc, roleId) = reference
            var cursor: String? = null
            var pages = 0
            while (pages++ < 10) {
                val page = request(sourcePc,"/api/roles/" + encode(roleId) + "/chat-history" + (cursor?.let { "?cursor=" + encode(it) } ?: ""))
                val rows = page.optJSONArray("entries") ?: JSONArray()
                for (i in 0 until rows.length()) {
                    val row = rows.getJSONObject(i); val kind = row.optString("kind")
                    if (kind == "aiui_user" || kind == "aiui_assistant") result.add(HistoryMessage(
                        "aiui:$sourcePc:$roleId:" + row.getString("id"), if (kind == "aiui_user") "user" else "assistant", row.getString("text"),
                        (if(sourcePc == routeSourceId) routeIds[roleId] else null) ?: "aiui:$sourcePc:$roleId", name, row.getString("receivedAt")))
                }
                cursor = if (page.isNull("nextCursor")) null else page.optString("nextCursor").takeIf { it.isNotBlank() }
                if (cursor == null) break
            }
        }
        return result.distinctBy { it.id }.sortedBy { it.receivedAt }
    }
    override fun close() { closed = true; transport.close() }
    companion object {
        fun accountScope(connection: RabiLinkRelayConfig): String = MessageDigest.getInstance("SHA-256").digest((connection.baseUrl + "\u0000" + connection.token).toByteArray()).joinToString("") { "%02x".format(it) }
        fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")
        fun sameJson(left: Any?, right: Any?): Boolean = when {
            left is JSONObject && right is JSONObject -> left.keys().asSequence().toSet() == right.keys().asSequence().toSet() && left.keys().asSequence().all { sameJson(left.get(it), right.get(it)) }
            left is JSONArray && right is JSONArray -> left.length() == right.length() && (0 until left.length()).all { sameJson(left.get(it), right.get(it)) }
            else -> left == right
        }
    }
}
