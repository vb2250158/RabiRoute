package com.rabi.link.modules.wearable

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.recording.AllDayRecordingSettings
import com.rabiroute.sdk.RabiWearableHealthClient
import kotlinx.coroutines.*

/** Not a Service: the conversation owner owns foreground lifetime and network event delivery. */
class WearableHealthController(context: Context, private val onChanged: Runnable) : AutoCloseable {
    @Volatile private var closed = false
    override fun close() { stop(); closed = true; scope.cancel(); main.removeCallbacksAndMessages(null) }
    private val context = context.applicationContext
    private val lock = Any()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var generation = 0L
    @Volatile private var active = false
    private var job: Job? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile var status: String = "健康采集未运行"; private set
    @Volatile var lastReceivedAt: Long = context.getSharedPreferences("rabilink_wearable_health", Context.MODE_PRIVATE)
        .getLong("lastReceivedAt", 0L); private set

    fun start() { synchronized(lock) { active = true }; syncNow() }
    fun stop() {
        synchronized(lock) { active = false; generation++; job?.cancel(); job = null }
        update("健康采集已暂停；待传记录保留")
    }
    /** Call only on explicit owner start, user request, or connectivity/platform event. No timer. */
    fun syncNow() {
        synchronized(lock) {
            val run = AllDayRecordingSettings.load(context)
            if (closed || (!run.uploadEnabled && (!active || !run.running || !run.healthEnabled || run.windowStartedAt <= 0))) {
                update("全天记录未允许健康采集"); return
            }
            if (job?.isActive == true) return
            val epoch = generation
            val window = run.windowStartedAt
            job = scope.launch {
                try {
                    val config = WearableHealthSettings.load(context)
                    val participationEpoch = context.getSharedPreferences("rabilink_wearable_health", Context.MODE_PRIVATE)
                        .getLong("participationStartedAt", 0L)
                    fun stillParticipating() = context.getSharedPreferences("rabilink_wearable_health", Context.MODE_PRIVATE)
                        .getLong("participationStartedAt", 0L) == participationEpoch
                    val collectAllowed = allowed(epoch, window) && config.collectorMode == WearableHealthCollectorMode.HEALTH_CONNECT
                    val queue = WearableHealthOutbox(context)
                    val relay = RabiLinkRelaySettings.load(context)
                    val frozenWorker = com.rabi.link.recording.TargetWorkerIdentity.load(context, relay.baseUrl, relay.token)
                    var collectionFailed = false
                    val samples = if (!collectAllowed) emptyList() else try {
                        val participation = context.getSharedPreferences("rabilink_wearable_health", Context.MODE_PRIVATE)
                            .getLong("participationStartedAt", 0L)
                        WearableHealthCollector.collect(context, config, maxOf(window, participation), System.currentTimeMillis())
                    } catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Throwable) { collectionFailed = true; emptyList() }
                    synchronized(lock) {
                        if (samples.isNotEmpty()) {
                            if (!allowed(epoch, window) || !stillParticipating()) return@launch
                            queue.save(config, samples, relay.baseUrl, window, relay.token, run.processingPolicy, run.routeProfileId, frozenWorker)
                            lastReceivedAt = samples.maxOf { java.time.Instant.parse(it.recordedAt).toEpochMilli() }
                            context.getSharedPreferences("rabilink_wearable_health", Context.MODE_PRIVATE).edit()
                                .putLong("lastReceivedAt", lastReceivedAt).commit()
                        }
                    }
                    update("已保存 ${samples.size} 条健康记录；准备同步")
                    if (!relay.configured) { update("健康记录仅存手机且未绑定；以后配置不会自动绑定旧记录"); return@launch }
                    val uploadClient = RabiWearableHealthClient()
                    var deferred = false
                    for (entry in queue.pending()) {
                        ensureActive()
                        if (!uploadAllowed(epoch)) return@launch
                        // Queue is transport-only, not a second health timeline. Freeze endpoint/device/policy.
                        if (entry.processingPolicy == "local_only") { deferred = true; continue }
                        if (entry.endpoint.isBlank() || entry.credentialIdentity.isBlank() || entry.workerId.isBlank() || entry.routeProfileId.isBlank() ||
                            entry.endpoint != relay.baseUrl || entry.credentialIdentity != WearableHealthOutbox.identity(relay.baseUrl, relay.token) ||
                            entry.workerId != com.rabi.link.recording.TargetWorkerIdentity.load(context, relay.baseUrl, relay.token)) {
                            deferred = true; update("存在未绑定或属于其他身份的本地记录，不会自动改投"); continue
                        }
                        uploadClient.publish(relay.baseUrl, relay.token,
                            entry.config.sourceDeviceId, entry.config.sourceDeviceKind, entry.config.sourceDeviceName,
                            entry.samples, entry.config.policy, entry.id, entry.capturedAt, "health-connect-phone",
                            entry.workerId, entry.processingPolicy, entry.routeProfileId)
                        synchronized(lock) {
                            if (!uploadAllowed(epoch)) return@launch
                            queue.ack(entry)
                        }
                    }
                    if (!closed && generation == epoch) update(if (collectionFailed)
                        "历史待传已处理；当前 Health Connect 采集失败，请检查权限和设备"
                        else if (deferred) "健康记录已保存在本机；部分仅本地或身份未绑定，不自动发送"
                        else "健康同步完成；等待下一次设备或网络事件")
                } catch (_: CancellationException) {
                    // Never publish late collection results or delete pending records on cancellation.
                } catch (error: Throwable) {
                    if (!closed && generation == epoch) update("健康记录保留，采集或同步失败：${error.javaClass.simpleName}")
                }
            }
        }
    }
    private fun uploadAllowed(epoch: Long) = !closed && generation == epoch && AllDayRecordingSettings.load(context).uploadEnabled
    private fun allowed(epoch: Long, window: Long): Boolean {
        val run = AllDayRecordingSettings.load(context)
        return active && generation == epoch && run.running && run.healthEnabled &&
            run.windowStartedAt == window && WearableHealthSettings.load(context).enabled
    }
    private fun update(text: String) {
        status = text
        WearableHealthSettings.saveLastStatus(context, text)
        main.post { onChanged.run() }
    }
}
