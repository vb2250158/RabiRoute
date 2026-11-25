package com.rabi.link

import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiLinkPc
import org.json.JSONObject

data class RabiAdapterPresentation(
    val type: String,
    val label: String,
    val state: String,
    val summary: String,
)

/** Pure conversation rules shared by the UI and local unit tests. */
object RabiConversationRules {
    const val LEGACY_CONVERSATION_ID = "__legacy_rabi__"

    fun wireRouteId(route: RabiRouteInfo): String = route.rawJson.optString("wireRouteId").ifBlank { route.id }
    fun scopedRouteId(workerId: String, wireRouteId: String): String = "pc-route:${workerId.length}:$workerId:$wireRouteId"

    fun mergeComputerCatalogs(
        previous: List<RabiRouteInfo>,
        workers: List<RabiLinkPc>,
        catalogs: Map<String, List<RabiRouteInfo>>,
    ): List<RabiRouteInfo> {
        val previousByOwner = previous.groupBy { it.rawJson.optString("ownerWorkerId") }
        val occupied = previous.associate { it.id to it.rawJson.optString("ownerWorkerId") }.toMutableMap()
        return workers.flatMap { worker ->
            val cached = previousByOwner[worker.id].orEmpty()
            val fresh = catalogs[worker.id] ?: return@flatMap cached.map { it.copy(running = false) }
            val previousIds = cached.associate { wireRouteId(it) to it.id }
            fresh.filter { it.id.isNotBlank() }.distinctBy { it.id }.map { route ->
                val wireId = route.id
                val historicalOwner = occupied[wireId]
                val id = previousIds[wireId] ?: if (historicalOwner.isNullOrBlank() || historicalOwner == worker.id) wireId
                    else scopedRouteId(worker.id, wireId)
                occupied[id] = worker.id
                route.copy(id = id, rawJson = JSONObject(route.rawJson.toString())
                    .put("wireRouteId", wireId)
                    .put("ownerWorkerId", worker.id)
                    .put("ownerComputerName", worker.name.ifBlank { route.rawJson.optString("ownerComputerName") }))
            }
        }
    }

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

    /** Preserve PC identities and distinct routes; a configured route replaces only its catalog placeholder. */
    fun personaConversations(catalog: List<RabiRouteInfo>): List<RabiRouteInfo> {
        val candidates = catalog.distinctBy { it.id }.filter { route ->
            route.id.isNotBlank() && (route.agentRoleId.isNotBlank() || route.rawJson.optBoolean("isPersonaOnly") ||
                isChatCapable(route.enabled,route.messageAdapters))
        }
        fun personaKey(route: RabiRouteInfo) = route.rawJson.optString("ownerWorkerId") to route.agentRoleId
        val configured = candidates.filter { !it.rawJson.optBoolean("isPersonaOnly") && it.agentRoleId.isNotBlank() }
            .map(::personaKey).toSet()
        return candidates.filterNot { it.rawJson.optBoolean("isPersonaOnly") && it.agentRoleId.isNotBlank() && personaKey(it) in configured }
    }

    fun personaComputerName(route: RabiRouteInfo?): String {
        val raw = route?.rawJson ?: return "来源待确认"
        raw.optString("personaSourceComputerName").trim().takeIf { it.isNotEmpty() }?.let { return it }
        val source = raw.optString("personaSourceWorkerId").trim()
        val owner = raw.optString("ownerWorkerId").trim()
        if(source.isNotEmpty() && source != owner) return "来源待确认"
        return raw.optString("ownerComputerName").trim().ifBlank { "来源待确认" }
    }

    fun normalizedConversationId(routeProfileId: String?, fallbackConversationId: String?): String {
        val route = routeProfileId.orEmpty().trim()
        if (route.isNotBlank()) return route
        return fallbackConversationId.orEmpty().trim().ifBlank { LEGACY_CONVERSATION_ID }
    }

    fun unreadCount(incomingCreatedAt: List<Long>, readAt: Long): Int =
        incomingCreatedAt.count { it > readAt }

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
