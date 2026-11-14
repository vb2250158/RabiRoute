package com.rabiroute.sdk

import android.content.Context
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RabiLinkCallbackDiscoveryJvmTest {
    private val operationId = "gateway.0123456789abcdef.webhook.rabilink.ready"
    private val listenerId = "gateway.0123456789abcdef.webhook.rabilink.listener"
    private val lease = "12345678-1234-4234-8234-123456789abc"

    private fun catalog(port:Int, route:String="/custom/callback", revision:Int=1, next:String=""):JSONObject {
        val binding=JSONObject().put("kind","external-listener").put("listenerId",listenerId).put("leaseId",lease)
            .put("protocol","rabi-webhook-json").put("invocation","native").put("authentication",JSONObject().put("kind","none"))
            .put("address",JSONObject().put("protocol","http").put("port",port))
        val owner=JSONObject().put("instanceId","gateway-owner").put("activationId","activation-a").put("revision","one")
        val operation=JSONObject().put("id",operationId).put("method","GET").put("pathTemplate",route).put("binding",binding).put("owner",owner)
        val data=JSONObject().put("schemaVersion","2").put("applicationGenerationId","generation-a").put("managerInstanceId","manager-a")
            .put("pluginGenerationId","plugin-a").put("catalogRevision",revision).put("catalogDigest","sha256:"+"a".repeat(64))
            .put("nextCursor",next).put("operations",JSONArray().put(operation))
            .put("listeners",JSONArray().put(JSONObject().put("binding",JSONObject(binding.toString())).put("owner",JSONObject(owner.toString()))))
        return JSONObject().put("code",0).put("data",data)
    }

    private class Server(handler:(HttpExchange)->String):AutoCloseable {
        private val server=HttpServer.create(InetSocketAddress("127.0.0.1",0),0).apply {
            createContext("/") { exchange ->
                try { val bytes=handler(exchange).toByteArray();exchange.responseHeaders.set("Content-Type","application/json")
                    exchange.sendResponseHeaders(200,bytes.size.toLong());exchange.responseBody.use{it.write(bytes)} }
                finally { exchange.close() }
            };start()
        }
        val port:Int get()=server.address.port
        val baseUrl:String get()="http://127.0.0.1:$port"
        override fun close()=server.stop(0)
    }
    private fun instance(url:String)=RabiInstance("guid-a","fixture","fixture","Manager",url,"127.0.0.1",java.net.URL(url).port,null,"generation-a","manager-a")
    private fun rejected(action:()->Unit) { assertTrue(runCatching(action).isFailure) }

    @Test fun dynamicPublicationUsesActualPortPathAndLifecycleFence() {
        val nativeCalls=AtomicInteger();val managerCalls=AtomicInteger()
        Server { request -> assertEquals("/custom/callback",request.requestURI.path);nativeCalls.incrementAndGet();"""{"ok":true,"adapterType":"rabilink","status":"ready"}""" }.use { native ->
            Server { request ->
                assertEquals("/api/agent/help",request.requestURI.path)
                assertEquals("generation-a",request.requestHeaders.getFirst("x-rabiroute-expected-application-generation-id"))
                assertEquals("manager-a",request.requestHeaders.getFirst("x-rabiroute-expected-manager-instance-id"))
                managerCalls.incrementAndGet();catalog(native.port).toString()
            }.use { manager ->
                val found=RabiRouteSdk(timeoutMs=2000).discoverRabiLinkCallbacks(instance(manager.baseUrl))
                assertEquals(1,found.size);assertTrue(found.single().ok);assertEquals(native.port,found.single().port)
                assertEquals(native.baseUrl+"/custom/callback",found.single().url)
                assertEquals(1,nativeCalls.get());assertEquals(1,managerCalls.get())
            }
        }
    }

    @Test fun defaultScanUsesVerifiedManagersInsteadOfScanningAConventionalCallbackPort() {
        val nativeCalls=AtomicInteger()
        Server { nativeCalls.incrementAndGet();"""{"ok":true,"adapterType":"rabilink"}""" }.use { native ->
            Server { request ->
                if(request.requestURI.path==RabiRouteDiscoveryContract.WELL_KNOWN_PATH)
                    """{"code":0,"data":{"protocolVersion":1,"applicationGenerationId":"generation-a","managerInstanceId":"manager-a","guid":"guid-a","name":"fixture"}}"""
                else catalog(native.port).toString()
            }.use { manager ->
                val found=RabiRouteSdk(managerBaseUrls=listOf(manager.baseUrl),timeoutMs=2000).scanRabiLinkCallbacks(Context())
                assertEquals(listOf(native.port),found.map{it.port});assertEquals(1,nativeCalls.get())
            }
        }
    }

    @Test fun changedManagerIdentityNeverProbesAnUnverifiedNativeEndpoint() {
        val calls=AtomicInteger()
        Server { calls.incrementAndGet();"{}" }.use { native ->
            Server { catalog(native.port).apply{getJSONObject("data").put("applicationGenerationId","generation-b")}.toString() }.use { manager ->
                rejected{RabiRouteSdk(timeoutMs=2000).discoverRabiLinkCallbacks(instance(manager.baseUrl))};assertEquals(0,calls.get())
            }
        }
    }

    @Test fun listenerLeaseOwnerAndAddressMustMatchThePublishedOperation() {
        val base="http://192.0.2.10:43127"
        for(mutate in listOf<(JSONObject)->Unit>(
            {it.getJSONArray("listeners").getJSONObject(0).getJSONObject("binding").put("leaseId","00000000-0000-4000-8000-000000000000")},
            {it.getJSONArray("listeners").getJSONObject(0).getJSONObject("owner").put("activationId","activation-b")},
            {it.getJSONArray("listeners").getJSONObject(0).getJSONObject("binding").getJSONObject("address").put("port",43211)})) {
            val document=catalog(43210);mutate(document.getJSONObject("data"))
            rejected{RabiLinkCallbackDiscovery.readPage(base,"generation-a","manager-a",document,null)}
        }
        val duplicate=catalog(43210);val listeners=duplicate.getJSONObject("data").getJSONArray("listeners");listeners.put(listeners.get(0))
        rejected{RabiLinkCallbackDiscovery.readPage(base,"generation-a","manager-a",duplicate,null)}
    }

    @Test fun paginationIsFencedToOneCatalogBeforeAnyCallbackProbe() {
        val calls=AtomicInteger();val pages=AtomicInteger()
        Server { calls.incrementAndGet();"{}" }.use { native ->
            Server { catalog(native.port,revision=pages.incrementAndGet(),next=if(pages.get()==1)"next" else "").toString() }.use { manager ->
                rejected{RabiRouteSdk(timeoutMs=2000).discoverRabiLinkCallbacks(instance(manager.baseUrl))};assertEquals(0,calls.get());assertEquals(2,pages.get())
            }
        }
    }

    @Test fun concretePathsAndStandardUrlPortsArePreserved() {
        assertEquals(80,RabiLinkCallbackDiscovery.callbackUrl("http://example.test/custom").defaultPort)
        assertEquals(443,RabiLinkCallbackDiscovery.callbackUrl("https://example.test/custom").defaultPort)
        assertEquals("https://example.test/custom",RabiLinkCallbackDiscovery.callbackUrl("https://example.test/custom").toExternalForm())
        assertEquals("http://example.test/rabilink",RabiLinkCallbackDiscovery.callbackUrl("http://example.test").toExternalForm())
        for(value in listOf("http://example.test:0/custom","http://user:secret@example.test/custom","http://example.test/custom?token=x","http://example.test/custom#x"))
            rejected{RabiLinkCallbackDiscovery.callbackUrl(value)}
    }

    @Test fun directProbeMessageAndRepliesUseTheSameExplicitCustomCallbackPath() {
        val paths=ArrayList<String>()
        Server { request -> paths.add(request.requestURI.path);request.requestBody.use{it.readBytes()};
            """{"ok":true,"adapterType":"rabilink","status":"ready","messageId":"fixture","data":{}}""" }.use { native ->
            val sdk=RabiRouteSdk(timeoutMs=2000);val url=native.baseUrl+"/custom/callback"
            assertTrue(sdk.probeRabiLinkCallback(url).ok);assertTrue(sdk.deliverRabiLinkMessage(url,"fixture").ok)
            sdk.getRabiLinkReplies(url,"route-a")
            assertEquals(listOf("/custom/callback","/custom/callback","/custom/callback/replies"),paths)
        }
    }

    @Test fun unrelatedWebhookPublicationsAreNotRabiLinkCallbacks() {
        val document=catalog(43210);document.getJSONObject("data").getJSONArray("operations").getJSONObject(0)
            .put("id","gateway.0123456789abcdef.webhook.webhook.ready")
        assertTrue(RabiLinkCallbackDiscovery.readPage("http://192.0.2.10:43127","generation-a","manager-a",document,null).urls.isEmpty())
    }

    @Test fun pcLoopbackPublicationIsNeverProbedAsThePhonesLoopbackService() {
        val document=catalog(43210)
        val data=document.getJSONObject("data")
        data.getJSONArray("operations").getJSONObject(0).getJSONObject("binding").getJSONObject("address").put("hostname","127.0.0.1")
        data.getJSONArray("listeners").getJSONObject(0).getJSONObject("binding").getJSONObject("address").put("hostname","127.0.0.1")
        assertTrue(RabiLinkCallbackDiscovery.readPage("http://192.0.2.10:43127","generation-a","manager-a",document,null).urls.isEmpty())
        assertEquals(1,RabiLinkCallbackDiscovery.readPage("http://127.0.0.1:43127","generation-a","manager-a",document,null).urls.size)
        val wildcard=catalog(43210,"//custom:callback/")
        assertEquals(listOf("http://192.0.2.10:43210//custom:callback/"),
            RabiLinkCallbackDiscovery.readPage("http://192.0.2.10:43127","generation-a","manager-a",wildcard,null).urls)
    }
}
