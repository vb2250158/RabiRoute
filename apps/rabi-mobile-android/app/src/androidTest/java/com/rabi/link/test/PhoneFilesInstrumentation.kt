package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.os.Environment
import android.os.SystemClock
import android.util.Base64
import com.rabi.link.RabiLinkRelayConfig
import com.rabi.link.RabiMobileDeviceIdentity
import com.rabi.link.RabiPhoneFiles
import com.rabi.link.modules.rokid.RabiGlassPcBackend
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.io.File
import java.net.URL
import java.security.MessageDigest
import java.util.UUID

/** Uses the installed Android SSE worker and the isolated Relay's HTTP entry. */
class PhoneFilesInstrumentation : Instrumentation() {
    private lateinit var arguments: Bundle

    override fun onCreate(arguments: Bundle) {
        super.onCreate(arguments)
        this.arguments = arguments
        start()
    }

    override fun onStart() {
        val result = Bundle()
        try {
            check(targetContext.packageName.endsWith(".assistantacceptance"))
            exercise()
            result.putString("stream", "Phone file settings and Android permission checks passed.")
            finish(Activity.RESULT_OK, result)
        } catch (error: Throwable) {
            result.putString("stack", error.stackTraceToString())
            finish(Activity.RESULT_CANCELED, result)
        }
    }

