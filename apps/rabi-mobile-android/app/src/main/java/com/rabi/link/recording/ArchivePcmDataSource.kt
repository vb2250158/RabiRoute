package com.rabi.link.recording

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSourceException
import androidx.media3.datasource.DataSpec
import java.io.Closeable
import java.io.IOException

/** Media3 virtual WAV adapter. Metadata and target selection are resolved before constructing Factory.
 * open/read run on the player's loader thread. No caller-supplied URI is used as a network address.
 */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ArchivePcmDataSource private constructor(
    private val mediaUri: Uri,
    private val openSession: () -> Session
) : BaseDataSource(true) {
    /** A newly acquired reader and optional pin per open; releasePin must not close a shared transport. */
    class Session(val reader: ArchivePcmReader, private val releasePin: Closeable? = null) : Closeable {
        private var closed = false
        @Synchronized override fun close() {
            if (closed) return
            closed = true
            try { reader.close() } finally { releasePin?.close() }
        }
    }

    class Factory(recordKey: String, private val openSession: () -> Session) : DataSource.Factory {
        private val mediaUri: Uri
        init {
            require(recordKey.matches(Regex("[a-f0-9]{64}"))) { "Use a hash of the frozen archive identity as the media key" }
            mediaUri = Uri.parse("rabi-archive://record/$recordKey")
        }
        /** Use this URI in MediaItem; it contains no path, owner, credentials or endpoint. */
        fun uri(): Uri = mediaUri
        override fun createDataSource(): ArchivePcmDataSource = ArchivePcmDataSource(mediaUri, openSession)
    }

    private var session: Session? = null
    private var position = 0L
    private var remaining = 0L
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        check(session == null && !opened) { "Data source already open" }
        if (dataSpec.uri != mediaUri || dataSpec.httpMethod != DataSpec.HTTP_METHOD_GET || dataSpec.httpBody != null) {
            throw IOException("Unsupported archive media request")
        }
        transferInitializing(dataSpec)
        val acquired = openSession()
        try {
            val size = acquired.reader.length()
            if (dataSpec.position < 0 || dataSpec.position > size) {
                throw DataSourceException(PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE)
            }
            position = dataSpec.position
            remaining = size - position
            if (dataSpec.length != C.LENGTH_UNSET.toLong()) {
                if (dataSpec.length < 0) throw IOException("Invalid archive read length")
                remaining = minOf(remaining, dataSpec.length)
            }
            session = acquired
            opened = true
            transferStarted(dataSpec)
            return remaining
        } catch (failure: Throwable) {
            session = null
            opened = false
            try { acquired.close() } catch (closing: Throwable) { failure.addSuppressed(closing) }
            throw failure
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val current = session ?: throw IOException("Archive media is not open")
        if (offset < 0 || length < 0 || offset > buffer.size || length > buffer.size - offset) throw IndexOutOfBoundsException()
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val count = current.reader.readAt(position, buffer, offset, minOf(length.toLong(), remaining).toInt())
        if (count == -1) throw IOException("Archive media ended before its declared length")
        position += count
        remaining -= count
        bytesTransferred(count)
        return count
    }

    override fun getUri(): Uri? = if (opened) mediaUri else null

    override fun close() {
        val current = session
        session = null
        remaining = 0
        try { current?.close() } finally {
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }
}
