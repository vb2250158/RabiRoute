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
import com.rabi.link.RabiComputerDirectoryCache
import com.rabi.link.recording.AllDayRecordingSettings
import com.rabi.link.transport.RabiManagerHttpTransport
import com.rabi.link.transport.RabiSpeechTunnel
import com.rabiroute.sdk.RabiRouteSdk
import com.rabiroute.sdk.RabiHttpException
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
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
    private val recognitionExecutor = Executors.newSingleThreadExecutor()
    private val recognitionLock = Any()
    @Volatile private var recognition: MobileRecognitionStream? = null
    @Volatile private var localWake: MobileWakeSession? = null
    private var permission: PermissionRequest? = null
    @Volatile private var inForeground = false
    @Volatile private var closed = false
    private val localSwitch by lazy { getSharedPreferences("mobile_assistant", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (RabiLinkRelaySettings.requireSignIn(this)) return
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
        if (!::browser.isInitialized || RabiLinkRelaySettings.requireSignIn(this)) return
        inForeground = true
        browser.evaluateJavascript("window.mobileVisible?.()", null)
    }

    override fun onStop() {
        inForeground = false
        stopLocalWake()
        stopRecognition()
        permission?.deny()
        permission = null
        if (::browser.isInitialized) browser.evaluateJavascript("window.mobileHidden?.()", null)
        super.onStop()
    }

    override fun onDestroy() {
        closed = true
        permission?.deny()
        permission = null
        transports.forEach { it.close() }
        stopLocalWake()
        stopRecognition()
        recognitionExecutor.shutdownNow()
        executor.shutdownNow()
        if (::browser.isInitialized) {
            browser.removeJavascriptInterface("RabiMobile")
            browser.destroy()
        }
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

    private fun currentComputer() = account == RabiLinkRelaySettings.load(this) &&
        RabiLinkRelaySettings.computers(this)
            .any { it.workerId == computerId && RabiLinkRelaySettings.isActive(this, it) }

    private fun targetComputer(): com.rabiroute.sdk.RabiLinkPc {
        check(account.configured && !computerId.isNullOrBlank()) { "MOBILE_COMPUTER_REQUIRED" }
        check(currentComputer()) { "MOBILE_COMPUTER_CHANGED" }
        return RabiRouteSdk().getMobileState(account.baseUrl, account.token).workers
            .singleOrNull { it.id == computerId } ?: error("MOBILE_COMPUTER_UNAVAILABLE")
    }

    private fun stopRecognition(id: String? = null) {
        synchronized(recognitionLock) {
            val active = recognition ?: return
            if (id != null && active.id != id) return
            recognition = null
            active.close()
        }
    }

    private fun startRecognition(id: String, sessionId: String): Boolean {
        if (!inForeground || closed || !id.matches(Regex("[a-zA-Z0-9-]{1,80}")) ||
            !sessionId.matches(Regex("[a-zA-Z0-9._:-]{1,128}"))) return false
        synchronized(recognitionLock) {
            if (recognition != null || localWake != null) return false
            val activate = MobileRecognitionStream(id) { value -> recognitionEvent(id, value) }
            recognition = activate
            recognitionExecutor.execute {
                try {
                    if (recognition !== activate) return@execute
                    val endpoint = RabiSpeechTunnel(applicationContext, account, targetComputer(), "manager")
                    activate.run(endpoint, "/api/voice-assistant/mobile-asr?sessionId=" + Uri.encode(sessionId)) {
                        !closed && inForeground && recognition === activate && currentComputer()
                    }
                } catch (error: Exception) {
                    val code = error.message.orEmpty().takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) }
                    recognitionEvent(id, JSONObject().put("type", "error").put("code", code ?: "MOBILE_STREAM_FAILED"))
                } finally {
                    stopRecognition(id)
                }
            }
        }
        return true
    }

    private fun recognitionEvent(id: String, payload: JSONObject) {
        runOnUiThread {
            if (!closed && inForeground) browser.evaluateJavascript("window.mobileRecognitionEvent?.(" +
                JSONObject.quote(id) + "," + JSONObject.quote(payload.toString()) + ")", null)
        }
    }

    private fun startLocalWake(id: String, model: String, hash: String, keywords: String, count: Int): Boolean {
        if (!inForeground || closed || !id.matches(Regex("[a-zA-Z0-9-]{1,80}")) ||
            !MobileWakeSession.supports(model, hash) || !MobileWakeSession.validKeywords(keywords, count)) return false
        synchronized(recognitionLock) {
            if (recognition != null || localWake != null) return false
            val activation = MobileWakeSession(id, applicationContext, keywords, count) { payload ->
                runOnUiThread {
                    if (!closed && inForeground && localWake?.id == id) browser.evaluateJavascript("window.mobileWakeEvent?.(" +
                        JSONObject.quote(id) + "," + JSONObject.quote(payload.toString()) + ")", null)
                }
            }
            localWake = activation
            recognitionExecutor.execute(activation::run)
        }
        return true
    }

    private fun stopLocalWake(id: String? = null) {
        synchronized(recognitionLock) {
            val active = localWake ?: return
            if (id != null && active.id != id) return
            localWake = null
            active.close()
        }
    }

    private fun request(id: String, operation: String, body: JSONObject) {
        if (operation == "model-machines-cached") {
            check(currentComputer()) { "MOBILE_COMPUTER_CHANGED" }
            val workers = RabiComputerDirectoryCache.read(this, account).orEmpty()
            resolve(id, true, JSONArray(workers.map {
                JSONObject().put("id", it.id).put("name", it.name)
            }).toString())
            return
        }
        if (operation == "model-machines") {
            check(currentComputer()) { "MOBILE_COMPUTER_CHANGED" }
            val workers = try {
                RabiRouteSdk().getMobileState(account.baseUrl, account.token).workers
            } catch (error: RabiHttpException) {
                if (error.statusCode !in listOf(401, 403)) throw error
                RabiComputerDirectoryCache.clear(this, account)
                throw IllegalStateException("MOBILE_COMPUTER_AUTHORIZATION_CHANGED")
            }
            check(currentComputer()) { "MOBILE_COMPUTER_CHANGED" }
            RabiComputerDirectoryCache.save(this, account, workers)
            resolve(id, true, JSONArray(workers.map {
                JSONObject().put("id", it.id).put("name", it.name).put("online", it.online)
            }).toString())
            return
        }
        val modelKind = when (operation) { "model-asr" -> "asr"; "model-tts" -> "tts"; else -> null }
        val choice = modelKind?.let { voiceModel(it) }
        if (modelKind != null && (choice == null || body.remove("machine") != choice.getString("machine") ||
                body.remove("selectedModel") != choice.getString("model"))) error("MOBILE_MODEL_CHANGED")
        val machine = if (operation == "models") body.getString("machine") else choice?.getString("machine")
        val target = if (machine == null) targetComputer() else {
            require(machine.length in 1..200)
            check(currentComputer()) { "MOBILE_COMPUTER_CHANGED" }
            RabiRouteSdk().getMobileState(account.baseUrl, account.token).workers
                .singleOrNull { it.id == machine } ?: error("MOBILE_COMPUTER_UNAVAILABLE")
        }
        val (path, bytes, contentType, lane) = when (operation) {
            "models" -> Request("/api/speech/models?computeDeviceId=")
            "state" -> Request("/api/voice-assistant/state?view=mobile")
            "messages" -> Request("/api/voice-assistant/messages?view=mobile")
            "submit" -> {
                check(body.optString("action") == "mobile-voice-submit" && body.optString("requestId").isNotBlank())
                Request("/api/voice-assistant/command", body.toString().toByteArray(Charsets.UTF_8), "application/json")
            }
            "asr" -> {
                val sessionId = body.getString("sessionId")
                val source = body.getString("source")
                require(sessionId.length in 1..128 && source in listOf("active", "local"))
                val pcm = Base64.decode(body.getString("audio"), Base64.NO_WRAP)
                require(pcm.size in 44..2_100_000)
                Request("/api/voice-assistant/mobile-transcribe?sessionId=" + Uri.encode(sessionId) + "&source=" + source,
                    pcm, "audio/wav", lane = 1)
            }
            "model-asr" -> {
                val model = checkNotNull(choice).getString("model")
                val pcm = Base64.decode(body.getString("audio"), Base64.NO_WRAP)
                require(pcm.size in 44..2_100_000)
                val boundary = "rabi-mobile-" + UUID.randomUUID()
                val output = ByteArrayOutputStream()
                output.write(("--$boundary\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n$model\r\n" +
                    "--$boundary\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nverbose_json\r\n" +
                    "--$boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.wav\"\r\n" +
                    "Content-Type: audio/wav\r\n\r\n").toByteArray(Charsets.UTF_8))
                output.write(pcm)
                output.write("\r\n--$boundary--\r\n".toByteArray(Charsets.UTF_8))
                Request("/api/speech/asr?computeDeviceId=", output.toByteArray(), "multipart/form-data; boundary=$boundary", lane = 1)
            }
            "tts", "model-tts" -> {
                body.put("play", false).put("responseFormat", "wav")
                if (operation == "model-tts") body.put("model", checkNotNull(choice).getString("model")).put("voice", "default")
                val compute = if (operation == "model-tts") "?computeDeviceId=" else
                    body.remove("computeDeviceId")?.toString()?.let { "?computeDeviceId=" + Uri.encode(it) }.orEmpty()
                Request("/api/speech/tts" + compute, body.toString().toByteArray(Charsets.UTF_8), "application/json", lane = 2)
            }
            "assistant-tts" -> {
                val sessionId = body.opt("sessionId") as? String
                val responseId = body.opt("responseId") as? String
                val input = body.opt("input") as? String
                check(body.length() == 3 && sessionId != null && sessionId.length in 1..128 &&
                    responseId != null && responseId.length in 1..256 && input != null &&
                    input.isNotBlank() && input.length <= 16_000) { "MOBILE_ASSISTANT_TTS_REQUEST_INVALID" }
                Request("/api/voice-assistant/mobile-tts", body.toString().toByteArray(Charsets.UTF_8), "application/json", lane = 2)
            }
            else -> error("MOBILE_REQUEST_INVALID")
        }
        val method = if (bytes.isEmpty()) "GET" else "POST"
        val headers = if (contentType.isEmpty()) emptyMap() else mapOf("content-type" to contentType)
        val response = transports[lane].request(account.baseUrl, account.token, target, method, path, headers, bytes)
        if ((operation == "tts" || operation == "model-tts" || operation == "assistant-tts") && response.statusCode in 200..299) {
            val responseType = response.headers.entries.firstOrNull { it.key.equals("content-type", ignoreCase = true) }?.value.orEmpty()
            val validAudio = if (operation == "assistant-tts") {
                responseType.substringBefore(';').trim().equals("audio/wav", ignoreCase = true) &&
                    response.body.size >= 44 && String(response.body, 0, 4, Charsets.US_ASCII) == "RIFF" &&
                    String(response.body, 8, 4, Charsets.US_ASCII) == "WAVE"
            } else responseType.startsWith("audio/") || responseType.startsWith("application/octet-stream")
            check(validAudio) { "MOBILE_AUDIO_RESPONSE_INVALID" }
            resolve(id, true, Base64.encodeToString(response.body, Base64.NO_WRAP))
            return
        }
        val text = String(response.body, Charsets.UTF_8)
        val document = runCatching { JSONObject(text) }.getOrNull()
        val directAsr = operation == "asr" || operation == "model-asr"
        if (response.statusCode !in 200..299 || !directAsr && document?.optInt("code", -1) != 0) {
            val code = document?.optString("message").orEmpty()
            error(code.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{1,100}")) } ?: "MOBILE_ASSISTANT_HTTP_" + response.statusCode)
        }
        resolve(id, true, if (directAsr) text else document!!.get("data").toString())
    }

    private data class Request(val path: String, val body: ByteArray = ByteArray(0), val contentType: String = "", val lane: Int = 0)
    private fun modelPreferenceKey(kind: String): String =
        "model:" + com.rabi.link.transport.AsrDirectory.accountIdentity(account.baseUrl, account.token) + ":" + computerId + ":" + kind

    private fun voiceModel(kind: String): JSONObject? {
        val raw = localSwitch.getString(modelPreferenceKey(kind), null) ?: return null
        return runCatching { JSONObject(raw) }.getOrNull()
    }

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
            val limit = if (operation == "asr" || operation == "model-asr") 2_850_000 else 30_000
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

        @JavascriptInterface fun recognitionStart(id: String, sessionId: String): Boolean = startRecognition(id, sessionId)

        @JavascriptInterface fun recognitionPcm(id: String, sequence: Int, audio: String, providerReady: Boolean): Boolean {
            if (!inForeground || audio.length > 4300) return false
            val active = recognition?.takeIf { it.id == id } ?: return false
            val bytes = runCatching { Base64.decode(audio, Base64.NO_WRAP) }.getOrNull() ?: return false
            return active.offer(sequence, bytes, providerReady)
        }

        @JavascriptInterface fun recognitionCancel(id: String) = stopRecognition(id)

        @JavascriptInterface fun wakeSupported(model: String, hash: String): Boolean = MobileWakeSession.supports(model, hash)

        @JavascriptInterface fun wakeStart(id: String, model: String, hash: String, keywords: String, count: Int): Boolean =
            startLocalWake(id, model, hash, keywords, count)

        @JavascriptInterface fun wakePcm(id: String, after: Double, audio: String): Boolean {
            if (!inForeground || audio.length > 2732 || after !in 1.0..9_007_199_254_740_991.0 || after != after.toLong().toDouble()) return false
            val active = localWake?.takeIf { it.id == id } ?: return false
            val bytes = runCatching { Base64.decode(audio, Base64.NO_WRAP) }.getOrNull() ?: return false
            return active.offer(after.toLong(), bytes)
        }

        @JavascriptInterface fun wakeCancel(id: String) = stopLocalWake(id)

        @JavascriptInterface fun startMode(): String = localSwitch.getString("startMode", "manual") ?: "manual"

        @JavascriptInterface fun setStartMode(mode: String) {
            if (mode in listOf("manual", "keyword")) localSwitch.edit().putString("startMode", mode).apply()
        }

        @JavascriptInterface fun backgroundTranscription(): Boolean = localSwitch.getBoolean("backgroundTranscription", false)

        @JavascriptInterface fun setBackgroundTranscription(enabled: Boolean) {
            localSwitch.edit().putBoolean("backgroundTranscription", enabled).apply()
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

        @JavascriptInterface fun selectedModel(kind: String): String =
            if (kind in listOf("asr", "tts")) voiceModel(kind)?.toString().orEmpty() else ""

        @JavascriptInterface fun selectModel(kind: String, machine: String, model: String): Boolean {
            if (!inForeground || !currentComputer() || kind !in listOf("asr", "tts") ||
                machine.length > 200 || model.length > 200 || model.contains(Regex("[\\x00-\\x1f\\x7f]")) ||
                machine.isBlank() != model.isBlank()) return false
            val key = modelPreferenceKey(kind)
            return localSwitch.edit().apply {
                if (machine.isBlank()) remove(key) else putString(key, JSONObject().put("machine", machine).put("model", model).toString())
            }.commit()
        }

        @JavascriptInterface fun close() = runOnUiThread { finish() }
    }

    private companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val MIC_PERMISSION = 401
    }
}
