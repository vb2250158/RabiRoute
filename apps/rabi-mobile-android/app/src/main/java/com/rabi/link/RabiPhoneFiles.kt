package com.rabi.link

import android.content.Context
import android.os.Environment
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption.NOFOLLOW_LINKS
import java.nio.file.StandardCopyOption.ATOMIC_MOVE
import java.nio.file.StandardCopyOption.REPLACE_EXISTING
import java.nio.file.attribute.BasicFileAttributes
import java.security.MessageDigest
import java.util.UUID

/** Device file operations use Android's primary shared storage and its platform permissions. */
class RabiPhoneFiles private constructor(private val root: File, private val staging: File) {
    private data class Upload(
        val id: String, val path: String, val size: Long, val hash: String, val version: String?,
        val temp: File, var offset: Long = 0, var state: String = "receiving",
        var touched: Long = System.currentTimeMillis()
    ) {
        fun receipt() = JSONObject().put("uploadId", id).put("path", path).put("size", size)
            .put("offset", offset).put("state", state).put("sha256", hash)
    }

    class Failure(val status: Int, val code: String) : RuntimeException(code)
    private val uploads = mutableMapOf<String, Upload>()

    @Synchronized
    @Throws(Failure::class)
    fun execute(action: String, input: JSONObject, stillAllowed: Runnable): JSONObject {
        stillAllowed.run()
        return try {
            val now = System.currentTimeMillis()
            uploads.entries.removeAll { (_, upload) ->
                now - upload.touched > uploadRetentionMs && (!upload.temp.exists() || upload.temp.delete())
            }
            if (action.startsWith("upload.")) upload(action, input, stillAllowed)
            else file(action, input, stillAllowed)
        } catch (_: java.nio.file.NoSuchFileException) {
            throw Failure(404, "PHONE_FILE_NOT_FOUND")
        } catch (_: java.nio.file.FileAlreadyExistsException) {
            throw Failure(409, "PHONE_FILE_EXISTS")
        } catch (_: java.nio.file.DirectoryNotEmptyException) {
            throw Failure(409, "PHONE_FOLDER_NOT_EMPTY")
        } catch (_: java.nio.file.AccessDeniedException) {
            throw Failure(403, "PHONE_FILE_ACCESS_DENIED")
        } catch (_: IOException) {
            throw Failure(500, "PHONE_FILE_IO_FAILED")
        }
    }

    private fun file(action: String, input: JSONObject, stillAllowed: Runnable): JSONObject {
        val path = field(input, "path")
        val target = resolve(path, rootAllowed = action == "file.list")
        return when (action) {
            "file.list" -> list(target, input)
            "file.stat" -> describe(target)
            "file.read" -> read(target, input)
            "file.mkdir" -> {
                stillAllowed.run()
                Files.createDirectory(target.toPath())
                describe(target)
            }
            "file.rename" -> {
                protectAndroidFolder(target)
                checkVersion(target, field(input, "version"))
                val destination = resolve(field(input, "to"))
                ensureMissing(destination)
                stillAllowed.run()
                Files.move(target.toPath(), destination.toPath())
                describe(destination)
            }
            "file.delete" -> {
                protectAndroidFolder(target)
                checkVersion(target, field(input, "version"))
                stillAllowed.run()
                Files.delete(target.toPath())
                JSONObject().put("deleted", true)
            }
            else -> throw Failure(400, "PHONE_FILES_REQUEST_INVALID")
        }
    }

    private fun list(folder: File, input: JSONObject): JSONObject {
        val before = describe(folder)
        if (before.getString("kind") != "directory") throw Failure(400, "PHONE_FOLDER_REQUIRED")
        val cursor = input.optString("after")
        if (cursor.isNotEmpty() && input.optString("version") != before.getString("version")) {
            throw Failure(409, "PHONE_FILE_CHANGED")
        }
        val page = folder.listFiles()?.asSequence()
            ?.filter { it.name > cursor && !protectedPath(it.relativeTo(root).invariantSeparatorsPath) && !Files.isSymbolicLink(it.toPath()) }
            ?.sortedBy { it.name }?.take(101)?.toList() ?: throw Failure(500, "PHONE_FILE_IO_FAILED")
        val items = page.take(100).map(::describe)
        checkVersion(folder, before.getString("version"))
        return JSONObject().put("entries", JSONArray(items))
            .put("version", before.getString("version"))
            .put("next", if (page.size > 100) page[99].name else JSONObject.NULL)
    }

