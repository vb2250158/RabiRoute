package com.rabi.link.transport

import android.content.Context
import com.rabi.link.RabiLinkRelayConfig
import com.rabiroute.sdk.RabiLinkManagerHttpResponse
import com.rabiroute.sdk.RabiLinkManagerHttpTransport
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/** Application-owned manager connections. The stateless SDK does not own sockets. */
class RabiManagerHttpTransport @JvmOverloads constructor(context: Context,private val delegatedFactory: ((RabiLinkPc)->RabiTunnelDeviceDelegation)? = null) : RabiLinkManagerHttpTransport, AutoCloseable {
    private val application = context.applicationContext
    private val tunnels = ConcurrentHashMap<String,RabiSpeechTunnel>()
    @Volatile private var closed = false
    override fun request(relayBaseUrl: String,token: String,target: RabiLinkPc,method: String,path: String,headers: Map<String,String>,body: ByteArray): RabiLinkManagerHttpResponse {
        check(!closed)
        val scope = AsrDirectory.accountIdentity(relayBaseUrl,token) + ':' + target.id
        val tunnel = tunnels.computeIfAbsent(scope) { RabiSpeechTunnel(application,RabiLinkRelayConfig(relayBaseUrl,token,true),target,"manager",delegatedFactory?.invoke(target)) }
        try {
            val mutation = method !in listOf("GET","HEAD","OPTIONS")
            fun meta(): JSONObject {
                val value = tunnel.requestHttp("GET","/meta",JSONObject().put("accept","application/json"),ByteArray(0),12000)
                check(value.status == 200) { "Manager identity unavailable" }
                return JSONObject(String(value.body,Charsets.UTF_8))
            }
            val inputHeaders = JSONObject().apply { headers.forEach { (key,value) -> put(key,value) } }
            val before = if(mutation) meta() else null
            if(before != null) {
                val health = before.getJSONObject("health")
                check(before.optString("applicationGenerationId").isNotBlank() && before.optString("managerInstanceId").isNotBlank()
                    && health.optBoolean("live") && health.optBoolean("requiredReady") && health.optString("state") in listOf("healthy","degraded")) { "Manager is not ready" }
                check(tunnel.delegatedManagerGeneration==null || tunnel.delegatedManagerGeneration==before.getString("applicationGenerationId")) {"Device delegation Manager generation changed"}
                inputHeaders.put("x-rabiroute-expected-application-generation-id",before.getString("applicationGenerationId"))
                inputHeaders.put("x-rabiroute-expected-manager-instance-id",before.getString("managerInstanceId"))
            }
            val response = tunnel.requestHttp(method,path,inputHeaders,body,45000)
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
    override fun close() { closed = true; tunnels.values.forEach { it.close() }; tunnels.clear() }
}
