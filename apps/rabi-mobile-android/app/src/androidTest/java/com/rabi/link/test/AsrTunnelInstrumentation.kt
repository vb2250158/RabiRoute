package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.transport.RabiSpeechTunnel
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject

/** Explicit device acceptance: synthetic silent WAV, never reads microphone or existing recordings. */
class AsrTunnelInstrumentation : Instrumentation() {
    private var forceRelay=false
    private var skipLan=false
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); skipLan=arguments.getString("skipLan")=="true"; forceRelay=arguments.getString("forceRelay")=="true"; start() }
    override fun onStart() {
        val result=Bundle(); var code=Activity.RESULT_OK
        try {
            val relay=RabiLinkRelaySettings.load(targetContext)
            val worker=RabiRouteSdk().mobileAsrSettings(relay.baseUrl,relay.token).workers.first { it.online }
            if(skipLan) worker.rawJson.put("peerUrls",org.json.JSONArray())
            RabiSpeechTunnel(targetContext,relay,worker).use { tunnel ->
                if(forceRelay) {
                    // Exercise the real relay transport without changing production connection policy.
                    val signal=tunnel.javaClass.getDeclaredMethod("signal",String::class.java,String::class.java,JSONObject::class.java).apply { isAccessible=true }
                    fun exchange(capability: String,operation: String,input: JSONObject) = signal.invoke(tunnel,capability,operation,input) as JSONObject
                    exchange("system","describe",JSONObject())
                    val crypto=tunnel.javaClass.getDeclaredField("crypto").apply { isAccessible=true }.get(tunnel) as com.rabi.link.transport.TunnelCrypto
                    val identity=exchange("transport","tunnel",crypto.bootstrap(worker.id))
                    val room=java.util.UUID.randomUUID().toString()
                    val device=com.rabi.link.RabiMobileDeviceIdentity.load(targetContext)
                    exchange("transport","tunnel",JSONObject().put("kind","relay").put("source",device).put("room",room))
                    val uri=java.net.URI(relay.baseUrl)
                    val channel=com.rabi.link.transport.TunnelChannel.websocket("${if(uri.scheme=="https") "wss" else "ws"}://${uri.rawAuthority}/api/rabilink/tunnel/socket?room=$room",mapOf("X-RabiLink-Token" to relay.token),5000)
                    try {
                        val handshake=crypto.handshake(worker.id,identity.getString("publicKey"))
                        channel.send(handshake.hello.toByteArray())
                        val cipher=handshake.accept(channel.read(5000))
                        for((name,value) in listOf("channel" to channel,"cipher" to cipher,"transport" to "relay")) tunnel.javaClass.getDeclaredField(name).apply { isAccessible=true }.set(tunnel,value)
                    } catch(error: Throwable) { channel.close(); throw error }
                }
                val capabilities=tunnel.request("GET","/v1/capabilities","application/json",byteArrayOf())
                check(capabilities.status==200)
                result.putString("transport",tunnel.transport)
                val wav=java.nio.ByteBuffer.allocate(32044).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                wav.put("RIFF".toByteArray()).putInt(32036).put("WAVEfmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(16000).putInt(32000).putShort(2).putShort(16).put("data".toByteArray()).putInt(32000)
                val body="--test\r\nContent-Disposition: form-data; name=\"file\"; filename=\"silence.wav\"\r\nContent-Type: audio/wav\r\n\r\n".toByteArray()+wav.array()+"\r\n--test--\r\n".toByteArray()
                val response=tunnel.request("POST","/v1/audio/transcriptions","multipart/form-data; boundary=test",body)
                check(response.status==200) { "ASR HTTP ${response.status}" }
                check(JSONObject(response.body.toString(Charsets.UTF_8)).has("text"))
                result.putString("result","PASS: authenticated speech tunnel and WAV transcription")
            }
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finish(code,result)
    }
}
