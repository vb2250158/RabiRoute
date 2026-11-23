package com.rabi.link.assistant

import android.content.Context
import com.k2fsa.sherpa.onnx.KeywordSpotter
import com.k2fsa.sherpa.onnx.KeywordSpotterConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import com.rabi.link.BuildConfig
import java.io.File

internal object MobileWakeProvider {
    const val available = true
    private val modelFiles = listOf(
        "encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
        "decoder-epoch-13-avg-2-chunk-8-left-64.onnx",
        "joiner-epoch-13-avg-2-chunk-8-left-64.int8.onnx",
        "tokens.txt"
    )

    @Synchronized fun open(context: Context, keywords: String): MobileWakeEngine {
        val directory = File(context.cacheDir, BuildConfig.MOBILE_WAKE_MODEL)
        check(directory.isDirectory || directory.mkdirs())
        val paths = modelFiles.map { name ->
            val target = File(directory, name)
            if (!target.isFile) {
                val staged = File.createTempFile("asset-", ".tmp", directory)
                try {
                    context.assets.open("mobile-wake/$name").use { source ->
                        staged.outputStream().use { destination -> source.copyTo(destination) }
                    }
                    check(staged.renameTo(target))
                } finally {
                    staged.delete()
                }
            }
            target.absolutePath
        }
        val tokens = File(paths[3]).useLines { lines -> lines.map { it.substringBefore(' ') }.toSet() }
        require(keywords.split('/').all { row -> row.split(' ').dropLast(1).all(tokens::contains) })
        val aliases = File.createTempFile("keywords-", ".txt", directory)
        try {
            aliases.writeText(keywords.replace('/', '\n') + '\n')
            return SherpaWakeEngine(KeywordSpotter(config = KeywordSpotterConfig(
                modelConfig = OnlineModelConfig(
                    transducer = OnlineTransducerModelConfig(paths[0], paths[1], paths[2]),
                    tokens = paths[3], numThreads = 1, provider = "cpu", modelType = "zipformer2"
                ),
                keywordsFile = aliases.absolutePath, keywordsScore = 1.0f, keywordsThreshold = 0.25f, numTrailingBlanks = 1
            )))
        } finally {
            aliases.delete()
        }
    }
}

private class SherpaWakeEngine(private val spotter: KeywordSpotter) : MobileWakeEngine {
    private var stream: OnlineStream? = null

    override fun startUtterance() {
        endUtterance()
        stream = spotter.createStream()
    }

    override fun accept(samples: FloatArray): MobileWakeHit? {
        val active = checkNotNull(stream)
        active.acceptWaveform(samples, MobileWakeSession.SAMPLE_RATE)
        while (spotter.isReady(active)) {
            spotter.decode(active)
            val result = spotter.getResult(active)
            if (result.keyword.isNotEmpty() && result.timestamps.isNotEmpty()) {
                return MobileWakeHit(result.keyword, result.timestamps.first(), result.timestamps.last())
            }
        }
        return null
    }

    override fun endUtterance() {
        stream?.release()
        stream = null
    }

    override fun close() {
        endUtterance()
        spotter.release()
    }
}
