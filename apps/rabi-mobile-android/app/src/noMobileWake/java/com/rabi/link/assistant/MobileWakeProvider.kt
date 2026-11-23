package com.rabi.link.assistant

import android.content.Context

internal object MobileWakeProvider {
    const val available = false

    @Suppress("UNUSED_PARAMETER")
    fun open(context: Context, keywords: String): MobileWakeEngine = error("MOBILE_WAKE_UNAVAILABLE")
}
