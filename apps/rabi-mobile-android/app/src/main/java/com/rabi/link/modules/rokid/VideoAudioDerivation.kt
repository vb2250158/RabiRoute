package com.rabi.link.modules.rokid

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Deferred video audio processing. submit accepts ONLY files from a session whose
 * receiver process has exited. Never opens a microphone or changes live spool context.
 * Raw files are retained; derived PCM is atomically published with a durable task.
 */
class VideoAudioDerivation(context: Context, private val onChanged: Runnable) : AutoCloseable {
    fun interface Importer {
        /** Return true only after an idempotent durable import, keyed by recordId. */
        fun importPcm(source: String, route: String, policy: String, recordId: String, pcmFile: File): Boolean
    }
    private val app = context.applicationContext
    private val root = File(app.filesDir, "video-audio-derivation").apply { mkdirs() }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var closed = false
    @Volatile var status: String = "尚无视频音轨处理任务"; private set
    private fun report(message: String) {
        if (status != message) { status = message; changed() }
    }

    /** Freeze these arguments at video START, not from the currently selected chat. */
    fun submit(sessionId: String, source: String, route: String, policy: String, recordId: String, files: List<File>) {
        if (closed) return
        worker.execute {
            files.sortedBy { it.name }.forEach { file ->
                if (closed) return@execute
                try {
                    val canonical = file.canonicalFile
                    check(canonical.toPath().startsWith(app.filesDir.canonicalFile.toPath()))
                    check(canonical.isFile && canonical.extension.equals("mp4", true))
                    val hash = hashFile(canonical)
                    val id = taskId(sessionId, canonical.relativeTo(app.filesDir).path, hash)
                    val manifest = File(root, "$id.json")
                    val previous = if (manifest.exists()) read(manifest) else null
                    if (previous != null) {
                        check(previous.getString("source") == source && previous.getString("route") == route &&
                            previous.getString("policy") == policy && previous.getString("recordId") == "$recordId:$id") {
                            "Video task binding conflict"
                        }
                        if (previous.optString("state") in listOf("ready", "imported", "no_audio")) return@forEach
                    }
                    val task = previous ?: JSONObject().put("taskId", id).put("sessionId", sessionId)
                        .put("source", source).put("route", route).put("policy", policy).put("recordId", "$recordId:$id")
                        .put("media", canonical.relativeTo(app.filesDir).path).put("mediaSha256", hash)
                    task.put("state", "decoding"); save(manifest, task)
                    derive(manifest, task, canonical)
                } catch (_: Exception) { report("视频音轨任务准备失败，原录像保留") /* Continue later segments. */ }
            }
        }
    }

    private fun recoverBoundSessions() {
        val store = com.rabi.link.recording.RecordingStore(app)
        for (session in store.boundVideoSessions()) {
            // Never infer closure from wall-clock age or from the current selected Route.
            if (session.optString("state") == "recording") {
                val dir = File(app.filesDir, session.getString("directory")).canonicalFile
                check(dir.toPath().startsWith(app.filesDir.canonicalFile.toPath()))
                val proof = File(dir, "receiver-process.stat")
                if (!proof.isFile) { report("录像退出证据缺失，保留原文件不自动转写"); continue }
                val identity = ReceiverProcessIdentity.parse(proof.readText())
                val current = File("/proc/${identity.pid}/stat")
                val sameProcess = if (current.exists()) try { identity.sameProcess(ReceiverProcessIdentity.parse(current.readText())) }
                    catch (_: Exception) { true } else false
                if (sameProcess) continue
                store.finish(session.getString("id"), "interrupted")
                session.put("state", "interrupted")
            }
            if (session.optString("state") !in listOf("saved", "interrupted")) continue
            val binding = session.getJSONObject("processingBinding")
            val id = session.getString("id")
            enqueueFinalized(app, id)
            val directory = File(app.filesDir, session.getString("directory")).canonicalFile
            check(directory.toPath().startsWith(app.filesDir.canonicalFile.toPath()))
            submit(id, binding.getString("source"), binding.getString("route"), binding.getString("policy"),
                binding.getString("captureId"), directory.walkTopDown().filter { it.isFile && it.extension == "mp4" }.toList())
        }
    }

