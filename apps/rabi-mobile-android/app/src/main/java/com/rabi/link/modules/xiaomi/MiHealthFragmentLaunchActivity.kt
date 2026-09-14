package com.rabi.link.modules.xiaomi

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcelable
import android.util.Log
import android.widget.LinearLayout
import android.widget.TextView
import com.rabi.link.RabiGuidanceTone
import com.rabi.link.RabiMobileUi
import com.xiaomi.fitness.baseui.common.FragmentParams

class MiHealthFragmentLaunchActivity : Activity() {
    private lateinit var guidanceView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(18))
            setBackgroundColor(RabiMobileUi.background)
            addView(
                RabiMobileUi.hero(
                    this@MiHealthFragmentLaunchActivity,
                    "打开小米运动健康",
                    "Rabi 会自动尝试打开对应健康记录；系统不允许时会说明原因。",
                ),
                LinearLayout.LayoutParams(-1, -2),
            )
            guidanceView = RabiMobileUi.guidance(
                this@MiHealthFragmentLaunchActivity,
                com.rabi.link.RabiSetupGuidance(
                    "正在打开小米健康记录",
                    "App 正在调用小米运动健康提供的页面入口。",
                    "无需操作；成功后会自动进入小米运动健康。",
                ),
            )
            addView(guidanceView, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
        })
        Handler(Looper.getMainLooper()).postDelayed({
            if (launchMiHealthFragment()) finish()
        }, 300L)
    }

    private fun launchMiHealthFragment(): Boolean {
        val targetFragment = intent.getStringExtra(EXTRA_FRAGMENT)
            ?: "com.xiaomi.fitness.health.hrm.HrmAllRecordsFragment"
        val extras = Bundle().apply {
            intent.getStringExtra(EXTRA_TITLE)?.let { putString("title", it) }
        }
        val launchIntent = Intent().apply {
            setClassName(
                "com.mi.health",
                "com.xiaomi.fitness.baseui.common.CommonBaseActivity"
            )
            putExtra("fragment_param", FragmentParams(targetFragment, extras, true, false) as Parcelable)
        }
        try {
            startActivity(launchIntent)
            Log.i(TAG, "Started Mi Health fragment from activity: $targetFragment")
            return true
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to start Mi Health fragment from activity: $targetFragment", error)
            RabiMobileUi.styleGuidance(
                this,
                guidanceView,
                "无法打开小米健康记录",
                "小米运动健康未安装、版本不支持这个页面入口，或厂商禁止第三方直接打开。",
                "先安装或更新小米运动健康；仍失败时回到 Rabi 的小米健康页，使用 Health Connect 或云端授权路线。",
                RabiGuidanceTone.ERROR,
            )
            return false
        }
    }

    private fun dp(value: Int): Int = RabiMobileUi.dp(this, value)

    private companion object {
        const val TAG = "RabiMiHealthLaunch"
        const val EXTRA_FRAGMENT = "fragment"
        const val EXTRA_TITLE = "title"
    }
}
