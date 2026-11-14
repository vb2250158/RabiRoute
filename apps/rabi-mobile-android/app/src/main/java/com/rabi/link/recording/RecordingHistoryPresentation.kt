package com.rabi.link.recording

import java.util.Calendar
import java.util.TimeZone

/** A local calendar day; the exclusive end also handles daylight-saving transitions. */
internal data class RecordingDay(val start: Long, val until: Long) {
    fun contains(time: Long) = time >= start && time < until
    companion object {
        fun at(time: Long, zone: TimeZone = TimeZone.getDefault()): RecordingDay {
            val calendar = Calendar.getInstance(zone).apply {
                timeInMillis = time
                set(Calendar.HOUR_OF_DAY,0); set(Calendar.MINUTE,0); set(Calendar.SECOND,0); set(Calendar.MILLISECOND,0)
            }
            val start = calendar.timeInMillis
            calendar.add(Calendar.DAY_OF_MONTH,1)
            return RecordingDay(start,calendar.timeInMillis)
        }
    }
}

/** Empty text alone never proves that transcription was unrequested or failed. */
internal fun recordingTranscriptStatus(policy: String, state: String, received: Boolean, text: String): String = when {
    text.isNotBlank() -> ""
    state in setOf("failed","blocked","ambiguous") -> "转写待核对"
    received || state == "completed" -> "识别完成，无文字"
    state == "processing" -> "正在转写"
    state == "retry" || state == "retry_wait" -> "等待重试"
    state == "pending" || state == "queued" || state == "deferred" -> "等待转写"
    state == "local_only" || policy == "local_only" -> "仅本地保存 · 未请求转写"
    state == "not_requested" -> "未请求转写"
    else -> "暂无转写结果"
}
