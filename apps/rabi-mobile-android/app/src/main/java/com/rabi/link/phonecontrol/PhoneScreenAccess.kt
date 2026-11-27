package com.rabi.link.phonecontrol

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.SystemClock
import android.util.Base64
import com.rabi.link.RabiPhoneFiles
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import kotlin.math.ceil
import kotlin.math.min
import kotlin.math.roundToInt

/** Exposes bounded screenshots to the authorized phone Relay connection. */
class PhoneScreenAccess {
    fun execute(action: String, input: JSONObject, guard: Runnable, instanceId: String): JSONObject =
        execute(action, input, guard, instanceId, false)

    internal fun execute(action: String, input: JSONObject, guard: Runnable, instanceId: String, afterInput: Boolean,
                         compareContent: Boolean = false): JSONObject {
        guard.run()
        val owner = PhoneScreenShareService.current()
        if (action == "screen.status") return (owner?.status() ?: JSONObject().put("state", "consent-required")
            .put("activity", JSONObject().put("observations", org.json.JSONArray()))).also { guard.run() }
        val label = input.optString("observerLabel").filterNot(Char::isISOControl).trim().take(120).ifEmpty { "Rabi" }
        return when (action) {
            "screen.capture" -> {
                val width = integer(input, "maxWidth", 960, 16..1920)
                if (owner == null) throw RabiPhoneFiles.Failure(409, "PHONE_SCREEN_CONSENT_REQUIRED")
                val notice = owner.beginObservation(label)
                try {
                    if (afterInput) SystemClock.sleep(INPUT_SETTLE_MS)
                    val frame = owner.snapshot(guard) ?: throw RabiPhoneFiles.Failure(409, "PHONE_SCREEN_FRAME_UNAVAILABLE")
                    withImage(frame, width) { output ->
                        val hashes = checkNotNull(PixelDigest().read(output, frame))
                        encode(owner, frame, output, hashes, width, instanceId, guard)
                    }
                        ?: throw RabiPhoneFiles.Failure(409, "PHONE_SCREEN_TARGET_CHANGED")
                } finally { owner.finishObservation(notice) }
            }
            "screen.wait" -> waitForChange(owner, input, label, instanceId, guard, afterInput, compareContent)
            else -> throw IllegalArgumentException("Unknown screen action")
        }
    }

    private fun integer(input: JSONObject, field: String, fallback: Int, range: IntRange): Int {
        val raw = input.opt(field) ?: return fallback
        val value = (raw as? Number)?.toDouble() ?: Double.NaN
        require(value.isFinite() && value % 1 == 0.0 && value in range.first.toDouble()..range.last.toDouble())
        return value.toInt()
    }

    private fun waitForChange(owner: PhoneScreenShareService?, input: JSONObject, label: String, instanceId: String, guard: Runnable,
                              afterInput: Boolean, compareContent: Boolean): JSONObject {
        val waitMs = integer(input, "waitMs", 2500, 100..5000)
        val source = requireNotNull(input.optJSONObject("source"))
        val frameId = source.optString("frameId")
        val epoch = source.optString("layoutRevision")
        require(frameId.isNotBlank() && epoch.isNotBlank() && source.optString("instanceId").isNotBlank())
        val baseline = owner?.reference(frameId)
        if (owner == null || baseline == null || source.optString("instanceId") != instanceId || baseline.epoch != epoch) {
            return state("target-changed")
        }

        val deadline = SystemClock.elapsedRealtime() + waitMs
        var after = baseline.sequence
        val notice = owner.beginObservation(label)
        val digestReader = PixelDigest()
        try {
            // A finished Android gesture can precede the receiving app's next draw.
            if (afterInput) SystemClock.sleep(INPUT_SETTLE_MS)
            while (true) {
                val frame = owner.snapshot(guard, deadline, after, epoch) ?: break
                after = frame.sequence
                val changed = withImage(frame, baseline.maxWidth) { output ->
                    val comparison = if (compareContent) baseline.contentDigest else baseline.digest
                    val hashes = digestReader.read(output, frame, comparison, compareContent) ?: return@withImage null
                    val capture = encode(owner, frame, output, hashes, baseline.maxWidth, instanceId, guard)
                    if (capture == null) state("target-changed") else state("changed").put("capture", capture)
                }
                if (changed != null) return changed
                val remaining = deadline - SystemClock.elapsedRealtime()
                if (remaining > 0) SystemClock.sleep(min(remaining, 125))
            }
            return state(if (owner.ownsEpoch(epoch)) "unchanged" else "target-changed")
        } finally { owner.finishObservation(notice) }
    }

