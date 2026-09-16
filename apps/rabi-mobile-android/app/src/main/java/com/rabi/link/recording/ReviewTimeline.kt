package com.rabi.link.recording

/** Wall-clock navigation, newest on the right. Missing coverage remains a gap. */
object ReviewTimeline {
    data class Span(val start: Long, val duration: Long, val mediaOffset: Long = 0) {
        fun contains(time: Long) = duration > 0 && time >= start && time - start < duration
    }
    fun mediaAt(spans: List<Span>, time: Long): Long? = spans.firstOrNull { it.contains(time) }?.let { it.mediaOffset + time - it.start }
    fun timeFor(spans: List<Span>, media: Long): Long? = spans.firstOrNull {
        media >= it.mediaOffset && media - it.mediaOffset < it.duration
    }?.let { it.start + media - it.mediaOffset }
}
