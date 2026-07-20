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
}
