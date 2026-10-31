package com.rabi.link.modules.rokid

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.rabi.link.BuildConfig
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.protocol.RabiAiuiWakeProbeProtocol
import com.rabi.link.protocol.RabiGlassVideoProtocol
import com.rabiroute.sdk.RabiLinkManagerHttpTransport
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.function.Supplier

/** Consumes PC wake metadata only. This class never receives prompts or executes a model. */
class RabiDeviceAgentWakeConsumer(context: Context, private val controller: Supplier<RokidCxrController?>, managerTransport: RabiLinkManagerHttpTransport,
    private val onState:java.util.function.Consumer<String>) : AutoCloseable {
    private val app=context.applicationContext
    private val main=Handler(Looper.getMainLooper())
    private val worker=Executors.newSingleThreadExecutor()
    private val sdk=RabiRouteSdk(managerTransport=managerTransport)
    private val journal=app.getSharedPreferences("device_agent_wake_v1",Context.MODE_PRIVATE)
    @Volatile private var closed=false
    @Volatile private var generation=0
    @Volatile private var activeScope=""
    private data class Pending(val nonce:String,val done:CountDownLatch=CountDownLatch(1),@Volatile var result:String="dispatch_timeout")
    @Volatile private var pending:Pending?=null

    @Synchronized fun onConnectionAvailable() {
        if(closed)return
        val config=RabiLinkRelaySettings.load(app)
        if(!config.configured)return
        val scope=RabiGlassStatusPublisher.identity(config.baseUrl,config.token)
        if(scope==activeScope)return
        activeScope=scope;val current=++generation
        worker.execute {
            try {
                val devices=sdk.getDeviceConnections(config.baseUrl,config.token).getJSONArray("devices")
                while(!closed && generation==current) {
                    if(devices.length()==0)break
                    for(index in 0 until devices.length()) {
                        if(closed || generation!=current)break
                        val device=devices.getJSONObject(index)
                        val agentId=device.getString("id")
                        val owner=device.getString("connectionTargetDeviceId")
                        val base="/api/device-agents/"+java.net.URLEncoder.encode(agentId,"UTF-8")
                        val response=sdk.requestMobileManager(config.baseUrl,config.token,owner,base+"/wake-requests?waitMs=12000")
                        val requests=response.getJSONObject("data").getJSONArray("requests")
                        for(rowIndex in 0 until requests.length()) {
                            val nonce=requests.getJSONObject(rowIndex).getString("nonce")
                            val key=scope+":"+nonce
                            if(journal.contains(key))continue
                            if(!RabiAiuiWakeProbeProtocol.validRequestId(nonce))throw IllegalStateException("DEVICE_AGENT_WAKE_NONCE_INVALID")
                            if(!journal.edit().putString(key,"claim-intent").commit())throw IllegalStateException("DEVICE_AGENT_WAKE_JOURNAL_FAILED")
                            val claim=sdk.requestMobileManager(config.baseUrl,config.token,owner,base+"/wake-requests/"+nonce+"/claim","POST","{}",operationId="device-wake:"+nonce+":claim").getJSONObject("data")
                            val result=dispatch(nonce, com.rabi.link.transport.ScopedManagerTimeouts(app,config,owner).get("android.device.wake",15000)) {
                                val fresh=RabiLinkRelaySettings.load(app)
                                !closed && generation==current && fresh.configured && RabiGlassStatusPublisher.identity(fresh.baseUrl,fresh.token)==scope
                            }
                            main.post {if(!closed)onState.accept(if(result=="dispatch_security_rejected")"眼镜系统拒绝唤醒指令；原任务保留" else "唤醒阶段："+result+"；等待眼镜 Agent 领取")}
                            val submitted=result=="broadcast_finished" || result=="duplicate_suppressed"
                            val receipt=JSONObject().put("claimToken",claim.getString("claimToken")).put("status",if(submitted)"submitted" else "failed")
                            if(!submitted)receipt.put("errorCode",result)
                            journal.edit().putString(key,"receipt-intent:"+result).commit()
                            sdk.requestMobileManager(config.baseUrl,config.token,owner,base+"/wake-requests/"+nonce+"/receipt","POST",receipt.toString(),operationId="device-wake:"+nonce+":receipt")
                            journal.edit().putString(key,"settled:"+result).commit()
                        }
                    }
                }
            } catch(_:Exception) {
                main.post {if(!closed)onState.accept("唤醒链路未确认；原请求保留，联网后仅重新接收新请求")}
                // Original nonce remains recorded. Restoration may query receipts, never resend gestures.
            } finally { synchronized(this) {if(generation==current)activeScope=""} }
        }
    }

    private fun dispatch(nonce:String,timeoutMs:Long,stillAuthorized:()->Boolean):String {
        val blocked="security-rejected:"+BuildConfig.VERSION_NAME
        if(journal.getBoolean(blocked,false))return "dispatch_security_rejected"
        val state=Pending(nonce);pending=state
        main.post {
            if(!stillAuthorized()) {state.result="connection_scope_changed";state.done.countDown();return@post}
            val link=controller.get()
            if(link==null || !link.isLinkReady) {state.result="cxr_not_connected";state.done.countDown();return@post}
            if(!link.sendVideoCommand(RabiAiuiWakeProbeProtocol.command(nonce))) {state.result="dispatch_failed";state.done.countDown()}
        }
        try {state.done.await(timeoutMs,TimeUnit.MILLISECONDS)} catch(_:InterruptedException) {Thread.currentThread().interrupt()}
        if(pending===state)pending=null
        if(state.result=="dispatch_security_rejected")journal.edit().putBoolean(blocked,true).commit()
        return state.result
    }

    fun onProtocol(raw:String?,clientId:String?) {
        val state=pending ?: return
        if(clientId!=RabiGlassVideoProtocol.REPLY)return
        val result=RabiAiuiWakeProbeProtocol.receiptState(raw,state.nonce)
        if(result.isEmpty() || result=="broadcast_submitted")return
        state.result=result;state.done.countDown()
    }
    override fun close() {closed=true;generation++;pending?.done?.countDown();worker.shutdown()}
}
