package com.rabi.link.location

import android.content.Context
import android.hardware.*
import android.os.Handler
import android.os.SystemClock
import kotlin.math.abs
import kotlin.math.sqrt

/** Owned and stopped with LocationController. No permission, wake lock or Google Play dependency. */
class LocationMotionMonitor(context: Context, private val handler: Handler, private val moved: (Long) -> Unit) : AutoCloseable {
    private val sensors = context.getSystemService(SensorManager::class.java)
    private var active = false
    private var triggerSensor: Sensor? = null
    private var lastSignal = -15_000L
    private var burstStart = 0L
    private var burstCount = 0
    private val trigger: TriggerEventListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent?) { handler.post {
            if (active) { signal(); handler.postDelayed(rearm, 15_000) }
        } }
    }
    private val rearm: Runnable = Runnable { if (active) triggerSensor?.let { sensors?.requestTriggerSensor(trigger, it) } }
    private val listener = object : SensorEventListener {
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        override fun onSensorChanged(event: SensorEvent) {
            if (!active) return
            val v = event.values
            val magnitude = sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2])
            val acceleration = if (event.sensor.type == Sensor.TYPE_ACCELEROMETER) abs(magnitude - SensorManager.GRAVITY_EARTH) else magnitude
            val now = event.timestamp / 1_000_000
            if (acceleration < 0.8f) { burstCount = 0; return }
            if (burstCount == 0 || now - burstStart > 2_000) { burstStart = now; burstCount = 0 }
            if (++burstCount >= 3 && now - burstStart >= 300) { signal(); burstCount = 0 }
        }
    }
    fun start(): String {
        active = true
        triggerSensor = sensors?.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)
        if (triggerSensor?.let { sensors?.requestTriggerSensor(trigger, it) } == true) return "低功耗运动检测"
        triggerSensor = null
        val sensor = sensors?.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION) ?: sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        if (sensor != null && sensors?.registerListener(listener, sensor, 200_000, 1_000_000, handler) == true) return "加速度运动检测"
        return "无运动传感器，按定位结果调频"
    }
    private fun signal() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastSignal < 15_000) return
        lastSignal = now
        moved(now)
    }
    override fun close() {
        active = false
        handler.removeCallbacks(rearm)
        sensors?.unregisterListener(listener)
        triggerSensor?.let { sensors?.cancelTriggerSensor(trigger, it) }
    }
}
