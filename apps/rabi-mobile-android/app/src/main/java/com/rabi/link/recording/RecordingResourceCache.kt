package com.rabi.link.recording

import android.content.Context
import android.os.FileObserver
import android.util.AtomicFile
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.transport.AsrDirectory
import com.rabi.link.transport.RabiSpeechTunnel
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Owns durable remote references. Local eviction never removes timeline metadata. */
object RecordingResourceCache {
    private var app: Context? = null
    private var observer: FileObserver? = null
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val queued = AtomicBoolean(false)
    private var deadline: java.util.concurrent.ScheduledFuture<*>? = null
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun prefs(context: Context) = context.getSharedPreferences("recording_resource_cache",Context.MODE_PRIVATE)
    fun enabled(context: Context) = prefs(context).getBoolean("enabled",false)
    fun hours(context: Context) = prefs(context).getInt("hours",24).coerceIn(0,168)
    fun save(context: Context, enabled: Boolean, hours: Int) {
        check(prefs(context).edit().putBoolean("enabled",enabled).putInt("hours",hours.coerceIn(0,168)).commit())
        start(context); kick()
    }
    @JvmStatic @Synchronized fun start(context: Context) {
        app = context.applicationContext
        if(observer == null) {
            val root = File(context.filesDir,"rabi-conversation/audio-spool/segments").apply { mkdirs() }
            observer = object : FileObserver(root,CLOSE_WRITE or MOVED_TO) { override fun onEvent(event: Int,path: String?) { kick() } }.also { it.startWatching() }
        }
        kick()
    }
    @JvmStatic fun kick() {
        val context=app ?: return
        if(!enabled(context) || !queued.compareAndSet(false,true)) return
        synchronized(this) { deadline?.cancel(false); deadline=null }
        executor.schedule({
            var retry=false
            try { run(context) }
            catch(error: Exception) { retry=true; prefs(context).edit().putString("status","等待电脑连接：${error.message.orEmpty().take(120)}").apply() }
            finally {
                queued.set(false)
                // Retention deadline, and bounded retry after unavailable storage; not a discovery poll.
                synchronized(this) { deadline?.cancel(false); deadline=executor.schedule({ kick() },if(retry) 60 else 3600,TimeUnit.SECONDS) }
            }
        },2,TimeUnit.SECONDS)
    }
    private fun relative(context: Context,file: File): String {
        require(file.canonicalFile.toPath().startsWith(context.filesDir.canonicalFile.toPath()))
        return file.canonicalFile.relativeTo(context.filesDir.canonicalFile).invariantSeparatorsPath
    }
    private fun index(context: Context,file: File) = File(context.filesDir,"recording-resource-index/${hash(relative(context,file).toByteArray())}.json")
    private fun receipt(context: Context,file: File): JSONObject? = runCatching {
        val value=JSONObject(AtomicFile(index(context,file)).openRead().bufferedReader().use { it.readText() })
        check(value.getString("path")==relative(context,file) && value.getJSONArray("chunks").length()>0)
        value
    }.getOrNull()
    @JvmStatic fun resolve(file: File): File = if(file.isFile) file else materialize(requireNotNull(app),file)
    @JvmStatic fun isArchived(file: File): Boolean = app?.let { receipt(it,file)!=null } ?: false
    private fun persist(context: Context,file: File,value: JSONObject) {
        val target=index(context,file); target.parentFile!!.mkdirs(); val atomic=AtomicFile(target); val output=atomic.startWrite()
        try { output.write(value.toString().toByteArray()); atomic.finishWrite(output) } catch(error: Exception) { atomic.failWrite(output); throw error }
    }
    private data class Candidate(val file: File,val ended: Long,val duration: Long = 0)
    private fun candidates(context: Context): List<Candidate> {
        val root=File(context.filesDir,"rabi-conversation/audio-spool/segments")
        val audio=root.listFiles { f -> f.extension=="json" }.orEmpty().mapNotNull { metadata -> runCatching {
            val row=JSONObject(metadata.readText());
            if(row.optString("captureId").isBlank() || row.optString("uploadState")!="acked" && row.optString("processingPolicy")!="local_only") return@runCatching null
            val file=File(root,row.getString("pcmFileName")).canonicalFile
            check(file.parentFile==root.canonicalFile)
            Candidate(file,row.getLong("endedAt"))
        }.getOrNull() }
        val video=RecordingStore(context).list().filter { it.kind=="video" && it.state!="recording" }.flatMap { entry -> entry.files.map { file ->
            Candidate(file,entry.ended.takeIf { it>0 } ?: file.lastModified(),duration(context,file))
        } }
        return (audio+video).sortedBy { it.ended }
    }
    private fun safeToEvict(context: Context,file: File): Boolean {
        if(file.extension != "mp4") return true
        return File(context.filesDir,"video-audio-derivation").listFiles().orEmpty().any { manifest ->
            runCatching { val row=JSONObject(manifest.readText()); File(context.filesDir,row.getString("media")).canonicalFile==file.canonicalFile && row.optString("state") in listOf("imported","no_audio") }.getOrDefault(false)
        }
    }
    private fun run(context: Context) {
        if(!enabled(context)) return
        val relay=RabiLinkRelaySettings.load(context); check(relay.configured) { "尚未配置 RabiLink" }
        val state=RabiRouteSdk().getMobileState(relay.baseUrl,relay.token)
        val worker=state.selectedWorker ?: error("尚未选择电脑")
        val scope=AsrDirectory.accountIdentity(relay.baseUrl,relay.token)
        prefs(context).edit().putString("status","正在保存到电脑…").apply()
        RabiSpeechTunnel(context,relay,worker,"resources").use { tunnel ->
            for(candidate in candidates(context)) {
                if(!enabled(context)) break
                val file=candidate.file
                var value=receipt(context,file)
                if(value==null) {
                    if(!file.isFile || file.length()==0L) continue
                    val chunks=JSONArray(); val expected=file.length(); var total=0L
                    file.inputStream().use { input ->
                        val buffer=ByteArray(1024*1024)
                        while(true) {
                            check(enabled(context)) { "电脑缓存已关闭" }; val count=input.read(buffer); if(count<0) break
                            val bytes=buffer.copyOf(count); val id=hash(bytes)
                            val response=tunnel.request("PUT","/objects/$id","application/octet-stream",bytes)
                            check(response.status==200) { "电脑保存失败 (${response.status})" }
                            val ack=JSONObject(String(response.body))
                            check(ack.optBoolean("durable") && ack.getString("sha256")==id && ack.getLong("bytes")==count.toLong())
                            chunks.put(JSONObject().put("id",id).put("bytes",count)); total+=count
                        }
                    }
                    check(total==expected && file.length()==expected)
                    value=JSONObject().put("path",relative(context,file)).put("bytes",total).put("chunks",chunks)
                        .put("scope",scope).put("worker",worker.rawJson).put("workerId",worker.id).put("duration",candidate.duration).put("savedAt",System.currentTimeMillis())
                    persist(context,file,value)
                }
                val confirmed = requireNotNull(value)
                if(enabled(context) && file.isFile && safeToEvict(context,file) && candidate.ended>0 && System.currentTimeMillis()-candidate.ended>=hours(context)*3600000L) {
                    // The receipt identifies the original PC, even after the selected PC changes.
                    if(confirmed.getString("scope")!=scope || confirmed.getString("workerId")!=worker.id) continue
                    val chunks=confirmed.getJSONArray("chunks")
                    for(i in 0 until chunks.length()) {
                        val item=chunks.getJSONObject(i); val response=tunnel.request("GET","/objects/${item.getString("id")}","application/octet-stream",byteArrayOf())
                        check(response.status==200 && response.body.size.toLong()==item.getLong("bytes") && hash(response.body)==item.getString("id")) { "电脑文件校验失败，本地保留" }
                    }
                    check(file.length()==confirmed.getLong("bytes"))
                    if(file.extension=="pcm") com.rabi.link.RabiConversationService.evictArchivedAudio(file)
                    else check(file.delete()) { "本地文件正在使用，稍后清理" }
                }
            }
        }
        prefs(context).edit().putString("status","电脑缓存已同步").apply()
    }
    fun duration(context: Context,file: File): Long = receipt(context,file)?.optLong("duration")?.takeIf { it>0 }
        ?: runCatching { RecordedMedia.duration(file) }.getOrDefault(0)
    fun archivedFiles(context: Context,directory: File): List<File> = File(context.filesDir,"recording-resource-index").listFiles().orEmpty().mapNotNull { index ->
        runCatching { val value=JSONObject(index.readText()); val file=File(context.filesDir,value.getString("path")).canonicalFile
            file.takeIf { it.toPath().startsWith(directory.canonicalFile.toPath()) && !it.exists() }
        }.getOrNull()
    }
    private fun verified(file: File,value: JSONObject): Boolean = runCatching {
        if(file.length()!=value.getLong("bytes")) return@runCatching false
        file.inputStream().use { input ->
            val chunks=value.getJSONArray("chunks")
            for(i in 0 until chunks.length()) {
                val chunk=chunks.getJSONObject(i); val buffer=ByteArray(chunk.getInt("bytes")); var offset=0
                while(offset<buffer.size) { val count=input.read(buffer,offset,buffer.size-offset); check(count>0); offset+=count }
                check(hash(buffer)==chunk.getString("id"))
            }
        }; true
    }.getOrDefault(false)
    /** Verified, replaceable playback cache. Does not change the durable recording path. */
    @JvmStatic @Synchronized fun materialize(context: Context,file: File): File {
        if(file.isFile) return file
        val value=receipt(context,file) ?: error("本地媒体不存在，且没有电脑保存回执")
        val destination=File(context.cacheDir,"recording-playback/${index(context,file).nameWithoutExtension}.${file.extension}")
        if(destination.isFile && verified(destination,value)) { destination.setLastModified(System.currentTimeMillis()); return destination }
        val relay=RabiLinkRelaySettings.load(context)
        check(value.getString("scope")==AsrDirectory.accountIdentity(relay.baseUrl,relay.token)) { "请连接保存此记录的 RabiLink" }
        val cachedWorker=value.optJSONObject("worker")
        val worker=if(cachedWorker!=null) com.rabiroute.sdk.RabiLinkPc(value.getString("workerId"),"",cachedWorker.optString("name"),"","",true,"",cachedWorker)
            else RabiRouteSdk().getMobileState(relay.baseUrl,relay.token).workers.firstOrNull { it.id==value.getString("workerId") } ?: error("保存此记录的电脑不可用")
        destination.parentFile!!.mkdirs()
        // Old replay files are replaceable; leave recent playback/export handles undisturbed.
        destination.parentFile!!.listFiles().orEmpty().filter { it != destination && System.currentTimeMillis()-it.lastModified()>24*3600000L }.forEach { it.delete() }
        check(destination.parentFile!!.usableSpace>value.getLong("bytes")+64*1024*1024) { "回看缓存空间不足" }
        val temporary=File(destination.path+".partial")
        try {
            RabiSpeechTunnel(context,relay,worker,"resources").use { tunnel -> temporary.outputStream().use { output ->
                val chunks=value.getJSONArray("chunks")
                for(i in 0 until chunks.length()) {
                    val item=chunks.getJSONObject(i); val response=tunnel.request("GET","/objects/${item.getString("id")}","application/octet-stream",byteArrayOf())
                    check(response.status==200 && response.body.size.toLong()==item.getLong("bytes") && hash(response.body)==item.getString("id")) { "电脑离线或缓存读取失败，请重试" }
                    output.write(response.body)
                }
                output.fd.sync()
            } }
            check(temporary.length()==value.getLong("bytes")); check(temporary.renameTo(destination))
            return destination
        } finally { temporary.delete() }
    }
}