    /** Recover tasks and explicitly finalized session bindings without opening capture hardware. */
    fun resume() {
        if (closed) return
        worker.execute {
            try { recoverBoundSessions() } catch (_: Exception) { report("视频会话恢复失败，原绑定保留") }
            root.listFiles().orEmpty().filter { it.extension == "json" }.forEach { manifest ->
                if (closed) return@execute
                try {
                    val task = read(manifest)
                    if (task.optString("state") !in listOf("decoding", "failed")) return@forEach
                    val media = File(app.filesDir, task.getString("media")).canonicalFile
                    check(media.toPath().startsWith(app.filesDir.canonicalFile.toPath()))
                    check(hashFile(media) == task.getString("mediaSha256"))
                    derive(manifest, task, media)
                } catch (_: Exception) { report("视频音轨任务暂无法处理，已保留待重试") }
            }
        }
    }

    /** Call on queue-ready/network events; not a periodic polling loop. */
    fun drainReady(importer: Importer) {
        if (closed) return
        worker.execute {
            root.listFiles().orEmpty().filter { it.extension == "json" }.sortedBy { it.name }.forEach { manifest ->
                if (closed) return@execute
                try {
                    val task = read(manifest)
                    if (task.optString("state") != "ready") return@forEach
                    val pcm = File(root, task.getString("taskId") + ".pcm")
                    check(pcm.isFile && pcm.length() == task.getLong("bytes") && hashFile(pcm) == task.getString("pcmSha256"))
                    if (importer.importPcm(task.getString("source"), task.getString("route"), task.getString("policy"), task.getString("recordId"), pcm)) {
                        task.put("state", "imported"); save(manifest, task); report("视频音轨已交给可靠上传队列")
                    }
                } catch (_: Exception) { report("视频音轨任务暂无法处理，已保留待重试") }
            }
        }
    }

    private fun derive(manifest: File, task: JSONObject, media: File) {
        val partial = File(root, task.getString("taskId") + ".pcm.partial")
        val destination = File(root, task.getString("taskId") + ".pcm")
        try {
            val hasAudio = FileOutputStream(partial).use { output ->
                val result = decode(media, output)
                output.fd.sync()
                result
            }
            if (closed) throw InterruptedException("closed")
            if (!hasAudio) {
                task.put("state", "no_audio")
            } else {
                check(partial.length() > 0L && partial.length() % 2L == 0L) { "Empty decoded audio" }
                check(partial.renameTo(destination)) { "Cannot publish decoded PCM" }
                task.put("state", "ready").put("bytes", destination.length()).put("pcmSha256", hashFile(destination))
            }
            save(manifest, task)
        } catch (_: Exception) {
            task.put("state", "failed").put("error", if (closed) "interrupted" else "audio_derivation_failed")
            save(manifest, task)
        }
        report(when (task.optString("state")) {
            "ready" -> "视频音轨已保存，等待可靠导入"
            "no_audio" -> "录像没有音轨，不进行转写"
            else -> "视频音轨处理失败，原录像保留待重试"
        })
        // Each new ready task must wake the consumer, even when the summary text is unchanged.
        if (task.optString("state") == "ready") changed()
    }

