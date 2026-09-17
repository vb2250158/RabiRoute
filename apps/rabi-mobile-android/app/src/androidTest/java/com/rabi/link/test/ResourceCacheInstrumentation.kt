package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.recording.RecordingResourceCache
import com.rabi.link.transport.AsrDirectory
import com.rabi.link.transport.RabiSpeechTunnel
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Uses only an isolated synthetic resource, never changes recording retention preferences. */
class ResourceCacheInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    private fun hash(bytes: ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    override fun onStart() {
        val result=Bundle(); var code=Activity.RESULT_OK
        val context=targetContext
        val relative="resource-acceptance/synthetic.bin"
        val file=File(context.filesDir,relative)
        val index=File(context.filesDir,"recording-resource-index/${hash(relative.toByteArray())}.json")
        var cached: File?=null
        try {
            val relay=RabiLinkRelaySettings.load(context)
            val worker=RabiRouteSdk().getMobileState(relay.baseUrl,relay.token).selectedWorker ?: error("No selected PC")
            val bytes=ByteArray(1200000) { (it%251).toByte() }; val chunks=JSONArray()
            RabiSpeechTunnel(context,relay,worker,"resources").use { tunnel ->
                bytes.asList().chunked(1024*1024).forEach { list ->
                    val body=list.toByteArray(); val id=hash(body)
                    val response=tunnel.request("PUT","/objects/$id","application/octet-stream",body)
                    check(response.status==200) { "Upload status ${response.status}: ${String(response.body).take(200)}" }
                    val receipt=JSONObject(String(response.body)); check(receipt.getBoolean("durable") && receipt.getString("sha256")==id && receipt.getInt("bytes")==body.size)
                    chunks.put(JSONObject().put("id",id).put("bytes",body.size))
                }
                result.putString("transport",tunnel.transport)
            }
            file.parentFile!!.mkdirs(); file.writeBytes(bytes)
            index.parentFile!!.mkdirs(); index.writeText(JSONObject().put("path",relative).put("bytes",bytes.size).put("chunks",chunks)
                .put("scope",AsrDirectory.accountIdentity(relay.baseUrl,relay.token)).put("workerId",worker.id).toString())
            check(file.delete())
            cached=RecordingResourceCache.materialize(context,file)
            check(cached!!.readBytes().contentEquals(bytes))
            cached!!.writeBytes(ByteArray(bytes.size))
            check(RecordingResourceCache.materialize(context,file).readBytes().contentEquals(bytes))
            result.putString("result","PASS: durable upload, local removal, remote playback cache, corrupt cache recovery")
        } catch(error: Throwable) { code=Activity.RESULT_CANCELED; result.putString("error",error.stackTraceToString()) }
        finally { file.delete(); index.delete(); cached?.delete() }
        finish(code,result)
    }
}
