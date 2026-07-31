package com.rabi.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RabiConversationRulesTest {
    @Test fun wearableRouteIsNotAChatContact() {
        assertFalse(RabiConversationRules.isChatCapable(true, listOf("wearable")))
        assertTrue(RabiConversationRules.isChatCapable(true, listOf("rabilink")))
        assertFalse(RabiConversationRules.isChatCapable(false, listOf("rabilink")))
        assertFalse(RabiConversationRules.isChatCapable(true, listOf("rabilink", "napcat"), listOf("rabilink")))
        assertFalse(RabiConversationRules.isChatCapable(true, listOf("rabilink"), advertisedAvailability = false))
    }

    @Test fun blankLegacyMessagesAreNeverShownInEveryConversation() {
        assertEquals("route-yeyu", RabiConversationRules.normalizedConversationId("", "route-yeyu"))
        assertEquals(RabiConversationRules.LEGACY_CONVERSATION_ID,
            RabiConversationRules.normalizedConversationId("", ""))
        assertEquals("route-other", RabiConversationRules.normalizedConversationId("route-other", "route-yeyu"))
    }

    @Test fun readingOneConversationDoesNotClearAnother() {
        assertEquals(1, RabiConversationRules.unreadCount(listOf(100L, 300L), 200L))
        assertEquals(2, RabiConversationRules.unreadCount(listOf(250L, 400L), 200L))
    }

    @Test fun personaTitleWinsOverLegacyGatewayName() {
        assertEquals("夜雨", RabiConversationRules.personaDisplayName("夜雨", "YeYu", "默认 QQ 网关", "", "夜雨"))
    }

    @Test fun routeNameRemainsTheFallbackWithoutAPersonaBinding() {
        assertEquals("独立会话", RabiConversationRules.personaDisplayName("", "", "独立会话", "配置名", "route-1"))
    }

    @Test fun managerPersonaNameWinsOverOpaqueRoleId() {
        assertEquals("伊莉娅", RabiConversationRules.personaDisplayName("伊莉娅", "Ilias", "Ilias", "", "role:Ilias"))
    }

    @Test fun readableRouteNameBeatsAnOpaqueRoleIdForOlderManagers() {
        assertEquals("伊莉娅", RabiConversationRules.personaDisplayName("", "Ilias", "伊莉娅", "", "role:Ilias"))
    }

    @Test fun disabledAndNonChatPersonasRemainVisible() {
        assertTrue(RabiConversationRules.isVisibleInConversationList("role:Ilias"))
        assertFalse(RabiConversationRules.isChatCapable(false, emptyList()))
    }

    @Test fun avatarEventsOnlyMatchTheirOwnPersona() {
        assertTrue(RabiConversationRules.shouldRefreshAvatar("Ilias", "Ilias"))
        assertFalse(RabiConversationRules.shouldRefreshAvatar("Ilias", "YeYu"))
        assertFalse(RabiConversationRules.shouldRefreshAvatar("", "YeYu"))
    }

    @Test fun adapterSummaryKeepsIndependentEntryStateVisible() {
        val states = listOf(
            RabiAdapterPresentation("napcat", "QQ", "connected", "已连接"),
            RabiAdapterPresentation("weixin", "个人微信", "login_required", "未登录"),
            RabiAdapterPresentation("rabilink", "手机消息", "ready", "已就绪"),
        )
        assertEquals("QQ 已连接 · 个人微信 未登录 · 手机消息 已就绪", RabiConversationRules.adapterStatusSummary(states))
        assertEquals("QQ 已连接 · 个人微信 未登录 · 手机消息 已就绪", RabiConversationRules.routeStatus(true, true, states))
        assertTrue(RabiConversationRules.adapterStatusNeedsAttention(states))
    }

    @Test fun missingChatConfigurationIsNotPresentedAsASystemFailure() {
        assertEquals("聊天入口尚未配置", RabiConversationRules.routeStatus(false, false, emptyList()))
        assertEquals(
            "手机聊天已配置 · 等待 Rabi PC 启动",
            RabiConversationRules.routeStatus(true, false, listOf(
                RabiAdapterPresentation("rabilink", "手机消息", "stopped", "等待 Rabi PC 启动"),
            )),
        )
    }
}