    private data class FrameHashes(val full: ByteArray, val content: ByteArray)

    private class PixelDigest {
        private var pixels: ByteBuffer? = null
        private val hash = MessageDigest.getInstance("SHA-256")

        fun read(bitmap: Bitmap, frame: PhoneScreenShareService.Snapshot, baseline: ByteArray? = null, compareContent: Boolean = false): FrameHashes? {
            val buffer = pixels?.takeIf { it.capacity() == bitmap.byteCount }
                ?: ByteBuffer.allocate(bitmap.byteCount).also { pixels = it }
            buffer.clear()
            bitmap.copyPixelsToBuffer(buffer)
            val bytes = buffer.array()
            val systemBars = frame.systemBars
            val area = Rect(
                ceil(systemBars.left.toDouble() * bitmap.width / frame.nativeWidth).toInt(),
                ceil(systemBars.top.toDouble() * bitmap.height / frame.nativeHeight).toInt(),
                bitmap.width - ceil(systemBars.right.toDouble() * bitmap.width / frame.nativeWidth).toInt(),
                bitmap.height - ceil(systemBars.bottom.toDouble() * bitmap.height / frame.nativeHeight).toInt()
            )
            fun contentHash(): ByteArray {
                if (area.isEmpty || area == Rect(0, 0, bitmap.width, bitmap.height)) return hash.digest(bytes)
                for (row in area.top until area.bottom) hash.update(bytes, row * bitmap.rowBytes + area.left * 4, area.width() * 4)
                return hash.digest()
            }
            val compared = if (compareContent) contentHash() else hash.digest(bytes)
            if (baseline != null && baseline.contentEquals(compared)) return null
            return if (compareContent) FrameHashes(hash.digest(bytes), compared) else FrameHashes(compared, contentHash())
        }
    }

    private fun state(value: String) = JSONObject().put("state", value)
    private companion object { const val INPUT_SETTLE_MS = 80L }

    private inline fun <T> withImage(frame: PhoneScreenShareService.Snapshot, width: Int, read: (Bitmap) -> T): T {
        val original = frame.bitmap
        var output = original
        try {
            if (original.width > width) output = Bitmap.createScaledBitmap(original, width,
                (original.height.toDouble() * width / original.width).roundToInt().coerceAtLeast(1), true)
            return read(output)
        } finally {
            if (output !== original) output.recycle()
            original.recycle()
        }
    }

    private fun encode(owner: PhoneScreenShareService, frame: PhoneScreenShareService.Snapshot, output: Bitmap,
                       hashes: FrameHashes, maxWidth: Int, instanceId: String, guard: Runnable): JSONObject? {
        val bytes = ByteArrayOutputStream()
        check(output.compress(Bitmap.CompressFormat.PNG, 100, bytes))
        guard.run()
        val frameId = UUID.randomUUID().toString()
        if (!owner.remember(frameId, frame, maxWidth, hashes.full, hashes.content, output.width, output.height)) return null
        val bounds = JSONObject().put("x", 0).put("y", 0).put("width", frame.nativeWidth).put("height", frame.nativeHeight)
        val source = JSONObject().put("kind", "desktop").put("coordinateSpace", "capture").put("scope", "virtual")
            .put("captureMethod", "android-media-projection").put("bounds", bounds).put("layoutRevision", frame.epoch)
            .put("width", output.width).put("height", output.height).put("frameId", frameId).put("instanceId", instanceId)
            .put("capturedAt", frame.capturedAt)
        return JSONObject().put("mimeType", "image/png").put("width", output.width).put("height", output.height)
            .put("capturedAt", frame.capturedAt).put("frameId", frameId).put("bounds", bounds)
            .put("source", source).put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
    }
}
