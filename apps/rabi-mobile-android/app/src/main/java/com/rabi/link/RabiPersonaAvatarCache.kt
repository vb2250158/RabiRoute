package com.rabi.link

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AtomicFile
import android.util.LruCache
import android.widget.ImageView
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Displays a cached frame immediately and updates it when the owning PC publishes a new version. */
internal object RabiPersonaAvatarCache {
    private data class Frame(val version: String, val bitmap: Bitmap)
    private data class Request(val roleKey: String, val version: String)
    private class Binding(val roleKey: String)
    private fun interface Listener {
        operator fun invoke(frame: Frame?, state: RabiAvatarLoadRules.State)
    }

    private const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
    private const val RETRY_DELAY_MS = 30_000L
    private val main = Handler(Looper.getMainLooper())
    private val workers = Executors.newFixedThreadPool(3)
    private val frames = object : LruCache<String, Frame>(8 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Frame) = value.bitmap.byteCount
    }
    private val failures = LruCache<Request, Long>(128)
    private val pending = mutableMapOf<Request, MutableList<Listener>>()
    private val wanted = LruCache<String, String>(256)

    /** Called on the UI thread. Fetch reads the version from this role's authenticated PC. */
    fun load(
        context: Context,
        image: ImageView,
        source: String,
        roleId: String,
        version: String,
        fetch: () -> ByteArray,
        onState: (RabiAvatarLoadRules.State) -> Unit = {},
    ) {
        val roleKey = digest("$source\u0000$roleId")
        val request = Request(roleKey, version)
        val cached = frames.get(roleKey)
        val previous = image.tag as? Binding
        if (previous != null && previous.roleKey != roleKey && cached == null) {
            image.setImageResource(R.drawable.ic_persona_avatar_placeholder)
        }
        val binding = Binding(roleKey)
        image.tag = binding
        wanted.put(roleKey, version)
        val receive = Listener { frame, state ->
            if (image.tag === binding) {
                if (frame != null) image.setImageBitmap(frame.bitmap)
                onState(state)
            }
        }
        if (cached?.version == version) {
            receive(cached, RabiAvatarLoadRules.State.READY)
            return
        }
        cached?.let { receive(it, RabiAvatarLoadRules.State.STALE) }
        if (SystemClock.elapsedRealtime() < (failures.get(request) ?: 0L)) {
            receive(null, RabiAvatarLoadRules.failureState(cached != null))
            return
        }
        pending[request]?.let { it.add(receive); return }
        pending[request] = mutableListOf(receive)
        val directory = File(context.applicationContext.filesDir, "rabi-persona-avatar-cache")
        workers.execute {
            val file = AtomicFile(File(directory, "$roleKey.img"))
            val disk = synchronized(fileWriteLock) { read(file) }
            if (disk?.version == version) {
                main.post { complete(request, disk) }
                return@execute
            }
            if (cached == null && disk != null) main.post {
                if (wanted.get(roleKey) == version) {
                    frames.put(roleKey, disk)
                    pending[request]?.forEach { it(disk, RabiAvatarLoadRules.State.STALE) }
                }
            }
            val fetched = runCatching {
                val bytes = fetch()
                val frame = Frame(version, decode(bytes))
                synchronized(fileWriteLock) {
                    if (wanted.get(roleKey) == version && directory.isDirectoryOrCreated()) {
                        runCatching { write(file, version, bytes) }
                    }
                }
                frame
            }.getOrNull()
            main.post { complete(request, fetched) }
        }
    }

    private val fileWriteLock = Any()

    private fun complete(request: Request, frame: Frame?) {
        val listeners = pending.remove(request) ?: return
        if (wanted.get(request.roleKey) != request.version) return
        if (frame != null) {
            frames.put(request.roleKey, frame)
            listeners.forEach { it(frame, RabiAvatarLoadRules.State.READY) }
        } else {
            failures.put(request, SystemClock.elapsedRealtime() + RETRY_DELAY_MS)
            val state = RabiAvatarLoadRules.failureState(frames.get(request.roleKey) != null)
            listeners.forEach { it(null, state) }
        }
    }

    private fun read(file: AtomicFile): Frame? = runCatching {
        DataInputStream(file.openRead()).use { stream ->
            val version = stream.readUTF()
            val length = stream.readInt()
            require(length in 1..MAX_IMAGE_BYTES)
            Frame(version, decode(ByteArray(length).also { stream.readFully(it) }))
        }
    }.getOrNull()

    private fun write(file: AtomicFile, version: String, bytes: ByteArray) {
        val stream = file.startWrite()
        try {
            val data = DataOutputStream(stream)
            data.writeUTF(version)
            data.writeInt(bytes.size)
            data.write(bytes)
            data.flush()
            file.finishWrite(stream)
        } catch (error: Exception) {
            file.failWrite(stream)
            throw error
        }
    }

    private fun File.isDirectoryOrCreated() = isDirectory || mkdirs()

    private fun decode(bytes: ByteArray): Bitmap {
        require(bytes.size in 1..MAX_IMAGE_BYTES)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val longestSide = maxOf(bounds.outWidth, bounds.outHeight)
        require(longestSide > 0)
        val options = BitmapFactory.Options().apply {
            inSampleSize = 1
            while (longestSide / inSampleSize > 384) inSampleSize *= 2
        }
        return requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
}
