package com.rabi.link.transport

import com.rabiroute.sdk.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.net.ServerSocket
import java.net.InetAddress

class ManagerHttpTransportTest {
    private fun directory(run: (String) -> Unit) {
        val server=ServerSocket(0,8,InetAddress.getLoopbackAddress())
        val worker=Thread {
            while(!server.isClosed) try {
                server.accept().use { socket ->
                    socket.soTimeout=5000
                    val reader=socket.getInputStream().bufferedReader()
                    while(!reader.readLine().isNullOrEmpty()) { }
                    val bytes="""{"code":0,"connectionOwnerDeviceId":"pc-owner","selectedTargetDeviceId":"pc-other","workers":[{"id":"pc-owner","guid":"guid-owner","online":true},{"id":"pc-other","guid":"guid-other","online":true}]}""".toByteArray()
                    socket.getOutputStream().apply { write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray());write(bytes);flush() }
                }
            } catch(error: Exception) { if(!server.isClosed) throw error }
        }.apply { isDaemon=true;start() }
        try { run("http://127.0.0.1:"+server.localPort) } finally { server.close();worker.join(1000) }
    }
    @Test fun unknownFutureApiUsesInjectedServiceTransportAndExplicitPc() = directory { base ->
        var dispatched=0
        val transport=RabiLinkManagerHttpTransport { _,_,target,method,path,headers,body ->
            dispatched++; assertEquals("pc-other",target.id); assertEquals("POST",method); assertEquals("/api/new-after-client-release",path)
            assertEquals("original-key",headers["idempotency-key"]); assertEquals("current",headers["if-match"]); assertEquals("{\"value\":1}",String(body))
            RabiLinkManagerHttpResponse(200,emptyMap(),"{\"code\":0,\"data\":{\"confirmed\":true}}".toByteArray(),"lan",setOf("lan","p2p","relay"))
        }
        val result=RabiRouteSdk(managerTransport=transport).requestMobileManager(base,"synthetic","pc-other","/api/new-after-client-release","POST","{\"value\":1}",mapOf("if-match" to "current"),"original-key")
        assertTrue(result.getJSONObject("data").getBoolean("confirmed")); assertEquals(1,dispatched)
    }
    @Test fun dispatchedFailureNeverRetriesOrChangesTransport() = directory { base ->
        var dispatched=0
        val transport=RabiLinkManagerHttpTransport { _,_,_,_,_,_,_ -> dispatched++; throw IllegalStateException("unknown write result") }
        try { RabiRouteSdk(managerTransport=transport).requestMobileManager(base,"synthetic","pc-owner","/api/future/write","PUT","{}",operationId="original-key"); fail("failure was hidden") }
        catch(error: IllegalStateException) { assertEquals("unknown write result",error.message) }
        assertEquals(1,dispatched)
    }
    @Test fun httpSuccessCannotHideStringBusinessErrorOrReplayItsRequest() = directory { base ->
        var dispatched=0
        val transport=RabiLinkManagerHttpTransport { _,_,_,_,_,_,_ ->
            dispatched++
            RabiLinkManagerHttpResponse(200,emptyMap(),"""{"code":"DEVICE_AGENT_OWNER_ALREADY_LOADED","message":"original conflict"}""".toByteArray(),"relay",setOf("relay"))
        }
        try { RabiRouteSdk(managerTransport=transport).requestMobileManager(base,"synthetic","pc-owner","/api/device-agents/glasses/session","PUT","{}",operationId="original-key");fail("business error hidden") }
        catch(error: IllegalStateException) { assertTrue(error.message!!.contains("DEVICE_AGENT_OWNER_ALREADY_LOADED")) }
        assertEquals(1,dispatched)
    }
    @Test fun unsignedTargetIsRejectedBeforeBusinessDispatch() = directory { base ->
        var dispatched=0
        val transport=RabiLinkManagerHttpTransport { _,_,_,_,_,_,_ -> dispatched++; error("must not execute") }
        try { RabiRouteSdk(managerTransport=transport).requestMobileManager(base,"synthetic","unregistered","/api/future"); fail("target escaped the directory") }
        catch(_: IllegalStateException) { }
        assertEquals(0,dispatched)
    }
    @Test fun applicationStatusAndAsrSettingsKeepTheirOwnerWhenChatTargetChanges() = directory { base ->
        val paths=mutableListOf<String>()
        val transport=RabiLinkManagerHttpTransport { _,_,target,_,path,_,_ ->
            assertEquals("pc-owner",target.id); paths.add(path)
            val body=if(path.endsWith("device-status")) """{"code":0,"deviceStatus":{"batteryLevel":42,"charging":false}}"""
                else """{"code":0,"workers":[],"selectedWorkerId":""}"""
            RabiLinkManagerHttpResponse(200,emptyMap(),body.toByteArray(),"lan",setOf("lan","p2p","relay"))
        }
        val sdk=RabiRouteSdk(managerTransport=transport)
        assertEquals(42,sdk.publishMobileDeviceStatus(base,"synthetic",42,false,"2026-10-10T00:00:00Z").batteryLevel)
        assertEquals(0,sdk.mobileAsrSettings(base,"synthetic").workers.size)
        assertEquals(listOf("/api/rabilink/mobile/device-status","/api/rabilink/mobile/asr-settings"),paths)
    }
}
