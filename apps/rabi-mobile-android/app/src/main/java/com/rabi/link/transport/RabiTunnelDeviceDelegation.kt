package com.rabi.link.transport

import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A device credential renews its own key lease through Relay; a phone grant never substitutes for it. */
class RabiTunnelDeviceDelegation internal constructor(
    val sourceDeviceId: String,
    val targetDeviceId: String,
    internal val seed: ByteArray,
    private val register: (JSONObject) -> JSONObject,
    private val assertCurrent: () -> Unit,
    private val now: () -> Long = System::currentTimeMillis
) : AutoCloseable {
    data class Grant(val publicKey: String,val generation: String,val managerGeneration: String,val expiresAt: Long,val epoch: String)
    @Volatile private var current: Grant? = null
    @Volatile private var closed=false
    private val renewer=Executors.newSingleThreadScheduledExecutor { work->Thread(work,"rabi-eye-grant").apply{isDaemon=true} }
    /** Each success arms exactly one successor, timed from the lease it just obtained. */
    private fun rearm() {
        if(closed) return
        val lease=current
        val delayMs=if(lease==null)10_000L else maxOf(1_000L,lease.expiresAt-now()-15_000L)
        renewer.schedule({
            try { if(!closed) grant() } catch(_:Throwable) { current=null }
            rearm()
        },delayMs,TimeUnit.MILLISECONDS)
    }
    init {require(sourceDeviceId.startsWith("glasses-") && seed.size==32)
        rearm()
    }
    @Synchronized internal fun grant(): Grant {
        check(!closed) {"DEVICE_DELEGATION_CLOSED"};assertCurrent()
        current?.takeIf{it.expiresAt-now()>15000}?.let{return it}
        val crypto=TunnelCrypto(seed,sourceDeviceId,"device-delegation");val expiry=now()+40000
        val packet=crypto.deviceBootstrap(targetDeviceId,expiry,UUID.randomUUID().toString())
        try {
            val reply=register(packet);assertCurrent()
            check(reply.getString("sourceDeviceId")==sourceDeviceId && reply.getString("deviceId")==targetDeviceId) {"DEVICE_DELEGATION_IDENTITY_CHANGED"}
            val grant=Grant(reply.getString("publicKey"),reply.getString("generation"),reply.getString("managerGeneration"),reply.getLong("expiresAt"),reply.getString("epoch"))
            check(grant.publicKey.isNotBlank() && grant.generation.isNotBlank() && grant.managerGeneration.isNotBlank() && grant.epoch.isNotBlank()
                && grant.expiresAt<=expiry && grant.expiresAt>now()) {"DEVICE_DELEGATION_INVALID"}
            current=grant;return grant
        }catch(error:Throwable){current=null;throw error}
    }
    internal fun assertLease(epoch: String) {assertCurrent();val lease=current;check(!closed && lease!=null && lease.epoch==epoch && lease.expiresAt>now()) {"DEVICE_DELEGATION_EXPIRED_OR_CHANGED"}}
    override fun close(){closed=true;current=null;renewer.shutdownNow()}
}