    private fun read(target: File, input: JSONObject): JSONObject {
        val version = field(input, "version")
        val offset = number(input, "offset")
        val attributes = checkVersion(target, version)
        if (!attributes.isRegularFile || offset > attributes.size()) throw Failure(400, "PHONE_FILES_REQUEST_INVALID")
        val data = ByteArray(minOf(chunkBytes.toLong(), attributes.size() - offset).toInt())
        RandomAccessFile(target, "r").use { file -> file.seek(offset); file.readFully(data) }
        checkVersion(target, version)
        return JSONObject().put("offset", offset).put("nextOffset", offset + data.size).put("version", version)
            .put("eof", offset + data.size == attributes.size()).put("sha256", digest(data))
            .put("data", Base64.encodeToString(data, Base64.NO_WRAP))
    }

    private fun upload(action: String, input: JSONObject, stillAllowed: Runnable): JSONObject {
        val id = field(input, "uploadId")
        if (runCatching { UUID.fromString(id).toString() }.getOrNull() != id) throw Failure(400, "PHONE_UPLOAD_ID_INVALID")
        if (action == "upload.begin") return begin(id, input, stillAllowed)
        val job = uploads[id] ?: throw Failure(404, "PHONE_UPLOAD_UNKNOWN")
        job.touched = System.currentTimeMillis()
        if (action == "upload.status") return job.receipt()
        if (job.state == "committed" && action == "upload.commit") return job.receipt()
        if (job.state == "aborted" && action == "upload.abort") return job.receipt()
        if (job.state != "receiving") throw Failure(409, "PHONE_UPLOAD_CLOSED")
        when (action) {
            "upload.write" -> writeChunk(job, input, stillAllowed)
            "upload.commit" -> commit(job, stillAllowed)
            "upload.abort" -> {
                stillAllowed.run()
                Files.deleteIfExists(job.temp.toPath())
                job.state = "aborted"
            }
            else -> throw Failure(400, "PHONE_FILES_REQUEST_INVALID")
        }
        return job.receipt()
    }

    private fun begin(id: String, input: JSONObject, stillAllowed: Runnable): JSONObject {
        val path = field(input, "path")
        val size = number(input, "size")
        val hash = field(input, "sha256")
        val version = if (input.has("version")) field(input, "version") else null
        if (size > maxFileBytes || !sha256Pattern.matches(hash)) throw Failure(400, "PHONE_UPLOAD_INVALID")
        uploads[id]?.let {
            if (it.path != path || it.size != size || it.hash != hash || it.version != version) {
                throw Failure(409, "PHONE_UPLOAD_CHANGED")
            }
            return it.receipt()
        }
        val destination = resolve(path)
        checkDestination(destination, version)
        if (uploads.size >= 64 || uploads.values.count { it.state == "receiving" } >= 4) {
            throw Failure(429, "PHONE_UPLOAD_BUSY")
        }
        if (size > staging.usableSpace) throw Failure(507, "PHONE_STORAGE_FULL")
        val job = Upload(id, path, size, hash, version, File(staging, id))
        stillAllowed.run()
        Files.createFile(job.temp.toPath())
        uploads[id] = job
        return job.receipt()
    }

