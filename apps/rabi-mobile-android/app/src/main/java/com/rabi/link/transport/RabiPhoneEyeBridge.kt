package com.rabi.link.transport

import android.content.Context
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.RabiLinkRelayConfig
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.NetworkInterface
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** Connection owner only: paired Eye credential/key never enter persona or model context. */
class RabiPhoneEyeBridge(private val context:Context):AutoCloseable {
    private val config=RabiLinkRelaySettings.load(context)
    private val prefs=context.getSharedPreferences("rabi_eye_connection",Context.MODE_PRIVATE)
    private val sdk=RabiRouteSdk()
    private var pairing=secret()
    private var pairingExpiry=System.currentTimeMillis()+300000
    private val sessions=java.util.concurrent.ConcurrentHashMap<String,Session>()
    private val journals=java.util.concurrent.ConcurrentHashMap<String,PhoneOperationJournal>()
    private val server=PhoneEyeHttpServer({request,response->
        if(request.path=="/session" || request.path=="/session/renew" || request.path=="/manager-http") {
            val result=handle(request.path,request.headers,JSONObject(request.body.bufferedReader().readText()))
            val bytes=result.toString().toByteArray();response.begin(200,mapOf("content-type" to "application/json"),bytes.size.toLong());response.write(bytes);response.end()
        }else stream(request,response,false)
    },{request,response->stream(request,response,true)}, {ScopedManagerTimeouts.active(context).get("android.phone.incoming",15000)})
    private data class Session(val device:String,val deviceToken:String,val seed:ByteArray,val access:String,val lease:PhoneEyeSessionLease,val transport:RabiManagerHttpTransport,val operations:PhoneOperationJournal) {val expiresAt:Long get()=lease.expiresAt}
    @Synchronized fun connectionInfo():JSONObject {
        current();pairing=secret();pairingExpiry=System.currentTimeMillis()+300000
        val addresses=NetworkInterface.getNetworkInterfaces().toList().flatMap{it.inetAddresses.toList()}.filter{!it.isLoopbackAddress && it.isSiteLocalAddress && it is java.net.Inet4Address}.map{"http://${it.hostAddress}:${server.port}"}
        return JSONObject().put("urls",org.json.JSONArray(addresses)).put("pairingCode",pairing).put("expiresAt",pairingExpiry)
    }
    private fun current(){check(RabiLinkRelaySettings.load(context).let{it.baseUrl==config.baseUrl && it.token==config.token}){"PHONE_CONNECTION_CHANGED"}}
    fun isCurrent():Boolean=runCatching{current();true}.getOrDefault(false)
    @Synchronized private fun handle(path:String,headers:Map<String,String>,body:JSONObject):JSONObject {
        current()
        if(path=="/session") {
            check(System.currentTimeMillis()<pairingExpiry && equal(headers["x-rabi-pairing"].orEmpty(),pairing))
            val deviceToken=body.getString("deviceToken")
            PhoneEyeSessionLease.requireDeviceCredential(deviceToken)
            val directory=sdk.getDeviceConnections(config.baseUrl,deviceToken).getJSONArray("devices")
            check(directory.length()==1)
            val device=directory.getJSONObject(0).getString("id");check(device.matches(Regex("glasses-[a-f0-9]{16}")))
            if(body.has("sourceDeviceId"))check(body.getString("sourceDeviceId")==device)
            current();check(System.currentTimeMillis()<pairingExpiry && equal(headers["x-rabi-pairing"].orEmpty(),pairing)){"PHONE_PAIRING_AUTHORITY_CHANGED"}
            val identity=hash(config.baseUrl.trimEnd('/')+"\n"+device)
            val seed=prefs.getString(identity,null)?.let{TunnelCrypto.unb64(it)} ?: ByteArray(32).also{SecureRandom().nextBytes(it);check(prefs.edit().putString(identity,TunnelCrypto.b64(it)).commit())}
            val access=secret()
            lateinit var paired:Session
            val transport=RabiManagerHttpTransport(context) {target->RabiTunnelDeviceDelegation(device,target.id,seed,{packet->register(deviceToken,target.id,packet)},{current();check(sessions[access]===paired && paired.expiresAt>System.currentTimeMillis())})}
            sessions.values.filter{it.device==device}.forEach{it.transport.close()};sessions.entries.removeAll{it.value.device==device}
            val operationKey="operations:"+identity
            val journal=journals.computeIfAbsent(identity){PhoneOperationJournal(JSONObject(prefs.getString(operationKey,"{}")!!),{rows->check(prefs.edit().putString(operationKey,rows.toString()).commit())})}
            val lease=PhoneEyeSessionLease({current();check(sessions[access]===paired)},{PhoneEyeSessionLease.requireDeviceCredential(deviceToken);val devices=sdk.getDeviceConnections(config.baseUrl,deviceToken).getJSONArray("devices");check(devices.length()==1 && devices.getJSONObject(0).getString("id")==device){"PHONE_DEVICE_AUTHORITY_CHANGED"}})
            paired=Session(device,deviceToken,seed,access,lease,transport,journal);sessions[access]=paired
            return JSONObject().put("code",0).put("data",JSONObject().put("sourceDeviceId",device).put("accessToken",access).put("expiresAt",sessions[access]!!.expiresAt).put("capabilities",caps("",device)))
        }
        val access=headers["authorization"].orEmpty().removePrefix("Bearer ");val session=sessions[access] ?: error("PHONE_BRIDGE_PAIRING_REQUIRED")
        session.lease.assertCurrent()
        if(path=="/session/renew") {
            try{session.lease.renew()}catch(error:Exception){sessions.remove(access,session);session.transport.close();throw error}
            return JSONObject().put("code",0).put("data",JSONObject().put("sourceDeviceId",session.device).put("expiresAt",session.expiresAt))
        }
        check(path=="/manager-http")
        val targetId=body.getString("targetDeviceId");val request=body.getJSONObject("request")
        val target=sdk.getMobileState(config.baseUrl,config.token).workers.single{it.id==targetId}
        val method=request.getString("method").uppercase();val mutation=method !in listOf("GET","HEAD","OPTIONS")
        val operation=request.optString("operationId")
        val fingerprint=hash(body.toString())
        if(mutation)session.operations.begin(operation,fingerprint)?.let{return it}
        val result=try {
            val requestHeaders=request.optJSONObject("headers") ?: JSONObject()
            if(request.has("body") && request.get("body") !is String && !requestHeaders.has("content-type"))requestHeaders.put("content-type","application/json")
            val bytes=if(request.has("bodyBase64"))TunnelCrypto.unb64(request.getString("bodyBase64")) else if(request.has("body"))request.get("body").let{if(it is String)it else it.toString()}.toString().toByteArray() else ByteArray(0)
            val response=session.transport.request(config.baseUrl,config.token,target,method,request.getString("path"),requestHeaders.keys().asSequence().associateWith{requestHeaders.getString(it)},bytes)
            current()
            val receipt=JSONObject().put("ok",response.statusCode in 200..299).put("uncertain",mutation && response.statusCode>=500).put("statusCode",response.statusCode).put("operationId",operation).put("headers",JSONObject(response.headers)).put("bodyBase64",TunnelCrypto.b64(response.body))
            runCatching{receipt.put("data",org.json.JSONTokener(String(response.body,Charsets.UTF_8)).nextValue())}.getOrElse{receipt.put("data",String(response.body,Charsets.UTF_8))}
            JSONObject().put("code",0).put("data",JSONObject().put("structuredContent",receipt).put("transportCapabilities",caps(response.transport,session.device)))
        }catch(_:Exception){JSONObject().put("code",0).put("data",JSONObject().put("structuredContent",JSONObject().put("ok",false).put("uncertain",mutation).put("operationId",operation).put("code","MANAGER_REQUEST_UNCONFIRMED")))}
        if(mutation)session.operations.settle(operation,result,!result.getJSONObject("data").getJSONObject("structuredContent").optBoolean("uncertain"))
        return result
    }
    private fun stream(request:PhoneEyeHttpServer.Request,response:PhoneEyeHttpServer.ResponseSink,upgrade:Boolean) {
        current();check(request.path==if(upgrade)"/manager-ws" else "/manager-stream")
        val session=synchronized(this){sessions[request.headers["authorization"].orEmpty().removePrefix("Bearer ")] ?: error("PHONE_BRIDGE_PAIRING_REQUIRED")}
        check(session.expiresAt>System.currentTimeMillis())
        val targetId=request.headers["x-rabi-manager-target"] ?: error("TARGET_REQUIRED")
        val path=request.headers["x-rabi-manager-path"] ?: error("PATH_REQUIRED")
        val method=(if(upgrade)"GET" else request.headers["x-rabi-manager-method"] ?: request.method).uppercase()
        val target=sdk.getMobileState(config.baseUrl,config.token).workers.single{it.id==targetId}
        val forwarded=request.headers.filterKeys{it !in setOf("authorization","host","connection","upgrade","content-length","transfer-encoding") && !it.startsWith("x-rabi-manager-")}
        val mutation=(upgrade && forwarded.containsKey("idempotency-key")) || method !in listOf("GET","HEAD","OPTIONS")
        val operation=if(mutation)forwarded["idempotency-key"] ?: error("OPERATION_REQUIRED") else ""
        current();check(sessions[session.access]===session && session.expiresAt>System.currentTimeMillis())
        if(mutation)check(session.operations.begin(operation,hash(targetId+"\n"+method+"\n"+path+"\n"+JSONObject().apply{forwarded.toSortedMap().forEach{(key,value)->put(key,value)}}))==null){"STREAM_ALREADY_DISPATCHED"}
        val delegation=RabiTunnelDeviceDelegation(session.device,targetId,session.seed,{packet->register(session.deviceToken,targetId,packet)},{current();check(sessions[session.access]===session && session.expiresAt>System.currentTimeMillis())})
        RabiSpeechTunnel(context,RabiLinkRelayConfig(config.baseUrl,config.token,true),target,"manager",delegation).use{tunnel->
            val forwardedHeaders=JSONObject(forwarded)
            var originalMeta:JSONObject?=null;var streamStatus=0
            if(mutation){val meta=tunnel.requestHttp("GET","/meta",JSONObject(),ByteArray(0),ScopedManagerTimeouts(context,config,targetId).get("android.manager.identity",12000));check(meta.status==200);val value=JSONObject(String(meta.body));val health=value.getJSONObject("health");check(value.getString("applicationGenerationId")==tunnel.delegatedManagerGeneration && value.getString("managerInstanceId").isNotBlank() && health.getBoolean("live") && health.getString("state") in listOf("healthy","degraded"));originalMeta=value;forwardedHeaders.put("x-rabiroute-expected-application-generation-id",value.getString("applicationGenerationId")).put("x-rabiroute-expected-manager-instance-id",value.getString("managerInstanceId"))}
            tunnel.streamHttp(method,path,forwardedHeaders,request.body,upgrade,{status,headers->streamStatus=status;response.begin(status,headers.keys().asSequence().associateWith{headers.get(it).toString()})},{bytes->response.write(bytes)})
            if(originalMeta!=null){val after=tunnel.requestHttp("GET","/meta",JSONObject(),ByteArray(0),ScopedManagerTimeouts(context,config,targetId).get("android.manager.identity",12000));check(after.status==200);val value=JSONObject(String(after.body));check(value.getString("applicationGenerationId")==originalMeta.getString("applicationGenerationId") && value.getString("managerInstanceId")==originalMeta.getString("managerInstanceId"))}
            response.end()
            if(mutation && (streamStatus in 200..499 || upgrade && streamStatus==101))session.operations.settle(operation,PhoneOperationJournal.receipt(operation,false,"HTTP_ORIGINAL_STREAM_COMPLETED"),true)
        }
    }
    private fun register(deviceToken:String,target:String,packet:JSONObject):JSONObject {
        current()
        val request=JSONObject().put("method","POST").put("path","/api/rabilink/peer/device-bootstrap").put("body",packet).put("operationId","eye-grant:"+packet.getString("nonce"))
        val connection=URL(config.baseUrl.trimEnd('/')+"/api/rabilink/device/api").openConnection() as HttpURLConnection
        val reply=try{connection.requestMethod="POST";connection.instanceFollowRedirects=false;connection.connectTimeout=ScopedManagerTimeouts(context,config,target).get("android.phone.connect",5000).toInt();connection.readTimeout=ScopedManagerTimeouts(context,config,target).get("android.phone.request",30000).toInt();connection.setRequestProperty("X-Rabi-Timeout-Ms",connection.readTimeout.toString());connection.setRequestProperty("X-RabiLink-Token",deviceToken);connection.setRequestProperty("Content-Type","application/json");connection.doOutput=true;val bytes=JSONObject().put("targetDeviceId",target).put("request",request).toString().toByteArray();connection.setFixedLengthStreamingMode(bytes.size);connection.outputStream.use{it.write(bytes)};check(connection.responseCode==200);JSONObject(connection.inputStream.bufferedReader().use{it.readText()})}finally{connection.disconnect()}
        current();check(reply.getInt("code")==0);val receipt=reply.getJSONObject("data").getJSONObject("structuredContent");check(receipt.getBoolean("ok") && !receipt.optBoolean("uncertain"));val data=receipt.getJSONObject("data");check(data.getInt("code")==0);return data.getJSONObject("data")
    }
    override fun close(){server.close();synchronized(this){sessions.values.forEach{it.transport.close()};sessions.clear()}}
    companion object {
        private fun secret()=ByteArray(32).also{SecureRandom().nextBytes(it)}.let(TunnelCrypto::b64)
        private fun hash(value:String)=TunnelCrypto.hex(MessageDigest.getInstance("SHA-256").digest(value.toByteArray()))
        private fun equal(a:String,b:String)=MessageDigest.isEqual(a.toByteArray(),b.toByteArray())
        private fun caps(transport:String,source:String)=JSONObject().put("transport",transport).put("sourceDeviceId",source).put("bufferedHttp",true).put("lan",true).put("p2p",true).put("relay",true).put("streaming",true).put("websocket",true)
    }
}
