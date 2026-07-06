package com.rabi.link.modules.xiaomi

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Parcelable
import android.util.Log
import com.xiaomi.fitness.baseui.common.FragmentParams

class MiHealthFragmentLaunchActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Handler(Looper.getMainLooper()).postDelayed({
            launchMiHealthFragment()
            finish()
        }, 300L)
    }

    private fun launchMiHealthFragment() {
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
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to start Mi Health fragment from activity: $targetFragment", error)
        }
    }

    private companion object {
        const val TAG = "RabiMiHealthLaunch"
        const val EXTRA_FRAGMENT = "fragment"
        const val EXTRA_TITLE = "title"
    }
}
