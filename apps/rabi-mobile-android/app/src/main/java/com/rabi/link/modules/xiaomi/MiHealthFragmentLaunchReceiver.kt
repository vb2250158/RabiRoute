package com.rabi.link.modules.xiaomi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Parcelable
import android.util.Log
import com.xiaomi.fitness.baseui.common.FragmentParams

class MiHealthFragmentLaunchReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
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
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("fragment_param", FragmentParams(targetFragment, extras, true, false) as Parcelable)
        }
        try {
            context.startActivity(launchIntent)
            Log.i(TAG, "Started Mi Health fragment: $targetFragment")
        } catch (error: Throwable) {
            Log.e(TAG, "Failed to start Mi Health fragment: $targetFragment", error)
        }
    }

    private companion object {
        const val TAG = "RabiMiHealthLaunch"
        const val EXTRA_FRAGMENT = "fragment"
        const val EXTRA_TITLE = "title"
    }
}
