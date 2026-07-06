package com.rabi.link.modules.xiaomi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class HealthConnectReadReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val heartRateHours = intent.getLongExtra("heart_rate_hours", 24L).coerceAtLeast(1L)
                val sleepHours = intent.getLongExtra("sleep_hours", 48L).coerceAtLeast(1L)
                val stepsHours = intent.getLongExtra("steps_hours", 24L).coerceAtLeast(1L)
                HealthConnectBackgroundProbe(context.applicationContext).run(
                    heartRateHours = heartRateHours,
                    sleepHours = sleepHours,
                    stepsHours = stepsHours
                )
            } finally {
                pendingResult.finish()
            }
        }
    }
}
