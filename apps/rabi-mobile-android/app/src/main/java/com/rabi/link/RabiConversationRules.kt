package com.rabi.link

data class RabiAdapterPresentation(
    val type: String,
    val label: String,
    val state: String,
    val summary: String,
)

/** Pure conversation rules shared by the UI and local unit tests. */
object RabiConversationRules {
    const val LEGACY_CONVERSATION_ID = "__legacy_rabi__"

    fun isChatCapable(
        enabled: Boolean,
        messageAdapters: List<String>,
        disabledAdapters: List<String> = emptyList(),
        advertisedAvailability: Boolean? = null,
    ): Boolean {
        if (advertisedAvailability != null) return advertisedAvailability
        return enabled
            && messageAdapters.any { it.equals("rabilink", ignoreCase = true) }
            && disabledAdapters.none { it.equals("rabilink", ignoreCase = true) }
    }

    fun normalizedConversationId(routeProfileId: String?, fallbackConversationId: String?): String {
        val route = routeProfileId.orEmpty().trim()
        if (route.isNotBlank()) return route
        return fallbackConversationId.orEmpty().trim().ifBlank { LEGACY_CONVERSATION_ID }
    }

    fun unreadCount(incomingCreatedAt: List<Long>, readAt: Long): Int =
        incomingCreatedAt.count { it > readAt }

    /** Visibility is intentionally independent of enabled/chat-capable state. */
    fun isVisibleInConversationList(routeId: String?): Boolean = routeId.orEmpty().trim().isNotBlank()

    fun shouldRefreshAvatar(changedRoleId: String?, targetRoleId: String?): Boolean {
        val changed = changedRoleId.orEmpty().trim()
        return changed.isNotBlank() && changed == targetRoleId.orEmpty().trim()
    }

    fun adapterStatusSummary(states: List<RabiAdapterPresentation>): String =
        states.joinToString(" · ") { state ->
            "${state.label.ifBlank { state.type }} ${state.summary}".trim()
        }

    fun routeStatus(
        chatAvailable: Boolean,
        running: Boolean,
        adapterStates: List<RabiAdapterPresentation>,
    ): String {
        if (!chatAvailable) return if (adapterStates.isEmpty()) {
            "聊天入口尚未配置"
        } else {
            "手机聊天未启用 · ${adapterStatusSummary(adapterStates)}"
        }
        if (!running) return "手机聊天已配置 · 等待 Rabi PC 启动"
        return adapterStatusSummary(adapterStates).ifBlank { "手机聊天已就绪" }
    }

    fun adapterStatusNeedsAttention(states: List<RabiAdapterPresentation>): Boolean =
        states.any { it.state in setOf("login_required", "waiting", "stopped", "disabled", "attention") }

    /** A chat is addressed to a persona, not to its historical gateway label. */
    fun personaDisplayName(preferredName: String?, agentRoleId: String?, routeName: String?, configName: String?, routeId: String?): String {
        preferredName.orEmpty().trim().takeIf { it.isNotBlank() }?.let { return it }
        val role = agentRoleId.orEmpty().trim()
        if (role.isNotBlank()) return when (role.lowercase()) {
            "yeyu", "night-rain", "night_rain" -> "夜雨"
            else -> routeName.orEmpty().trim()
                .takeIf { it.isNotBlank() && !it.equals(role, ignoreCase = true) }
                ?: configName.orEmpty().trim()
                    .takeIf { it.isNotBlank() && !it.equals(role, ignoreCase = true) }
                ?: role
        }
        return routeName.orEmpty().trim()
            .ifBlank { configName.orEmpty().trim() }
            .ifBlank { routeId.orEmpty().trim() }
            .ifBlank { "Rabi" }
    }
}
