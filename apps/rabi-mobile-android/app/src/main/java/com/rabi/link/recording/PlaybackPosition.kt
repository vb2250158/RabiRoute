package com.rabi.link.recording

/** Maps a scrub position across original media parts without rewriting their files. */
object PlaybackPosition {
    data class Position(val index: Int, val offsetMs: Long)
    fun locate(durations: List<Long>, positionMs: Long): Position {
        require(durations.isNotEmpty() && durations.all { it > 0 })
        var remaining = positionMs.coerceIn(0, durations.sum())
        durations.forEachIndexed { index, duration ->
            if(remaining < duration || index == durations.lastIndex) return Position(index, remaining.coerceAtMost(duration))
            remaining -= duration
        }
        error("unreachable")
    }
}
