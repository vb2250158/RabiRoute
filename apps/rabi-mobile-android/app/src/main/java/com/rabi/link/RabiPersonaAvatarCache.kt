package com.rabi.link

import android.content.Context
import android.graphics.BitmapFactory
import android.widget.ImageView
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Private on-device avatar cache. URLs are Relay paths; role folders never reach Android. */
object RabiPersonaAvatarCache {
    fun load(
        context: Context,
        image: ImageView,
        url: String,
        token: String,
        roleId: String,
        avatarVersion: String,
        onState: (RabiAvatarLoadRules.State) -> Unit = {}
    ) {
        val normalizedRole = roleId.trim()
        val normalizedVersion = avatarVersion.trim()
        val requestTag = "$normalizedRole\u0000$normalizedVersion"
        image.tag = requestTag
        fun postIfCurrent(action: () -> Unit) {
            image.post {
                if (image.tag == requestTag) action()
            }
        }
        if (url.isBlank() || normalizedRole.isBlank() || normalizedVersion.isBlank()) {
            postIfCurrent { onState(RabiAvatarLoadRules.State.UNAVAILABLE) }
            return
        }
        postIfCurrent { onState(RabiAvatarLoadRules.State.LOADING) }
        Thread {
            val roleDirectory = File(File(context.filesDir, "rabi-persona-avatars"), digest(normalizedRole)).apply { mkdirs() }
            val exactFile = File(roleDirectory, "${digest(normalizedVersion)}.img")
            val latestFile = File(roleDirectory, "latest.img")
            var cachedAvatarDisplayed = false
            fun showCached(file: File, state: RabiAvatarLoadRules.State): Boolean {
                val bitmap = BitmapFactory.decodeFile(file.absolutePath) ?: return false
                cachedAvatarDisplayed = true
                postIfCurrent {
                    image.setImageBitmap(bitmap)
                    onState(state)
                }
                return true
            }
            val exactAvailable = exactFile.isFile && showCached(
                exactFile,
                RabiAvatarLoadRules.cachedState(exactVersionAvailable = true, olderVersionAvailable = latestFile.isFile)
            )
            if (!exactAvailable && latestFile.isFile) {
                showCached(
                    latestFile,
                    RabiAvatarLoadRules.cachedState(exactVersionAvailable = false, olderVersionAvailable = true)
                )
            }
            var connection: HttpURLConnection? = null
            var temporary: File? = null
            try {
                val currentConnection = URL(url).openConnection() as HttpURLConnection
                connection = currentConnection
                currentConnection.connectTimeout = 10_000; currentConnection.readTimeout = 20_000
                currentConnection.useCaches = false
                currentConnection.setRequestProperty("Cache-Control", "no-cache")
                currentConnection.setRequestProperty("X-RabiLink-Token", token)
                if (currentConnection.responseCode !in 200..299) {
                    postIfCurrent { onState(RabiAvatarLoadRules.failureState(cachedAvatarDisplayed)) }
                    return@Thread
                }
                val downloadFile = File(roleDirectory, "${exactFile.name}.${Thread.currentThread().id}.download")
                temporary = downloadFile
                currentConnection.inputStream.use { input -> downloadFile.outputStream().use { input.copyTo(it) } }
                if (downloadFile.length() == 0L) throw IllegalStateException("Empty persona avatar response")
                val bitmap = BitmapFactory.decodeFile(downloadFile.absolutePath)
                    ?: throw IllegalStateException("Invalid persona avatar image")
                if (!downloadFile.renameTo(exactFile)) {
                    downloadFile.copyTo(exactFile, overwrite = true)
                }
                exactFile.copyTo(latestFile, overwrite = true)
                postIfCurrent {
                    image.setImageBitmap(bitmap)
                    onState(RabiAvatarLoadRules.State.READY)
                }
            } catch (_: Throwable) {
                postIfCurrent { onState(RabiAvatarLoadRules.failureState(cachedAvatarDisplayed)) }
            } finally {
                runCatching { temporary?.delete() }
                connection?.disconnect()
            }
        }.apply { name = "rabi-avatar"; start() }
    }

    fun invalidate(context: Context, roleId: String) {
        if (roleId.isBlank()) return
        val directory = File(File(context.filesDir, "rabi-persona-avatars"), digest(roleId.trim()))
        directory.listFiles()?.filter { it.name != "latest.img" }?.forEach { runCatching { it.delete() } }
    }

    private fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
}
