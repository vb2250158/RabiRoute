package com.rabi.link.transport

import android.content.Context
import com.rabi.link.RabiLinkRelayConfig
import com.rabi.link.RabiMobileDeviceIdentity
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** A single authenticated, reusable speech connection. Connect retries never replay a business request. */
class RabiSpeechTunnel @JvmOverloads constructor(private val context: Context, private val relay: RabiLinkRelayConfig, private val worker: RabiLinkPc, private val service: String = "speech") : AutoCloseable {
    private val device = RabiMobileDeviceIdentity.load(context)
    private val prefs = context.getSharedPreferences("rabi_speech_tunnel",Context.MODE_PRIVATE)
    private val seed = synchronized(RabiSpeechTunnel::class.java) {
        prefs.getString("identitySeed",null)?.let { TunnelCrypto.unb64(it) } ?: ByteArray(32).also {
            SecureRandom().nextBytes(it); check(prefs.edit().putString("identitySeed",TunnelCrypto.b64(it)).commit())
        }
    }
    private val crypto = TunnelCrypto(seed,device,UUID.randomUUID().toString())
    @Volatile private var disposed = false
    private var generation = ""
    @Volatile private var channel: TunnelChannel? = null
    private var cipher: TunnelCrypto.SessionCipher? = null
    var transport: String = ""; private set

    private fun signal(capability: String,operation: String,input: JSONObject): JSONObject {
        val id = UUID.randomUUID().toString()
        val request = JSONObject().put("requestId",id).put("targetDeviceId",worker.id).put("expiresAt",System.currentTimeMillis()+60_000)
            .put("capability",capability).put("operation",operation).put("input",input)
        if(generation.isNotBlank()) request.put("generation",generation)
        val payload = JSONObject().put("targetDeviceId",worker.id).put("packet",TunnelCrypto.peerPacket(request,relay.token))
        val connection = URL(relay.baseUrl.trimEnd('/')+"/api/rabilink/peer/proxy").openConnection() as HttpURLConnection
        val packet = try {
            connection.requestMethod="POST"; connection.connectTimeout=5000; connection.readTimeout=15000; connection.instanceFollowRedirects=false
            connection.setRequestProperty("X-RabiLink-Token",relay.token); connection.setRequestProperty("Content-Type","application/json")
            val bytes=payload.toString().toByteArray(); connection.doOutput=true; connection.setFixedLengthStreamingMode(bytes.size); connection.outputStream.use { it.write(bytes) }
            check(connection.responseCode==200) { "RabiLink handshake unavailable" }
            JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
        } finally { connection.disconnect() }
        val response=TunnelCrypto.openPeer(packet,relay.token); val identity=response.getJSONObject("identity")
        check(response.getString("requestId")==id && identity.getString("deviceId")==worker.id)
        check(generation.isBlank() || generation==identity.getString("generation")) { "Peer generation changed" }
        check(response.optBoolean("ok")) { response.optString("error","Peer handshake denied") }
        generation=identity.getString("generation")
        return response.getJSONObject("data")
    }

