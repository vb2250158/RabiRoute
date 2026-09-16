package com.rabi.link

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.res.Configuration
import android.os.Bundle
import java.util.WeakHashMap

/** Device-local appearance preference; PC appearance remains independently owned. */
object RabiMobileTheme {
    private lateinit var application: Application
    private const val PREFERENCES = "rabi_mobile_appearance"
    private const val THEME = "theme"

    internal fun initialize(app: Application) { application = app }
    fun preference(context: Context): String = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        .getString(THEME, "system").let { if (it == "light" || it == "dark") it else "system" }

    fun isDark(): Boolean = when (preference(application)) {
        "light" -> false
        "dark" -> true
        else -> systemDark()
    }

    internal fun systemDark(): Boolean = application.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

    fun save(context: Context, id: String): Boolean {
        require(id in context.resources.getStringArray(R.array.mobile_theme_ids))
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(THEME, id).commit()
    }

    internal fun color(token: String): Int = (if (isDark()) RabiThemeTokens.dark else RabiThemeTokens.light).getValue(token)
    internal fun style(): Int = if (isDark()) R.style.RabiDark else R.style.RabiLight
}

/** Theme every Activity before inflation, including platform dialogs and dropdowns. */
class RabiMobileApplication : Application(), Application.ActivityLifecycleCallbacks {
    private val applied = WeakHashMap<Activity, Int>()

    override fun onCreate() {
        super.onCreate()
        RabiMobileTheme.initialize(this)
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityPreCreated(activity: Activity, savedInstanceState: Bundle?) {
        val theme = RabiMobileTheme.style()
        activity.setTheme(theme)
        applied[activity] = theme
    }

    override fun onActivityResumed(activity: Activity) {
        if (applied[activity] != RabiMobileTheme.style() && !activity.isFinishing) activity.recreate()
    }

    override fun onActivityDestroyed(activity: Activity) { applied.remove(activity) }
    override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
}