    private fun exercise() {
        val base = checkNotNull(arguments.getString("server"))
        val token = checkNotNull(arguments.getString("token"))
        val relay = RabiLinkRelayConfig(base, token, true)
        val id = RabiMobileDeviceIdentity.load(targetContext)
        val filesRoute = "/api/rabilink/mobile/files"
        val backend = RabiGlassPcBackend(targetContext, object : RabiGlassPcBackend.Listener {
            override fun onStatus(status: String) {}
            override fun onTranscript(text: String, routeProfileId: String) {}
            override fun onDeliveryState(clientMessageId: String, routeProfileId: String, state: String, failure: String) {}
            override fun onPersonaAvatarChanged(roleId: String, avatarVersion: String, avatarUrl: String) {}
            override fun onError(message: String) {}
            override fun onReply(messageId: String, routeProfileId: String, text: String, pcm: ByteArray, attachments: JSONArray) =
                RabiGlassPcBackend.ReplyDeliveryResult(false, false, false, "phone", "")
        })

        fun call(action: String, vararg fields: Pair<String, Any>, expect: Int = 200): JSONObject {
            val body = JSONObject().put("action", action).put("targetId", id).put("targetGuid", "")
            fields.forEach { (key, value) -> body.put(key, value) }
            val (status, response) = request(base, token, filesRoute, body)
            check(status == expect) { "$action expected $expect, received $status and ${response.optString("errorCode")}" }
            return if (status == 200) response.getJSONObject("data") else response
        }

        fun upload(path: String, bytes: ByteArray, version: String? = null) {
            val uploadId = UUID.randomUUID().toString()
            val fields = mutableListOf("uploadId" to uploadId, "path" to path, "size" to bytes.size, "sha256" to hash(bytes))
            if (version != null) fields.add("version" to version)
            call("upload.begin", *fields.toTypedArray())
            var offset = 0
            while (offset < bytes.size) {
                val count = minOf(RabiPhoneFiles.chunkBytes, bytes.size - offset)
                val chunk = bytes.copyOfRange(offset, offset + count)
                val requestFields = arrayOf("uploadId" to uploadId, "offset" to offset,
                    "data" to Base64.encodeToString(chunk, Base64.NO_WRAP), "sha256" to hash(chunk))
                check(call("upload.write", *requestFields).getInt("offset") == offset + count)
                check(call("upload.write", *requestFields).getInt("offset") == offset + count)
                offset += count
            }
            check(call("upload.status", "uploadId" to uploadId).getInt("offset") == bytes.size)
            check(call("upload.commit", "uploadId" to uploadId).getString("state") == "committed")
        }

        val folder = "Download/acceptance-" + UUID.randomUUID()
        val original = "$folder/手机文件.txt"
        val renamed = "$folder/重命名.txt"
        try {
            backend.configure(base, token, id)
            backend.start()
            awaitCapability(base, token, id, true)
            val settings = call("file.settings.read")
            check(settings.getBoolean("enabled"))
            val permitted = arguments.getString("permission") != "denied"
            check(settings.getBoolean("permissionGranted") == permitted)
            if (!permitted) {
                check(call("file.list", "path" to "", expect = 403).getString("errorCode") == "PHONE_FILES_PERMISSION_REQUIRED")
                return
            }
            call("file.mkdir", "path" to folder)
            val local = File(Environment.getExternalStorageDirectory(), "$folder/local.txt")
            local.writeText("already on the phone")
            val listed = call("file.list", "path" to folder).getJSONArray("entries")
            check(listed.length() == 1 && listed.getJSONObject(0).getString("name") == "local.txt")
            val localVersion = call("file.stat", "path" to local.absolutePath).getString("version")
            call("file.delete", "path" to local.absolutePath, "version" to localVersion)
            call("file.list", "path" to "../", expect = 400)
            call("file.list", "path" to "Android/data", expect = 403)

            val bytes = ByteArray(RabiPhoneFiles.chunkBytes + 29) { (it % 233).toByte() }
            upload(original, bytes)
            val old = call("file.stat", "path" to original).getString("version")
            var offset = 0
            while (offset < bytes.size) {
                val chunk = call("file.read", "path" to original, "version" to old, "offset" to offset)
                val next = chunk.getInt("nextOffset")
                val data = Base64.decode(chunk.getString("data"), Base64.NO_WRAP)
                check(data.contentEquals(bytes.copyOfRange(offset, next)) && hash(data) == chunk.getString("sha256"))
                offset = next
            }
            upload(original, "updated".toByteArray(), old)
            call("file.delete", "path" to original, "version" to old, expect = 409)
            val version = call("file.stat", "path" to original).getString("version")
            val moved = call("file.rename", "path" to original, "version" to version, "to" to renamed)
            call("file.stat", "path" to original, expect = 404)
            call("file.delete", "path" to renamed, "version" to moved.getString("version"))
            val empty = call("file.stat", "path" to folder)
            call("file.delete", "path" to folder, "version" to empty.getString("version"))

            check(!call("file.settings.update", "enabled" to false).getBoolean("enabled"))
            check(call("file.list", "path" to "", expect = 403).getString("errorCode") == "PHONE_FILES_DISABLED")
            check(call("file.settings.update", "enabled" to true).getBoolean("enabled"))
            call("file.list", "path" to "Download")
        } finally {
            RabiPhoneFiles.setEnabled(targetContext, relay, false)
            backend.stop()
        }
    }

    private fun awaitCapability(base: String, token: String, id: String, enabled: Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 15_000
        do {
            val peers = request(base, token, "/api/rabilink/peers?includePortable=phone").second.getJSONArray("peers")
            for (index in 0 until peers.length()) {
                val peer = peers.getJSONObject(index)
                if (peer.getString("id") != id || !peer.getBoolean("online")) continue
                val capabilities = peer.getJSONArray("capabilities")
                val shares = (0 until capabilities.length()).any { capabilities.getString(it) == "phone-files-v1" }
                if (shares == enabled) return
            }
            SystemClock.sleep(100)
        } while (SystemClock.elapsedRealtime() < deadline)
        error("Phone capability did not reach enabled=$enabled")
    }

    private fun request(base: String, token: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject> {
        val connection = URL(base + path).openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 5_000
            connection.readTimeout = 35_000
            connection.setRequestProperty("x-rabilink-token", token)
            if (body != null) {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("content-type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val status = connection.responseCode
            val input = if (status < 400) connection.inputStream else connection.errorStream
            return status to input.bufferedReader().use { JSONObject(it.readText()) }
        } finally {
            connection.disconnect()
        }
    }

    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 255) }
}
