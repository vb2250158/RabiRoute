package com.rabi.link.recording

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** One durable manifest per explicit recording session. Media remains in its original directory. */
class RecordingStore(private val context: Context) {
    data class Entry(val id: String, val kind: String, val source: String, val started: Long,
        val ended: Long, val state: String, val directory: File, val files: List<File>, val title: String)
    private val root = File(context.filesDir, "rabi-records").apply { mkdirs() }
    fun create(kind: String, source: String): Entry = create(kind, source, null)
    fun create(kind: String, source: String, binding: JSONObject?): Entry {
        val id = UUID.randomUUID().toString()
        val directory = if (kind == "video") File(context.filesDir, "rabi-live-recordings/sessions/$id") else File(root, "$id/media")
        check(directory.mkdirs() || directory.isDirectory)
        val data = JSONObject().put("id", id).put("kind", kind).put("source", source)
            .put("started", System.currentTimeMillis()).put("ended", 0).put("state", "recording")
            .put("directory", directory.relativeTo(context.filesDir).path)
        if (binding != null) data.put("processingBinding", JSONObject(binding.toString()))
        write(id, data)
        return read(File(root, "$id/session.json"))!!
    }
    @Synchronized fun finish(id: String, state: String) {
        val path = File(root, "$id/session.json")
        val data = JSONObject(AtomicFile(path).openRead().bufferedReader().use { it.readText() })
        data.put("ended", System.currentTimeMillis()).put("state", state)
        write(id, data)
    }
    fun boundVideoSessions(): List<JSONObject> = root.listFiles().orEmpty().mapNotNull { directory ->
        val file = File(directory, "session.json")
        if (!file.isFile) return@mapNotNull null
        val data = JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() })
        if (data.optString("kind") == "video" && data.has("processingBinding")) data else null
    }
    fun captureId(sessionId: String): String {
        require(sessionId.matches(Regex("[A-Za-z0-9_-]{1,100}")))
        val path = File(root, "$sessionId/session.json")
        if(!path.isFile) return sessionId
        val data = JSONObject(AtomicFile(path).openRead().bufferedReader().use { it.readText() })
        return data.optJSONObject("processingBinding")?.optString("captureId")?.takeIf { it.isNotBlank() } ?: sessionId
    }
    private fun write(id: String, data: JSONObject) {
        val path = File(root, "$id/session.json"); path.parentFile!!.mkdirs()
        val atomic = AtomicFile(path); val output = atomic.startWrite()
        try { output.write(data.toString().toByteArray()); atomic.finishWrite(output) }
        catch (error: Exception) { atomic.failWrite(output); throw error }
    }
    private fun read(path: File, from: Long = 0, to: Long = Long.MAX_VALUE): Entry? = runCatching {
        val data = JSONObject(AtomicFile(path).openRead().bufferedReader().use { it.readText() })
        val started = data.getLong("started")
        val ended = data.optLong("ended")
        if(started > to || (ended > 0 && ended < from)) return@runCatching null
        val dir = File(context.filesDir, data.getString("directory")).canonicalFile
        check(dir.toPath().startsWith(context.filesDir.canonicalFile.toPath()))
        Entry(data.getString("id"), data.getString("kind"), data.getString("source"), data.getLong("started"),
            data.optLong("ended"), data.optString("state"), dir,
            (dir.walkTopDown().filter { it.isFile && it.extension in listOf("mp4", "wav") }.toList() + RecordingResourceCache.archivedFiles(context,dir)).distinct().sortedBy { it.name }, data.optString("title"))
    }.getOrNull()
    data class Marker(val id: String, val recordId: String, val at: Long)
    /** Read existing bookmarks only; a corrupt item fails visibly without rewriting source data. */
    fun listMarkers(): List<Marker> = File(context.filesDir, "rabi-record-markers").listFiles().orEmpty()
        .filter { it.isFile && it.extension == "json" }
        .map { path ->
            val data = JSONObject(path.bufferedReader().use { it.readText() })
            check(data.getString("kind") == "bookmark") { "未知标记类型" }
            Marker(data.getString("id"), data.optString("recordId"), data.getLong("at"))
        }.sortedByDescending { it.at }

    @JvmOverloads fun list(from: Long = 0, to: Long = Long.MAX_VALUE): List<Entry> {
        val sessions = root.listFiles().orEmpty().mapNotNull { read(File(it, "session.json"), from, to) }
        val oldRoot = File(context.filesDir, "rabi-live-recordings/rabi")
        val oldFiles = oldRoot.walkTopDown().filter { it.isFile && it.extension == "mp4" }.sortedBy { it.name }.toList()
        val legacy = if (oldFiles.isEmpty()) emptyList() else listOf(Entry("legacy-archive", "video", "glasses",
            oldFiles.maxOf { it.lastModified() }, oldFiles.maxOf { it.lastModified() }, "legacy", oldRoot, oldFiles, "历史视频"))
        return (sessions + legacy).sortedByDescending { it.started }
    }
    fun page(time: Long, cursorId: String, older: Boolean, sourceFilter: Int, videoOnly: Boolean = false): List<Entry> {
        val candidates = root.listFiles().orEmpty().mapNotNull { directory ->
            val file = File(directory,"session.json")
            if(!file.isFile) return@mapNotNull null
            val data = JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() })
            if(videoOnly && data.optString("kind") != "video") return@mapNotNull null
            if(data.optString("state") == "recording") return@mapNotNull null
            if(sourceFilter != 0 && (sourceFilter == 2) != (data.optString("source") == "glasses")) return@mapNotNull null
            val started = data.getLong("started"); val id = data.getString("id")
            val order = if(started == time) id.compareTo(cursorId) else started.compareTo(time)
            if(if(older) order >= 0 else order <= 0) null else Triple(started,id,file)
        }
        val legacy = if(sourceFilter == 1) emptyList() else File(context.filesDir,"rabi-live-recordings/rabi").walkTopDown()
            .filter { it.isFile && it.extension == "mp4" }.map { Triple(it.lastModified(),it.name,it) }.filter {
                val order = if(it.first == time) it.second.compareTo(cursorId) else it.first.compareTo(time)
                if(older) order < 0 else order > 0
            }.toList()
        val sorted = (candidates + legacy).sortedWith(compareBy<Triple<Long,String,File>> { it.first }.thenBy { it.second })
        return (if(older) sorted.asReversed() else sorted).asSequence().mapNotNull {
            if(it.third.extension == "mp4") Entry(it.second,"video","glasses",it.first,it.first,"legacy-part",it.third.parentFile!!,listOf(it.third),"历史视频") else read(it.third)
        }.filter { it.files.isNotEmpty() }.take(101).toList()
    }
}
