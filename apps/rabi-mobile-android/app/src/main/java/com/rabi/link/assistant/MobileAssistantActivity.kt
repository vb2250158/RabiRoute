package com.rabi.link.assistant

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.recording.AllDayRecordingSettings
import com.rabi.link.transport.RabiManagerHttpTransport
import com.rabiroute.sdk.RabiRouteSdk
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.Executors

/** Foreground-only mobile input and output. The selected PC remains the model and conversation owner. */
class MobileAssistantActivity : Activity() {
    private lateinit var browser: WebView
    private val executor = Executors.newFixedThreadPool(3)
    private val account by lazy { RabiLinkRelaySettings.load(this) }
    private val computerId by lazy {
        RabiLinkRelaySettings.computers(this).singleOrNull { RabiLinkRelaySettings.isActive(this, it) }?.workerId
    }
    private val transports by lazy { List(3) { RabiManagerHttpTransport(this) } }
    private var permission: PermissionRequest? = null
    private var inForeground = false
    @Volatile private var closed = false
    private val localSwitch by lazy { getSharedPreferences("mobile_assistant", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Freeze the selected computer for the life of this screen.
        account
        computerId
        browser = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.setSupportMultipleWindows(false)
            settings.mediaPlaybackRequiresUserGesture = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val path = request.url.path.orEmpty()
                    val asset = path.removePrefix("/assistant/")
                    if (request.method != "GET" || !trustedOrigin(request.url) || !path.startsWith("/assistant/") ||
                        request.url.query != null || !asset.matches(Regex("(?:sdk/)?[a-z0-9-]+\\.(?:html|css|js)"))) {
                        return missing()
                    }
                    val mime = when {
                        asset.endsWith(".css") -> "text/css"
                        asset.endsWith(".js") -> "text/javascript"
                        else -> "text/html"
                    }
                    return runCatching {
                        WebResourceResponse(mime, "UTF-8", assets.open("mobile-assistant/" + asset))
                    }.getOrElse { missing() }
                }
            }
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    if (!inForeground || !trustedOrigin(request.origin) ||
                        !request.resources.contentEquals(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))) {
                        request.deny()
                        return
                    }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.resources)
                    } else if (permission == null) {
                        permission = request
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_PERMISSION)
                    } else request.deny()
                }

                override fun onPermissionRequestCanceled(request: PermissionRequest) {
                    if (permission === request) permission = null
                }
            }
            addJavascriptInterface(Backend(), "RabiMobile")
        }
        setContentView(browser)
        browser.loadUrl("https://" + ASSET_HOST + "/assistant/index.html")
    }

    override fun onResume() {
        super.onResume()
        inForeground = true
        browser.evaluateJavascript("window.mobileVisible?.()", null)
    }

    override fun onStop() {
        inForeground = false
        permission?.deny()
        permission = null
        browser.evaluateJavascript("window.mobileHidden?.()", null)
        super.onStop()
    }

    override fun onDestroy() {
        closed = true
        permission?.deny()
        permission = null
        transports.forEach { it.close() }
        executor.shutdownNow()
        browser.removeJavascriptInterface("RabiMobile")
        browser.destroy()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, results: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, results)
        if (requestCode != MIC_PERMISSION) return
        val request = permission ?: return
        permission = null
        if (inForeground && results.singleOrNull() == PackageManager.PERMISSION_GRANTED) request.grant(request.resources)
        else request.deny()
    }

    private fun trustedOrigin(uri: Uri): Boolean =
        uri.scheme == "https" && uri.encodedAuthority == ASSET_HOST

    private fun missing() = WebResourceResponse(
        "text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0))
    )

    private fun request(id: String, operation: String, body: JSONObject) {
        val computer = computerId
        check(account.configured && !computer.isNullOrBlank()) { "MOBILE_COMPUTER_REQUIRED" }
        val current = RabiLinkRelaySettings.load(this)
        check(current == account && RabiLinkRelaySettings.computers(this)
            .any { it.workerId == computer && RabiLinkRelaySettings.isActive(this, it) }) { "MOBILE_COMPUTER_CHANGED" }
        val target = RabiRouteSdk().getMobileState(account.baseUrl, account.token).workers
            .singleOrNull { it.id == computer } ?: error("MOBILE_COMPUTER_UNAVAILABLE")
        val (path, bytes, contentType, lane) = when (operation) {
            "state" -> Request("/api/voice-assistant/state")
            "messages" -> Request("/api/voice-assistant/messages?view=mobile")
            "submit" -> {
                check(body.optString("action") == "mobile-voice-submit" && body.optString("requestId").isNotBlank())
                Request("/api/voice-assistant/command", body.toString().toByteArray(Charsets.UTF_8), "application/json")
            }
            "asr" -> {
                val model = body.getString("model")
                require(model.length in 1..200 && model.none { it.isISOControl() })
                val pcm = Base64.decode(body.getString("audio"), Base64.NO_WRAP)
                require(pcm.size in 44..2_100_000)
                val boundary = "rabi-mobile-" + UUID.randomUUID().toString()
                val modelPart = "--$boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n$model\r\n"
                val audioPart = "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"mobile.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
                val end = "\r\n--$boundary--\r\n"
                Request("/api/speech/asr", (modelPart + audioPart).toByteArray(Charsets.UTF_8) + pcm + end.toByteArray(Charsets.UTF_8),
                    "multipart/form-data; boundary=$boundary", lane = 1)
            }
            "tts" -> {
                body.put("play", false).put("responseFormat", "wav")
                Request("/api/speech/tts", body.toString().toByteArray(Charsets.UTF_8), "application/json", lane = 2)
            }
            else -> error("MOBILE_REQUEST_INVALID")
        }
        val method = if (bytes.isEmpty()) "GET" else "POST"
        val headers = if (contentType.isEmpty()) emptyMap() else mapOf("content-type" to contentType)
        val response = transports[lane].request(account.baseUrl, account.token, target, method, path, headers, bytes)
        if (operation == "tts" && response.statusCode in 200..299) {
            val responseType = response.headers.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value.orEmpty()
            check(responseType.startsWith("audio/") || responseType.startsWith("application/octet-stream")) { "MOBILE_AUDIO_RESPONSE_INVALID" }
            resolve(id, true, Base64.encodeToString(response.body, Base64.NO_WRAP))
            return
        }
        val text = String(response.body, Charsets.UTF_8)
        val document = runCatching { JSONObject(text) }.getOrNull()
        if (response.statusCode !in 200..299 || operation != "asr" && document?.optInt("code", -1) != 0) {
            val code = document?.optString("message").orEmpty()
            error(code.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) } ?: "MOBILE_ASSISTANT_HTTP_" + response.statusCode)
        }
        resolve(id, true, if (operation == "asr") text else document!!.get("data").toString())
    }

    private data class Request(val path: String, val body: ByteArray = ByteArray(0), val contentType: String = "", val lane: Int = 0)

    private fun resolve(id: String, success: Boolean, payload: String) {
        runOnUiThread {
            if (!closed) browser.evaluateJavascript(
                "window.mobileReply?.(" + JSONObject.quote(id) + "," + success + "," + JSONObject.quote(payload) + ")", null
            )
        }
    }

    private inner class Backend {
        @JavascriptInterface fun send(id: String, operation: String, payload: String) {
            if (closed || !id.matches(Regex("[a-zA-Z0-9-]{1,80}"))) return
            val limit = if (operation == "asr") 2_850_000 else 30_000
            if (payload.length > limit) {
                resolve(id, false, "MOBILE_REQUEST_TOO_LARGE")
                return
            }
            executor.execute {
                try {
                    request(id, operation, JSONObject(payload))
                } catch (error: Exception) {
                    val code = error.message.orEmpty().takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) }
                    resolve(id, false, code ?: "MOBILE_COMPUTER_REQUEST_FAILED")
                }
            }
        }

        @JavascriptInterface fun microphoneAvailable(): Boolean {
            val recording = AllDayRecordingSettings.load(this@MobileAssistantActivity)
            val callActive = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).getBoolean("callActive", false)
            return !(recording.running && recording.mode == "audio") && !callActive
        }

        @JavascriptInterface fun voiceEnabled(): Boolean = localSwitch.getBoolean("enabled", true)

        @JavascriptInterface fun setVoiceEnabled(enabled: Boolean) {
            localSwitch.edit().putBoolean("enabled", enabled).apply()
        }

        @JavascriptInterface fun close() = runOnUiThread { finish() }
    }

    private companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val MIC_PERMISSION = 401
    }
}
