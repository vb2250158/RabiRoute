package com.rabi.link

import org.junit.Assert.*
import org.junit.Test

class SavedComputersTest {
    private fun connection(url: String = "http://localhost:1234", token: String = "test-token") = RabiLinkRelayConfig(url,token,true)
    @Test fun multipleWorkersAndEndpointsRemainSeparate() {
        val one = RabiLinkRelaySettings.mergeComputer(emptyList(),"One","worker-1",connection())
        val two = RabiLinkRelaySettings.mergeComputer(one,"Two","worker-2",connection())
        val three = RabiLinkRelaySettings.mergeComputer(two,"Three","worker-1",connection("http://localhost:1235"))
        assertEquals(3,three.size)
        assertEquals(3,three.map { it.id }.distinct().size)
    }
    @Test fun reconnectUpdatesWithoutDuplicatingOrRemovingOthers() {
        val one = RabiLinkRelaySettings.mergeComputer(emptyList(),"One","worker-1",connection())
        val two = RabiLinkRelaySettings.mergeComputer(one,"Two","worker-2",connection())
        val updated = RabiLinkRelaySettings.mergeComputer(two,"Renamed","worker-1",connection())
        assertEquals(2,updated.size)
        assertEquals(one.first().id,updated.first().id)
        assertEquals("Renamed",updated.first().name)
        assertEquals("Two",updated.last().name)
    }
    @Test fun migratedUnknownWorkerIsEnrichedInPlace() {
        val old = SavedComputer("legacy","Old","",connection())
        val updated = RabiLinkRelaySettings.mergeComputer(listOf(old),"Verified","worker-1",connection())
        assertEquals(1,updated.size)
        assertEquals("legacy",updated.single().id)
        assertEquals("worker-1",updated.single().workerId)
    }
    @Test fun credentialsAreIsolatedAndJsonRestoresRows() {
        val one = RabiLinkRelaySettings.mergeComputer(emptyList(),"One","worker-1",connection())
        val two = RabiLinkRelaySettings.mergeComputer(one,"Two","worker-1",connection(token="other-test-token"))
        assertEquals(2,two.size)
        val restored = RabiLinkRelaySettings.decodeComputers("""[{"id":"a","name":"One","workerId":"w1","baseUrl":"http://localhost:1234","token":"test-token"},{"id":"b","name":"Two","workerId":"w2","baseUrl":"http://localhost:1235","token":"other-test-token"}]""")
        assertEquals(listOf("a","b"),restored.map { it.id })
        assertEquals("other-test-token",restored.last().connection.token)
    }
}
