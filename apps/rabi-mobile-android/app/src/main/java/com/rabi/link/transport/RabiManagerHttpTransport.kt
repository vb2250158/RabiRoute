package com.rabi.link.transport

import android.content.Context
import com.rabi.link.RabiLinkRelayConfig
import com.rabiroute.sdk.RabiLinkManagerHttpResponse
import com.rabiroute.sdk.RabiLinkManagerHttpTransport
import com.rabiroute.sdk.RabiTimeoutSettings
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Application-owned manager connections. The stateless SDK does not own sockets. */
class RabiManagerHttpTransport @JvmOverloads constructor(context: Context,private val delegatedFactory: ((RabiLinkPc)->RabiTunnelDeviceDelegation)? = null) : RabiLinkManagerHttpTransport, AutoCloseable {
    private val application = context.applicationContext
    private val tunnels = ConcurrentHashMap<String,RabiSpeechTunnel>()
    private val timeoutCache = application.getSharedPreferences("manager-timeout-cache", Context.MODE_PRIVATE)
    private val timeouts = ConcurrentHashMap<String, RabiTimeoutSettings>()
    @Volatile private var closed = false
    override fun timeout(relayBaseUrl: String, token: String, key: String, fallback: Long): Long {
        val target = com.rabi.link.recording.TargetWorkerIdentity.load(application,relayBaseUrl,token)
        return ScopedManagerTimeouts(application,com.rabi.link.RabiLinkRelayConfig(relayBaseUrl,token,true),target).get(key,fallback)
    }
    override fun request(relayBaseUrl: String,token: String,target: RabiLinkPc,method: String,path: String,headers: Map<String,String>,body: ByteArray): RabiLinkManagerHttpResponse {
        check(!closed)
        val scope = AsrDirectory.accountIdentity(relayBaseUrl,token) + ':' + target.id
        val tunnel = tunnels.computeIfAbsent(scope) { RabiSpeechTunnel(application,RabiLinkRelayConfig(relayBaseUrl,token,true),target,"manager",delegatedFactory?.invoke(target)) }
        val settings = timeouts.computeIfAbsent(scope) {
            runCatching { RabiTimeoutSettings(JSONObject(timeoutCache.getString(scope, "{}") ?: "{}")) }.getOrDefault(RabiTimeoutSettings())
        }
        try {
            val mutation = method !in listOf("GET","HEAD","OPTIONS")
            fun meta(): JSONObject {
                val value = tunnel.requestHttp("GET","/meta",JSONObject().put("accept","application/json"),ByteArray(0),settings.get("android.manager.identity",12000))
                check(value.status == 200) { "Manager identity unavailable" }
                val document = JSONObject(String(value.body,Charsets.UTF_8))
                check(document.optString("applicationGenerationId").isNotBlank() && document.optString("managerInstanceId").isNotBlank()) { "Manager identity unavailable" }
                val next = RabiTimeoutSettings(document.optJSONObject("timeoutOverrides") ?: JSONObject())
                timeouts[scope] = next
                timeoutCache.edit().putString(scope,next.toJson().toString()).apply()
                return document
            }
            val inputHeaders = JSONObject().apply { headers.forEach { (key,value) -> put(key,value) } }
            val before = if(mutation) meta() else null
            if (!mutation && !timeoutCache.contains(scope)) meta()
            if(before != null) {
                val health = before.getJSONObject("health")
                check(before.optString("applicationGenerationId").isNotBlank() && before.optString("managerInstanceId").isNotBlank()
                    && health.optBoolean("live") && health.optString("state") in listOf("healthy","degraded")) { "Manager is not ready" }
                check(tunnel.delegatedManagerGeneration==null || tunnel.delegatedManagerGeneration==before.getString("applicationGenerationId")) {"Device delegation Manager generation changed"}
                inputHeaders.put("x-rabiroute-expected-application-generation-id",before.getString("applicationGenerationId"))
                inputHeaders.put("x-rabiroute-expected-manager-instance-id",before.getString("managerInstanceId"))
            }
            val response = tunnel.requestHttp(method,path,inputHeaders,body,(timeouts[scope] ?: settings).get("android.manager.request",45000))
            if(before != null) {
                val after = meta()
                check(after.optString("applicationGenerationId") == before.getString("applicationGenerationId") && after.optString("managerInstanceId") == before.getString("managerInstanceId")) { "Write identity is unconfirmed; reconcile the original request" }
            }
            val resultHeaders = response.headers.keys().asSequence().associateWith { response.headers.get(it).toString() }
            return RabiLinkManagerHttpResponse(response.status,resultHeaders,response.body,tunnel.transport,setOf("buffered-http","lan","p2p","relay"))
        } catch(error: Throwable) {
            tunnels.remove(scope)?.close()
            throw error // No replay: a dispatched write may already have committed.
        }
    }
    override fun close() { closed = true; tunnels.values.forEach { it.close() }; tunnels.clear(); timeouts.clear() }
}
