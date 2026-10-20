package com.rabi.link

import com.rabiroute.sdk.RabiRouteInfo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class RabiRouteMetadataCacheTest {
    @Test fun cachedRouteMetadataKeepsPersonaPresentationWithoutMessagesOrTokens() {
        val raw = JSONObject()
            .put("ownerWorkerId", "pc-a").put("ownerComputerName", "Computer A").put("voiceCallProtocol", 1)
            .put("chatAvailable", false).put("isPersonaOnly", true)
            .put("messageAdaptersDisabled", JSONArray().put("rabilink"))
            .put("adapterStates", JSONArray().put(JSONObject()
                .put("type", "weixin")
                .put("label", "个人微信")
                .put("state", "login_required")
                .put("summary", "未登录")
                .put("accountId", "private-weixin-account")))
            .put("runtimeStatus", JSONObject().put("lastError", "private-diagnostic"))
        val route = RabiRouteInfo(
            id = "role:Ilias", name = "伊莉娅", configName = "", routeName = "", enabled = false, running = false,
            agentRoleId = "Ilias", personaDisplayName = "伊莉娅", messageAdapters = emptyList(), agentAdapters = emptyList(),
            codexCwd = "private-path", codexThreadName = "private-thread", avatarConfigured = true, avatarVersion = "opaque-version", rawJson = raw
        )
        val encoded = RabiRouteMetadataCache.encode(listOf(route))
        assertEquals(false, encoded.contains("private-path"))
        assertEquals(false, encoded.contains("private-thread"))
        assertEquals(false, encoded.contains("private-weixin-account"))
        assertEquals(false, encoded.contains("private-diagnostic"))
        assertEquals(true, encoded.contains("\"chatAvailable\":false"))
        assertEquals(true, encoded.contains("\"summary\":\"未登录\""))
        assertEquals("伊莉娅", RabiRouteMetadataCache.decode(encoded).single().personaDisplayName)
        val cached = RabiRouteMetadataCache.decode(encoded).single()
        assertEquals("Computer A",RabiConversationRules.personaComputerName(cached))
        cached.rawJson.put("personaSourceWorkerId","pc-b")
        assertEquals("来源待确认",RabiConversationRules.personaComputerName(cached))
        cached.rawJson.put("personaSourceComputerName","Source PC")
        val sourceCached = RabiRouteMetadataCache.decode(RabiRouteMetadataCache.encode(listOf(cached))).single()
        assertEquals("Source PC",RabiConversationRules.personaComputerName(sourceCached))
        val restored = cached.rawJson
        assertEquals(true, restored.getBoolean("isPersonaOnly"))
        assertEquals(false, restored.getBoolean("chatAvailable"))
        assertEquals("pc-a", restored.getString("ownerWorkerId"))
        assertEquals("Computer A", restored.getString("ownerComputerName"))
        assertEquals(1, restored.getInt("voiceCallProtocol"))
    }
}