    private fun writeChunk(job: Upload, input: JSONObject, stillAllowed: Runnable) {
        val offset = number(input, "offset")
        val encoded = field(input, "data")
        if (encoded.length > ((chunkBytes + 2) / 3) * 4) throw Failure(400, "PHONE_UPLOAD_CHUNK_INVALID")
        val data = try { Base64.decode(encoded, Base64.NO_WRAP) } catch (_: IllegalArgumentException) {
            throw Failure(400, "PHONE_UPLOAD_CHUNK_INVALID")
        }
        if (data.isEmpty() || data.size > chunkBytes || offset > job.size - data.size || digest(data) != field(input, "sha256")) {
            throw Failure(400, "PHONE_UPLOAD_CHUNK_INVALID")
        }
        RandomAccessFile(job.temp, "rw").use { file ->
            file.seek(offset)
            if (offset < job.offset && offset + data.size <= job.offset) {
                val previous = ByteArray(data.size)
                file.readFully(previous)
                if (!previous.contentEquals(data)) throw Failure(409, "PHONE_UPLOAD_CHANGED")
                return
            }
            if (offset != job.offset) throw Failure(409, "PHONE_UPLOAD_OFFSET_INVALID")
            stillAllowed.run()
            file.write(data)
            job.offset += data.size
        }
    }

