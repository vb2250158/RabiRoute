package com.rabi.link

import com.rabiroute.sdk.RabiRouteInfo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class RabiRouteMetadataCacheTest {
    @Test fun cachedRouteMetadataKeepsPersonaPresentationWithoutMessagesOrTokens() {
        val raw = JSONObject()
            .put("chatAvailable", false)
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
    }
}
