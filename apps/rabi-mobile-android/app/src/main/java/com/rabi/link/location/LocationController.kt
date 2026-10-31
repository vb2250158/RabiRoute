package com.rabi.link.location

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import com.rabi.link.recording.AllDayRecordingSettings
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Owned only by RabiConversationService. No independent service, timer or restore intent. */
class LocationController(private val context: Context) : AutoCloseable {
    private val manager = context.getSystemService(LocationManager::class.java)
    private val thread = HandlerThread("rabi-location").apply { start() }
    private val handler = Handler(thread.looper)
    private val network = Executors.newSingleThreadExecutor()
    private val querying = AtomicBoolean(false)
    private val repository = LocationRepository(context)
    private val settings = LocationSettings(context)
    private var listener: LocationListener? = null
    private var previous: LocationPoint? = null
    private var sampling = MotionSamplingPolicy()
    private var motionMonitor: LocationMotionMonitor? = null
    private var requestedInterval = 0L
    private var sensorStatus = ""
    private var samplingStatus = ""
    private var tick: Runnable? = null
    @Volatile private var generation = 0L
    @Volatile private var active = false
    @Volatile private var closed = false
    @Volatile private var lookup: AmapLocationLookup? = null
    fun isActive() = active

    @Synchronized fun start() {
        if (closed) return
        if (active) { val epoch = generation; handler.post { reschedule(epoch) }; return }
        if (!settings.enabled && AllDayRecordingSettings.load(context).mode != "location") return
        if (!permitted(context)) { status("定位权限未授予，位置记录未启动"); return }
        active = true
        val epoch = ++generation
        handler.post {
            if (!accepts(epoch)) return@post
            previous = null
            sampling = MotionSamplingPolicy()
            requestedInterval = 0
            samplingStatus = ""
            val callback = object : LocationListener {
                override fun onLocationChanged(location: Location) = receive(epoch, location)
                override fun onProviderEnabled(provider: String) { if (accepts(epoch)) status("定位已开启，等待新位置") }
                override fun onProviderDisabled(provider: String) { if (accepts(epoch)) status("定位来源关闭，等待可用位置") }
                @Deprecated("Legacy platform callback") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
            }
            listener = callback
            try {
                motionMonitor = LocationMotionMonitor(context, handler) { now ->
                    if (accepts(epoch)) { sampling.motion(now); reschedule(epoch) }
                }
                sensorStatus = runCatching { motionMonitor!!.start() }.getOrElse { "运动检测不可用，按定位结果调频" }
                reschedule(epoch)
                if (!accepts(epoch)) return@post
                tick = object : Runnable {
                    override fun run() { if (accepts(epoch)) { reschedule(epoch); handler.postDelayed(this, 30_000) } }
                }.also { handler.postDelayed(it, 30_000) }
                status(if (manager?.isLocationEnabled == true) "等待定位 · 锁屏后继续记录" else "系统定位已关闭，请打开手机定位")
            } catch (_: Exception) {
                runCatching { manager?.removeUpdates(callback) }
                motionMonitor?.close(); motionMonitor = null
                active = false
                status("定位未启动，请检查权限和系统定位开关")
            }
        }
    }
    @Synchronized fun stop() {
        active = false
        ++generation
        lookup?.close()
        handler.post {
            tick?.let { handler.removeCallbacks(it) }; tick = null
            motionMonitor?.close(); motionMonitor = null
            listener?.let { runCatching { manager?.removeUpdates(it) } }; listener = null; previous = null
            requestedInterval = 0
            context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit().remove("locationSamplingStatus").remove("locationSamplingIntervalMs").apply()
            status("位置记录已暂停")
        }
    }
    @Synchronized private fun reschedule(epoch: Long) {
        if (!accepts(epoch)) return
        val callback = listener ?: return
        val decision = sampling.decision(SystemClock.elapsedRealtime(), settings.sampling)
        if (requestedInterval != decision.intervalMs) {
            manager?.removeUpdates(callback)
            val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { manager?.allProviders?.contains(it) == true }
            var registered = false
            providers.forEach { provider ->
                if (runCatching { manager?.requestLocationUpdates(provider, decision.intervalMs, 0f, callback, thread.looper) }.isSuccess) registered = true
            }
            if (!registered) { stop(); status("定位未启动，请检查权限和系统定位开关"); return }
            requestedInterval = decision.intervalMs
        }
        val summary = "${decision.reason} · 目标间隔 ${decision.intervalMs / 1000} 秒 · $sensorStatus"
        if (summary != samplingStatus) {
            samplingStatus = summary
            context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit()
                .putString("locationSamplingStatus", summary).putLong("locationSamplingIntervalMs", decision.intervalMs).apply()
            changed()
        }
    }
    private fun accepts(epoch: Long) = !closed && active && epoch == generation && AllDayRecordingSettings.load(context).running
    @Synchronized private fun receive(epoch: Long, location: Location) {
        if (!accepts(epoch)) return
        val point = LocationPoint(location.time, location.elapsedRealtimeNanos, location.latitude, location.longitude, location.accuracy, location.provider.orEmpty())
        val now = SystemClock.elapsedRealtimeNanos()
        if (!LocationPolicy.valid(point, now)) return
        val config = settings.sampling
        sampling.observe(point, location.speed.takeIf { location.hasSpeed() },
            location.speedAccuracyMetersPerSecond.takeIf { location.hasSpeedAccuracy() }, config)
        reschedule(epoch)
        if (!LocationPolicy.accept(point, previous, now, config)) return
        try {
            val id = repository.add(point)
            previous = point
            context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit().putLong("locationLastReceivedAt", point.time).apply()
            status("位置已保存 · 精度约 ${point.accuracy.toInt()} 米")
            enrich(epoch, id, point)
        } catch (_: Exception) { status("位置保存失败，请检查手机可用空间") }
    }
    private fun enrich(epoch: Long, id: Long, point: LocationPoint) {
        if (!settings.addresses || !settings.hasKey || point.accuracy > LocationPolicy.CACHE_RADIUS_METERS) return
        val now = System.currentTimeMillis()
        repository.cached(point, now)?.let { repository.label(id, point, it, false); changed(); return }
        val prefs = context.getSharedPreferences("rabi_location", Context.MODE_PRIVATE)
        if (!LocationPolicy.addressDue(now, prefs.getLong("lastAddressAttempt", 0)) || !querying.compareAndSet(false, true)) return
        if (!prefs.edit().putLong("lastAddressAttempt", now).commit()) { querying.set(false); status("地址查询状态保存失败，GPS 继续记录"); return }
        network.execute {
            try {
                if (!accepts(epoch) || !settings.addresses) return@execute
                val key = settings.key()
                val request = AmapLocationLookup(context, {
                    accepts(epoch) && settings.addresses && repository.reserveRequest(System.currentTimeMillis(), settings.monthlyLimit)
                })
                lookup = request
                val label = request.use { it.resolve(key, point) }
                if (accepts(epoch) && settings.addresses) {
                    repository.label(id, point, label, true)
                    status("位置与地点名称已保存")
                }
            } catch (error: Exception) {
                if (accepts(epoch)) status(if (error is IllegalStateException || error is IllegalArgumentException)
                    error.message?.takeIf { !it.contains("http") && !it.contains("key=", true) } ?: "地址查询失败，GPS 继续记录"
                    else "Key 无法读取，请重新输入；GPS 继续记录")
            } finally { lookup = null; querying.set(false) }
        }
    }
    private fun status(message: String) {
        if (closed) return
        context.getSharedPreferences("rabi_conversation_runtime", Context.MODE_PRIVATE).edit().putString("locationStatus", message).apply()
        changed()
    }
    private fun changed() { context.sendBroadcast(Intent("com.rabi.link.conversation.RUNTIME_UPDATED").setPackage(context.packageName)) }
    @Synchronized override fun close() {
        if (closed) return
        stop()
        closed = true
        // Drain callbacks before closing SQLite; an in-flight bounded HTTP call may finish later.
        handler.post { network.execute { repository.close() }; network.shutdown(); thread.quitSafely() }
    }
    companion object {
        @JvmStatic fun permitted(context: Context) = context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        @JvmStatic fun requested(context: Context) = LocationSettings(context).enabled || AllDayRecordingSettings.load(context).mode == "location"
    }
}