    private fun commit(job: Upload, stillAllowed: Runnable) {
        if (job.offset != job.size || job.temp.length() != job.size) throw Failure(409, "PHONE_UPLOAD_INCOMPLETE")
        val destination = resolve(job.path)
        checkDestination(destination, job.version)
        val parent = destination.toPath().parent
        if (job.size > parent.toFile().usableSpace) throw Failure(507, "PHONE_STORAGE_FULL")
        stillAllowed.run()
        // Android's app-specific storage and the public destination can be separate rename domains.
        val pending = Files.createTempFile(parent, pendingPrefix, ".tmp")
        try {
            val hash = MessageDigest.getInstance("SHA-256")
            job.temp.inputStream().use { stream ->
                Files.newOutputStream(pending).use { output ->
                    val buffer = ByteArray(chunkBytes)
                    while (true) {
                        val count = stream.read(buffer)
                        if (count < 0) break
                        stillAllowed.run()
                        hash.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            if (hex(hash.digest()) != job.hash) throw Failure(409, "PHONE_UPLOAD_HASH_MISMATCH")
            checkDestination(destination, job.version)
            stillAllowed.run()
            Files.move(pending, destination.toPath(), ATOMIC_MOVE, REPLACE_EXISTING)
            job.state = "committed"
            job.temp.delete()
        } finally {
            Files.deleteIfExists(pending)
        }
    }

    private fun resolve(path: String, rootAllowed: Boolean = false): File {
        val relative = when {
            path == root.path -> ""
            path.startsWith(root.path + "/") -> path.removePrefix(root.path + "/")
            else -> path
        }
        if (rootAllowed && relative.isEmpty()) return root
        if (protectedPath(relative)) throw Failure(403, "PHONE_FILE_ACCESS_DENIED")
        val parts = relative.split('/')
        if (path.length > 2048 || parts.size > 32 || parts.any {
                it.isEmpty() || it == "." || it == ".." || it.toByteArray().size > 255
                    || it.any { char -> char == '\\' || char == ':' || char.isISOControl() }
            }) throw Failure(400, "PHONE_FILE_PATH_INVALID")
        var file = root
        for (part in parts) {
            file = File(file, part)
            if (Files.isSymbolicLink(file.toPath())) throw Failure(403, "PHONE_FILE_PATH_INVALID")
        }
        return file
    }

    private fun protectedPath(path: String): Boolean {
        if (path.split('/').any { it.startsWith(pendingPrefix) }) return true
        val parts = path.split('/', limit = 3)
        return parts.size > 1 && parts[0].equals("Android", ignoreCase = true) &&
            (parts[1].equals("data", ignoreCase = true) || parts[1].equals("obb", ignoreCase = true))
    }

    private fun protectAndroidFolder(file: File) {
        if (file.parentFile == root && file.name.equals("Android", ignoreCase = true)) {
            throw Failure(403, "PHONE_FILE_ACCESS_DENIED")
        }
    }

    private fun checkDestination(file: File, version: String?) {
        if (version == null) ensureMissing(file)
        else if (!checkVersion(file, version).isRegularFile) throw Failure(400, "PHONE_FILE_REQUIRED")
    }

    private fun ensureMissing(file: File) {
        if (Files.exists(file.toPath(), NOFOLLOW_LINKS)) throw Failure(409, "PHONE_FILE_EXISTS")
    }

    private fun checkVersion(file: File, expected: String): BasicFileAttributes {
        val attributes = attributes(file)
        if (version(attributes) != expected) throw Failure(409, "PHONE_FILE_CHANGED")
        return attributes
    }

    private fun attributes(file: File): BasicFileAttributes =
        Files.readAttributes(file.toPath(), BasicFileAttributes::class.java, NOFOLLOW_LINKS).also {
            if (!it.isDirectory && !it.isRegularFile) throw Failure(403, "PHONE_FILE_PATH_INVALID")
        }

    private fun describe(file: File): JSONObject {
        val attributes = attributes(file)
        return JSONObject().put("name", file.name).put("kind", if (attributes.isDirectory) "directory" else "file")
            .put("size", if (attributes.isDirectory) 0 else attributes.size())
            .put("modifiedAt", attributes.lastModifiedTime().toMillis()).put("version", version(attributes))
    }

    private fun version(a: BasicFileAttributes) =
        digest("${a.fileKey()}/${a.size()}/${a.lastModifiedTime()}/${a.creationTime()}".toByteArray())

    companion object {
        const val chunkBytes = 64 * 1024
        const val maxFileBytes = 512L * 1024 * 1024
        private const val uploadRetentionMs = 60 * 60 * 1000L
        private const val pendingPrefix = ".rabilink-transfer-"
        private val sha256Pattern = Regex("[a-f0-9]{64}")
        private val stores = mutableMapOf<String, RabiPhoneFiles>()
        private val processStaging = UUID.randomUUID().toString()

        private fun scope(url: String, token: String) = digest((url.trimEnd('/') + "\u0000" + token).toByteArray())

        @JvmStatic
        fun enabled(context: Context, url: String, token: String): Boolean = token.isNotBlank() &&
            context.getSharedPreferences("rabi_phone_files", Context.MODE_PRIVATE).getBoolean(scope(url, token), true)

        @JvmStatic
        fun status(context: Context, url: String, token: String): JSONObject = JSONObject()
            .put("enabled", enabled(context, url, token))
            .put("permissionGranted", Environment.isExternalStorageManager())

        @JvmStatic
        @Throws(Failure::class)
        fun requireAccess(context: Context, url: String, token: String) {
            if (!enabled(context, url, token)) throw Failure(403, "PHONE_FILES_DISABLED")
            if (!Environment.isExternalStorageManager()) throw Failure(403, "PHONE_FILES_PERMISSION_REQUIRED")
        }

        @JvmStatic
        fun setEnabled(context: Context, relay: RabiLinkRelayConfig, enabled: Boolean) {
            check(relay.configured)
            check(context.getSharedPreferences("rabi_phone_files", Context.MODE_PRIVATE).edit()
                .putBoolean(scope(relay.baseUrl, relay.token), enabled).commit())
        }

        @JvmStatic
        @Synchronized
        fun open(context: Context, url: String, token: String): RabiPhoneFiles {
            val key = scope(url, token)
            return stores.getOrPut(key) {
                val root = Environment.getExternalStorageDirectory().canonicalFile
                val external = context.getExternalFilesDir(null) ?: throw IOException("Primary storage unavailable")
                val staging = File(external, "rabilink-file-staging/$key/$processStaging")
                Files.createDirectories(staging.toPath())
                staging.parentFile?.listFiles()?.filter { it != staging }?.forEach { directory ->
                    directory.listFiles()?.forEach { it.delete() }
                    directory.delete()
                }
                RabiPhoneFiles(root, staging)
            }
        }

        private fun field(input: JSONObject, key: String): String =
            input.opt(key) as? String ?: throw Failure(400, "PHONE_FILES_REQUEST_INVALID")

        private fun number(input: JSONObject, key: String): Long {
            val value = input.opt(key)
            if (value !is Int && value !is Long) throw Failure(400, "PHONE_FILES_REQUEST_INVALID")
            return (value as Number).toLong().also { if (it < 0) throw Failure(400, "PHONE_FILES_REQUEST_INVALID") }
        }

        private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
    }
}
