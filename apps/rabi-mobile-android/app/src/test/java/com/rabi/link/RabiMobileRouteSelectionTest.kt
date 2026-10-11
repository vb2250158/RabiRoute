package com.rabi.link

import com.rabiroute.sdk.RabiRouteSdk
import com.rabiroute.sdk.RabiLinkManagerHttpTransport
import com.rabiroute.sdk.RabiLinkManagerHttpResponse
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.Executors
import org.junit.Assert.assertEquals
import org.junit.Test

class RabiMobileRouteSelectionTest {
    @Test fun selectionKeepsDistinctChatRoutesAndExcludesSetupRows() {
        val rows = """{"code":0,"data":{"routes":[
            {"id":"route-a","agentRoleId":"persona-a","enabled":true,"messageAdapters":["rabilink"],"ownerWorkerId":"pc-a","ownerComputerName":"Computer A","voiceCallProtocol":1},
            {"id":"route-b","agentRoleId":"persona-a","enabled":true,"messageAdapters":["RABILINK"]},
            {"id":"profile-a","isPersonaOnly":true,"enabled":true,"messageAdapters":["rabilink"]},
            {"id":"disabled","enabled":false,"messageAdapters":["rabilink"]},
            {"id":"adapter-disabled","enabled":true,"messageAdapters":["rabilink"],"messageAdaptersDisabled":["rabilink"]},
            {"id":"health","enabled":true,"messageAdapters":["wearable"]}
        ]}}""".toByteArray(Charsets.UTF_8)
        val executor = Executors.newSingleThreadExecutor()
        ServerSocket(0, 4, InetAddress.getByName("127.0.0.1")).use { server ->
            executor.execute {
                repeat(4) {
                    server.accept().use { client ->
                        val reader = client.getInputStream().bufferedReader()
                        assertEquals("GET /api/rabilink/mobile/state HTTP/1.1", reader.readLine())
                        while (!reader.readLine().isNullOrEmpty()) { }
                        val directory = """{"code":0,"selectedTargetDeviceId":"pc-a","workers":[{"id":"pc-a","guid":"guid-a","online":true}]}""".toByteArray()
                        client.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${directory.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            write(directory); flush()
                        }
                    }
                }
            }
            try {
                var dispatched = 0
                val transport = RabiLinkManagerHttpTransport { _, _, target, method, path, _, _ ->
                    dispatched++
                    assertEquals("pc-a", target.id)
                    assertEquals("GET", method)
                    assertEquals("/api/rabi/instances/guid-a/routes?includeProfiles=true&presentation=mobile", path)
                    RabiLinkManagerHttpResponse(200, emptyMap(), rows, "lan", setOf("lan", "p2p", "relay"))
                }
                val sdk = RabiRouteSdk(timeoutMs = 1_000, managerTransport = transport)
                val base = "http://127.0.0.1:${server.localPort}"
                val selected = sdk.getMobileRoutes(base, "test-token")
                assertEquals(listOf("route-a", "route-b"), selected.map { it.id })
                assertEquals("pc-a", selected.first().rawJson.getString("ownerWorkerId"))
                assertEquals(1, selected.first().rawJson.getInt("voiceCallProtocol"))
                assertEquals(6, sdk.getMobileRouteCatalog(base, "test-token").size)
                assertEquals(2, dispatched)
            } finally { executor.shutdownNow() }
        }
    }
}
