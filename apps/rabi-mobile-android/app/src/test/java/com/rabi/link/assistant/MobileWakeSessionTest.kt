package com.rabi.link.assistant

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MobileWakeSessionTest {
    private class Engine(private val result: (Int, FloatArray) -> MobileWakeHit?) : MobileWakeEngine {
        var starts = 0
        val endedAt = mutableListOf<Int>()
        var samplesSeen = 0

        override fun startUtterance() {
            starts++
            samplesSeen = 0
        }

        override fun accept(samples: FloatArray): MobileWakeHit? {
            val start = samplesSeen
            samplesSeen += samples.size
            return result(start, samples)
        }

        override fun endUtterance() {
            endedAt.add(samplesSeen)
        }

        override fun close() = Unit
    }

    private fun feed(session: MobileWakeSession, sampleCount: Int, frameSamples: Int = 800, value: (Int) -> Int) {
        for (start in 0 until sampleCount step frameSamples) {
            val end = minOf(start + frameSamples, sampleCount)
            val pcm = ByteBuffer.allocate((end - start) * 2).order(ByteOrder.LITTLE_ENDIAN)
            for (index in start until end) pcm.putShort(value(index).toShort())
            assertTrue(session.offer(end.toLong(), pcm.array()))
        }
    }

    @Test(timeout = 4_000)
    fun replaysTheCommandBeginningBeforeTheVolumeGate() {
        val gateAt = 22_400
        val keywordFirst = 10_560
        val keywordLast = 15_040
        var firstInStream: Int? = null
        val engine = Engine { position, samples ->
            val first = samples.indexOfFirst { it == 650 / 32768f }
            if (first >= 0) firstInStream = position + first
            val last = samples.indexOfFirst { it == 700 / 32768f }
            val keywordStart = firstInStream
            if (last < 0 || keywordStart == null) null else MobileWakeHit(
                "rabi-0", keywordStart / 16_000f, (position + last) / 16_000f
            )
        }
        val events = mutableListOf<JSONObject>()
        MobileWakeSession("quiet-wake", 1, { engine }, { events.add(it) }).use { session ->
            feed(session, gateAt + 1_600, frameSamples = 896) { sample ->
                when {
                    sample >= gateAt -> 1_600
                    sample == keywordFirst -> 650
                    sample == keywordLast -> 700
                    else -> 200
                }
            }
            session.run()
        }
        assertEquals(1, engine.starts)
        assertEquals(3_360, firstInStream)
        assertEquals(listOf("ready", "hit"), events.map { it.getString("type") })
        val hit = events.last()
        assertEquals(0, hit.getInt("aliasIndex"))
        assertEquals(keywordFirst.toLong(), hit.getLong("utteranceStartSample"))
        assertEquals(15_680L, hit.getLong("replayFromSample"))
    }

    @Test(timeout = 4_000)
    fun keepsTheDecoderAliveThroughAQuiet900MillisecondGap() {
        val engine = Engine { position, samples ->
            if (position + samples.size < 16_000) null else MobileWakeHit("rabi-0", 0.05f, 0.88f)
        }
        val events = mutableListOf<JSONObject>()
        MobileWakeSession("quiet-gap", 1, { engine }, { events.add(it) }).use { session ->
            feed(session, 16_800) { position -> if (position < 800 || position >= 15_200) 1_600 else 200 }
            session.run()
        }
        assertEquals(1, engine.starts)
        assertTrue(engine.endedAt.isEmpty())
        assertEquals(listOf("ready", "hit"), events.map { it.getString("type") })
        assertEquals(0L, events.last().getLong("utteranceStartSample"))
        assertEquals(14_720L, events.last().getLong("replayFromSample"))
    }

    @Test(timeout = 4_000)
    fun endsAnUnrecognizedUtteranceAfter950MillisecondsOfQuiet() {
        val engine = Engine { position, samples ->
            if (samples.none { it > 0.06f }) null
            else MobileWakeHit("rabi-0", position / 16_000f, position / 16_000f)
        }
        val events = mutableListOf<JSONObject>()
        MobileWakeSession("quiet-reset", 1, { engine }, { events.add(it) }).use { session ->
            feed(session, 17_600) { position ->
                when {
                    position < 800 -> 1_600
                    position < 16_800 -> 200
                    else -> 2_600
                }
            }
            session.run()
        }
        assertEquals(2, engine.starts)
        assertEquals(listOf(16_000), engine.endedAt)
        assertEquals(listOf("ready", "hit"), events.map { it.getString("type") })
    }

    @Test(timeout = 4_000)
    fun neverStartsDecodingWhileAllFramesStayBelowTheVolumeGate() {
        val engine = Engine { _, _ -> error("Quiet frames must only fill the pre-roll") }
        val ready = CountDownLatch(1)
        MobileWakeSession("silent", 1, { engine }, { ready.countDown() }).use { session ->
            feed(session, 16_000) { 200 }
            val thread = Thread(session::run)
            thread.start()
            try {
                assertTrue(ready.await(1, TimeUnit.SECONDS))
                Thread.sleep(200)
            } finally {
                session.close()
                thread.join()
            }
        }
        assertEquals(0, engine.starts)
        assertEquals(0, engine.samplesSeen)
    }

    @Test(timeout = 4_000)
    fun acceptsOneValidHitAfterRejectingAliasAndStaleHits() {
        val engine = Engine { position, _ ->
            when (position) {
                0 -> MobileWakeHit("rabi-1", 0f, 0f)
                16_000 -> MobileWakeHit("rabi-0", 0f, 0f)
                16_800, 17_600 -> MobileWakeHit("rabi-0", 1f, 1.04f)
                else -> null
            }
        }
        val events = mutableListOf<JSONObject>()
        MobileWakeSession("one-hit", 1, { engine }, { events.add(it) }).use { session ->
            feed(session, 18_400) { 1_600 }
            session.run()
        }
        assertEquals(listOf("ready", "hit"), events.map { it.getString("type") })
        assertEquals(17_280L, events.last().getLong("replayFromSample"))
        assertEquals(17_600, engine.samplesSeen)
    }
}
