package com.rabi.link

/** Pure conversation rules shared by the UI and local unit tests. */
object RabiConversationRules {
    const val LEGACY_CONVERSATION_ID = "__legacy_rabi__"

    fun isChatCapable(enabled: Boolean, messageAdapters: List<String>): Boolean =
        enabled && messageAdapters.any { it.equals("rabilink", ignoreCase = true) }

    fun normalizedConversationId(routeProfileId: String?, fallbackConversationId: String?): String {
        val route = routeProfileId.orEmpty().trim()
        if (route.isNotBlank()) return route
        return fallbackConversationId.orEmpty().trim().ifBlank { LEGACY_CONVERSATION_ID }
    }

    fun unreadCount(incomingCreatedAt: List<Long>, readAt: Long): Int =
        incomingCreatedAt.count { it > readAt }

    /** A chat is addressed to a persona, not to its historical gateway label. */
    fun personaDisplayName(agentRoleId: String?, routeName: String?, configName: String?, routeId: String?): String {
        val role = agentRoleId.orEmpty().trim()
        if (role.isNotBlank()) return when (role.lowercase()) {
            "yeyu", "night-rain", "night_rain" -> "夜雨"
            else -> role
        }
        return routeName.orEmpty().trim()
            .ifBlank { configName.orEmpty().trim() }
            .ifBlank { routeId.orEmpty().trim() }
            .ifBlank { "Rabi" }
    }
}
