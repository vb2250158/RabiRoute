package com.rabi.link

/** Pure avatar presentation rules shared by Android UI code and local JVM tests. */
object RabiAvatarLoadRules {
    enum class State { LOADING, VALIDATING, READY, STALE, UNAVAILABLE }

    fun cachedState(exactVersionAvailable: Boolean, olderVersionAvailable: Boolean): State = when {
        exactVersionAvailable -> State.VALIDATING
        olderVersionAvailable -> State.STALE
        else -> State.LOADING
    }

    fun failureState(cachedAvatarDisplayed: Boolean): State =
        if (cachedAvatarDisplayed) State.STALE else State.UNAVAILABLE
}
