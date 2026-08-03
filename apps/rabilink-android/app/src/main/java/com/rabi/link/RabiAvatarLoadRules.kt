package com.rabi.link

/** Pure avatar presentation rules shared by Android UI code and local JVM tests. */
object RabiAvatarLoadRules {
    enum class State { LOADING, VALIDATING, READY, STALE, UNAVAILABLE }

    fun cachedState(exactVersionAvailable: Boolean, olderVersionAvailable: Boolean): State = when {
        exactVersionAvailable -> State.READY
        olderVersionAvailable -> State.STALE
        else -> State.LOADING
    }

    fun failureState(cachedAvatarDisplayed: Boolean): State =
        if (cachedAvatarDisplayed) State.STALE else State.UNAVAILABLE

    fun unavailableLabel(configured: Boolean): String =
        if (configured) "头像暂不可用" else "未配置头像"

    fun placeholderContentDescription(label: String, configured: Boolean = false): String =
        "$label ${unavailableLabel(configured)}"
}
