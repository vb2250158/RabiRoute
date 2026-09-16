package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import com.rabi.link.RabiAppearanceActivity
import com.rabi.link.RabiMobileTheme
import com.rabi.link.RabiMobileUi

/** No connection, capture or credentials are needed for appearance acceptance. */
class MobileThemeInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }

    override fun onStart() {
        val result = Bundle()
        val previous = RabiMobileTheme.preference(targetContext)
        var activity: Activity? = null
        var code = Activity.RESULT_OK
        try {
            for (id in listOf("light", "dark", "system")) {
                check(RabiMobileTheme.save(targetContext, id))
                check(RabiMobileTheme.preference(targetContext) == id)
                val expectedDark = id == "dark" || (id == "system" &&
                    targetContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
                check(RabiMobileTheme.isDark() == expectedDark)
                activity = startActivitySync(Intent(targetContext, RabiAppearanceActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                waitForIdleSync()
                runOnMainSync {
                    check(activity!!.window.statusBarColor == RabiMobileUi.background)
                    check(activity!!.window.navigationBarColor == RabiMobileUi.surface)
                    val button = RabiMobileUi.primary(activity!!, "test") {}
                    check(button.currentTextColor == RabiMobileUi.onAccent)
                    val input = RabiMobileUi.input(activity!!, "test")
                    check(input.currentTextColor == RabiMobileUi.text)
                    activity!!.finish()
                }
                waitForIdleSync()
                activity = null
            }
            result.putString("result", "PASS: light/dark/system persistence, Activity window bars, button/input colors")
        } catch (error: Throwable) {
            result.putString("error", error.stackTraceToString())
            code = Activity.RESULT_CANCELED
        } finally {
            runOnMainSync { activity?.finish() }
            RabiMobileTheme.save(targetContext, previous)
        }
        finish(code, result)
    }
}
