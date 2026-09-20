package com.rabi.link.recording

/** Presentation anchor only; record identity remains owned by the repository. */
object RecordingListPosition {
    fun restore(ids: List<String>, anchor: String?, selected: String?, browsing: Boolean): Int {
        val target = if(browsing) anchor else selected
        return if(target == null) -1 else ids.indexOf(target)
    }
}
