package com.rabi.link.assistant

import android.content.Context
import com.rabi.link.BuildConfig
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

internal data class MobileWakeHit(val label: String, val firstSeconds: Float, val lastSeconds: Float)

internal interface MobileWakeEngine : AutoCloseable {
    fun startUtterance()
    fun accept(samples: FloatArray): MobileWakeHit?
    fun endUtterance()
}

/** In-process, foreground-only wake detection on the WebView microphone timeline. */
internal class MobileWakeSession(
    val id: String,
    private val aliasCount: Int,
    private val openEngine: () -> MobileWakeEngine,
    private val emit: (JSONObject) -> Unit
) : AutoCloseable {
    constructor(
        id: String,
        context: Context,
        keywords: String,
        aliasCount: Int,
        emit: (JSONObject) -> Unit
    ) : this(id, aliasCount, { MobileWakeProvider.open(context, keywords) }, emit)

    private data class Frame(val after: Long, val pcm: ByteArray)

    private val frames = ArrayBlockingQueue<Frame>(32)
    private val closed = AtomicBoolean(false)
    private var lastAfter: Long? = null

    @Synchronized fun offer(after: Long, pcm: ByteArray): Boolean {
        // Keep accepting bridge calls until the posted hit or error is handled on the UI thread.
        if (closed.get()) return true
        if (pcm.size !in 2..2048 || pcm.size % 2 != 0 || after < pcm.size / 2) return false
        if (lastAfter?.let { after - it != (pcm.size / 2).toLong() } == true) return false
        if (!frames.offer(Frame(after, pcm))) return false
        lastAfter = after
        return true
    }

    fun run() {
        try {
            if (closed.get()) return
            openEngine().use { engine ->
                if (closed.get()) return
                emit(JSONObject().put("type", "ready"))
                detect(engine)
            }
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        } catch (_: Exception) {
            reportFailure()
        } catch (_: LinkageError) {
            reportFailure()
        } finally {
            close()
        }
    }

    private fun detect(engine: MobileWakeEngine) {
        val preRoll = ArrayDeque<FloatArray>()
        var preRollSamples = 0
        var quietSamples = 0
        var gateStart = 0L
        var origin = 0L
        var speaking = false
        while (!closed.get()) {
            val frame = frames.poll(150, TimeUnit.MILLISECONDS) ?: continue
            val pcm = ByteBuffer.wrap(frame.pcm).order(ByteOrder.LITTLE_ENDIAN)
            val samples = FloatArray(frame.pcm.size / 2) { pcm.short / 32768f }
            val power = samples.sumOf { (it * it).toDouble() }
            val audible = power >= samples.size * 0.025 * 0.025
            if (!speaking) {
                if (!audible) {
                    preRoll.addLast(samples)
                    preRollSamples += samples.size
                    // Retain the frame that overlaps the start of the window until the gate opens.
                    while (preRollSamples - preRoll.first().size >= KEYWORD_WINDOW_SAMPLES) {
                        preRollSamples -= preRoll.removeFirst().size
                    }
                    continue
                }
                speaking = true
                gateStart = frame.after - samples.size
                val trim = (preRollSamples - KEYWORD_WINDOW_SAMPLES).coerceAtLeast(0)
                if (trim > 0) {
                    val firstFrame = preRoll.removeFirst()
                    preRoll.addFirst(firstFrame.copyOfRange(trim, firstFrame.size))
                }
                origin = gateStart - (preRollSamples - trim)
                engine.startUtterance()
                for (previous in preRoll) {
                    val hit = engine.accept(previous)
                    if (hit != null && emitHit(hit, origin, gateStart, frame.after)) return
                }
                preRoll.clear()
                preRollSamples = 0
            }
            quietSamples = if (audible) 0 else quietSamples + samples.size
            val hit = engine.accept(samples)
            if (hit != null && emitHit(hit, origin, gateStart, frame.after)) return
            if (quietSamples >= KEYWORD_WINDOW_SAMPLES) {
                engine.endUtterance()
                speaking = false
                quietSamples = 0
            }
        }
    }

    private fun emitHit(hit: MobileWakeHit, origin: Long, gateStart: Long, after: Long): Boolean {
        val aliasIndex = hit.label.removePrefix("rabi-").toIntOrNull() ?: return false
        if (hit.label != "rabi-$aliasIndex" || aliasIndex !in 0 until aliasCount ||
            !hit.firstSeconds.isFinite() || !hit.lastSeconds.isFinite() || hit.firstSeconds < 0f ||
            hit.lastSeconds < hit.firstSeconds) return false
        val first = origin + (hit.firstSeconds * SAMPLE_RATE).roundToInt()
        val last = origin + (hit.lastSeconds * SAMPLE_RATE).roundToInt()
        if (first < origin || last >= after || after - last > SAMPLE_RATE || closed.get()) return false
        // A quiet keyword can begin before the volume gate.
        val utteranceStart = minOf(gateStart, first)
        // Sherpa timestamps start inside the last phone. Keep the audio immediately after it.
        val replayFrom = (last + 640).coerceIn(utteranceStart, after - 1)
        emit(JSONObject().put("type", "hit").put("aliasIndex", aliasIndex)
            .put("utteranceStartSample", utteranceStart).put("replayFromSample", replayFrom))
        return true
    }

    private fun reportFailure() {
        if (!closed.get()) emit(JSONObject().put("type", "error").put("code", "MOBILE_WAKE_ENGINE_FAILED"))
    }

    override fun close() {
        closed.set(true)
        frames.clear()
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        private const val KEYWORD_WINDOW_SAMPLES = SAMPLE_RATE * 950 / 1000

        fun supports(model: String, tokensSha256: String): Boolean = MobileWakeProvider.available &&
            model == BuildConfig.MOBILE_WAKE_MODEL && tokensSha256 == BuildConfig.MOBILE_WAKE_TOKENS_SHA256

        fun validKeywords(keywords: String, aliasCount: Int): Boolean {
            if (aliasCount !in 1..64 || keywords.length !in 1..8192) return false
            val rows = keywords.split('/')
            return rows.size == aliasCount && rows.withIndex().all { (index, row) ->
                val tokens = row.split(' ')
                tokens.size in 2..65 && tokens.last() == "@rabi-$index" &&
                    tokens.dropLast(1).all { token -> token.length in 1..24 && token.all { it.isLetterOrDigit() } }
            }
        }
    }
}