    private fun decode(media: File, output: FileOutputStream): Boolean {
        val extractor = MediaExtractor()
        var codec: MediaCodec? = null
        try {
            extractor.setDataSource(media.absolutePath)
            val track = (0 until extractor.trackCount).firstOrNull {
                isAudioMime(extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME))
            } ?: return false
            extractor.selectTrack(track)
            val inputFormat = extractor.getTrackFormat(track)
            val decoder = MediaCodec.createDecoderByType(inputFormat.getString(MediaFormat.KEY_MIME)!!)
            codec = decoder
            decoder.configure(inputFormat, null, null, 0); decoder.start()
            var inputDone = false
            var outputDone = false
            var resampler: VideoPcmResampler? = null
            val info = MediaCodec.BufferInfo()
            var lastProgress = SystemClock.elapsedRealtime()
            var totalBytes = 0L
            while (!outputDone) {
                if (closed) throw InterruptedException("closed")
                check(SystemClock.elapsedRealtime() - lastProgress < 30000L) { "Decoder stalled" }
                if (!inputDone) {
                    val index = decoder.dequeueInputBuffer(10000)
                    if (index >= 0) {
                        val buffer = decoder.getInputBuffer(index)!!
                        val count = extractor.readSampleData(buffer, 0)
                        if (count < 0) { decoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); inputDone = true }
                        else { decoder.queueInputBuffer(index, 0, count, extractor.sampleTime, 0); extractor.advance() }
                        lastProgress = SystemClock.elapsedRealtime()
                    }
                }
                val index = decoder.dequeueOutputBuffer(info, 10000)
                if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    resampler?.finish(output)
                    val format = decoder.outputFormat
                    val encoding = if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) format.getInteger(MediaFormat.KEY_PCM_ENCODING) else AudioFormat.ENCODING_PCM_16BIT
                    check(encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT) { "Unsupported PCM encoding" }
                    resampler = VideoPcmResampler(format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT), encoding == AudioFormat.ENCODING_PCM_FLOAT)
                    lastProgress = SystemClock.elapsedRealtime()
                } else if (index >= 0) {
                    try {
                        if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
                            check(resampler != null) { "Missing decoded format" }
                            val buffer: ByteBuffer = decoder.getOutputBuffer(index)!!
                            buffer.position(info.offset); buffer.limit(info.offset + info.size)
                            totalBytes += info.size
                            check(totalBytes <= 512L * 1024 * 1024) { "Segment exceeds decode budget" }
                            check(root.usableSpace >= 256L * 1024 * 1024) { "Insufficient storage" }
                            resampler!!.accept(buffer, output)
                        }
                        outputDone = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        lastProgress = SystemClock.elapsedRealtime()
                    } finally { decoder.releaseOutputBuffer(index, false) }
                }
            }
            resampler?.finish(output)
            return true
        } finally {
            try { codec?.stop() } catch (_: Exception) { }
            codec?.release(); extractor.release()
        }
    }

    private fun changed() { main.post { if (!closed) onChanged.run() } }
    private fun read(file: File) = JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() })
    private fun save(file: File, task: JSONObject) {
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try { output.write(task.toString().toByteArray(Charsets.UTF_8)); atomic.finishWrite(output) }
        catch (error: Exception) { atomic.failWrite(output); throw error }
    }
    override fun close() { closed = true; worker.shutdown() }

    companion object {
        /** Durable enqueue barrier, invoked after process exit and before onStopped. */
        @JvmStatic fun enqueueFinalized(context: Context, sessionId: String) {
            val session = com.rabi.link.recording.RecordingStore(context).boundVideoSessions()
                .firstOrNull { it.getString("id") == sessionId } ?: return
            check(session.optString("state") in listOf("saved", "interrupted"))
            val queue = File(context.filesDir, "video-audio-session-queue").apply { mkdirs() }
            val atomic = AtomicFile(File(queue, "$sessionId.json"))
            val output = atomic.startWrite()
            try { output.write(session.toString().toByteArray(Charsets.UTF_8)); atomic.finishWrite(output) }
            catch (error: Exception) { atomic.failWrite(output); throw error }
        }
        @JvmStatic fun isAudioMime(mime: String?) = mime?.startsWith("audio/") == true
        @JvmStatic fun taskId(sessionId: String, path: String, sha256: String): String =
            MessageDigest.getInstance("SHA-256").digest("$sessionId\u0000$path\u0000$sha256".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        private fun hashFile(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
            }
            return digest.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