    @Synchronized fun connect() {
        check(!disposed) { "Tunnel disposed" }
        if(channel?.closed==false) return
        disconnect(); generation=""
        val scope=TunnelCrypto.hex(MessageDigest.getInstance("SHA-256").digest((relay.baseUrl+"\n"+relay.token+"\n"+worker.id).toByteArray()))
        val trusted=prefs.getString(scope,null)?.trimEnd()?.plus("\n")
        var key=trusted ?: ""
        fun establish(candidate: TunnelChannel,kind: String,timeout: Long) {
            try {
                val handshake=crypto.handshake(worker.id,key)
                candidate.send(handshake.hello.toByteArray())
                val established=handshake.accept(candidate.read(timeout))
                check(!disposed) { "Tunnel disposed" }
                channel=candidate; cipher=established; transport=kind
                if(disposed) { disconnect(); error("Tunnel disposed") }
            } catch(error: Throwable) { candidate.close(); throw error }
        }
        fun tryLan(): Boolean {
        val urls=worker.rawJson.optJSONArray("peerUrls")
        val deadline=System.nanoTime()+2_000_000_000L
        for(index in 0 until minOf(4,urls?.length() ?: 0)) {
            val remaining=(deadline-System.nanoTime())/1_000_000; if(remaining<=0) break
            try {
                val url=URI(urls!!.getString(index)); val parts=url.host.split('.').map { it.toInt() }
                require(url.scheme=="http" && url.userInfo==null && parts.size==4 && parts.all { it in 0..255 })
                require(parts[0]==10 || parts[0]==172 && parts[1] in 16..31 || parts[0]==192 && parts[1]==168 || parts[0]==169 && parts[1]==254)
                establish(TunnelChannel.websocket("ws://${url.rawAuthority}/api/rabilink/peer/tunnel/socket?source=$device",emptyMap(),minOf(remaining,700)),"lan",minOf(remaining,700)); return true
            } catch (_: Exception) { }
        }
        return false
        }
        // A pinned peer can reconnect locally even while the rendezvous server is unavailable.
        if(trusted != null && (service == "speech" || prefs.getBoolean("grant:$scope:$service",false)) && tryLan()) return
        signal("system","describe",JSONObject())
        val identity=signal("transport","tunnel",crypto.bootstrap(worker.id,service))
        key=identity.getString("publicKey")
        check(trusted==null || trusted==key) { "Peer identity changed (${trusted?.length}/${key.length}; ${TunnelCrypto.hex(MessageDigest.getInstance("SHA-256").digest(key.toByteArray())).take(16)})" }
        if(trusted==null) check(prefs.edit().putString(scope,key.trimEnd()).commit())
        check(prefs.edit().putBoolean("grant:$scope:$service",true).commit())
        if(tryLan()) return
        try {
            establish(TunnelChannel.rtc(context) { offer -> signal("transport","tunnel",JSONObject().put("kind","p2p").put("source",device).put("sdp",offer)).getString("sdp") },"p2p",5000); return
        } catch (_: Exception) { }
        val room=UUID.randomUUID().toString()
        signal("transport","tunnel",JSONObject().put("kind","relay").put("source",device).put("room",room))
        val base=URI(relay.baseUrl)
        establish(TunnelChannel.websocket("${if(base.scheme=="https") "wss" else "ws"}://${base.rawAuthority}/api/rabilink/tunnel/socket?room=$room",mapOf("X-RabiLink-Token" to relay.token),5000),"relay",5000)
    }

    data class Response(val status: Int,val body: ByteArray)
    @Synchronized fun request(method: String,path: String,contentType: String,body: ByteArray,timeoutMs: Long=190_000): Response {
        connect()
        val link=channel ?: error("No tunnel"); val encryption=cipher ?: error("No cipher")
        val id=UUID.randomUUID().toString(); var credit=65536; var status=0; var ended=false
        val output=ByteArrayOutputStream(); val deadline=System.nanoTime()+timeoutMs*1_000_000
        fun send(frame: JSONObject) { link.send(encryption.encode(frame)) }
        fun pump() {
            val remaining=(deadline-System.nanoTime())/1_000_000; check(remaining>0) { "Speech request timed out" }
            val frame=encryption.decode(link.read(remaining)); val kind=frame.getString("type")
            if(kind=="ping") { send(JSONObject().put("type","pong").put("id",frame.getString("id"))); return }
            if(frame.optString("id")!=id) return
            when(kind) {
                "window" -> { val bytes=frame.getInt("bytes"); require(bytes>0 && credit+bytes<=65536); credit+=bytes }
                "head" -> status=frame.getJSONObject("head").getInt("status")
                "data" -> {
                    val bytes=TunnelCrypto.unb64(frame.getString("data")); require(bytes.size<=12000 && output.size()+bytes.size<=8*1024*1024)
                    output.write(bytes); send(JSONObject().put("type","window").put("id",id).put("bytes",bytes.size))
                }
                "end" -> ended=true
                "reset" -> error("Speech request rejected")
                else -> error("Invalid tunnel frame")
            }
        }
        try {
            send(JSONObject().put("type","open").put("id",id).put("request",JSONObject().put("service",service).put("method",method).put("path",path).put("headers",JSONObject().put("content-type",contentType))))
            var offset=0
            while(offset<body.size) {
                while(credit==0) pump()
                val size=minOf(12000,credit,body.size-offset); credit-=size
                send(JSONObject().put("type","data").put("id",id).put("data",TunnelCrypto.b64(body.copyOfRange(offset,offset+size)))); offset+=size
            }
            send(JSONObject().put("type","end").put("id",id))
            while(!ended) pump()
            check(status in 100..599); return Response(status,output.toByteArray())
        } catch(error: Throwable) { close(); throw error }
    }
    private fun disconnect() { channel?.close(); channel=null; cipher=null; transport="" }
    override fun close() { disposed=true; disconnect() }
}
