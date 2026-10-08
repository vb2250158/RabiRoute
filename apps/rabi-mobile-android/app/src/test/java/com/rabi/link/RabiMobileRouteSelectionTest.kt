package com.rabi.link

import com.rabiroute.sdk.RabiRouteSdk
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
                repeat(2) {
                    server.accept().use { client ->
                        val reader = client.getInputStream().bufferedReader()
                        while (!reader.readLine().isNullOrEmpty()) { }
                        client.getOutputStream().apply {
                            write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${rows.size}\r\nConnection: close\r\n\r\n".toByteArray())
                            write(rows); flush()
                        }
                    }
                }
            }
            try {
                val sdk = RabiRouteSdk(timeoutMs = 1_000)
                val base = "http://127.0.0.1:${server.localPort}"
                val selected = sdk.getMobileRoutes(base, "test-token")
                assertEquals(listOf("route-a", "route-b"), selected.map { it.id })
                assertEquals("pc-a", selected.first().rawJson.getString("ownerWorkerId"))
                assertEquals(1, selected.first().rawJson.getInt("voiceCallProtocol"))
                assertEquals(6, sdk.getMobileRouteCatalog(base, "test-token").size)
            } finally { executor.shutdownNow() }
        }
    }
}
