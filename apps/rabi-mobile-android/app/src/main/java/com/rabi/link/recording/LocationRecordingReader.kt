package com.rabi.link.recording

import android.content.Context
import com.rabi.link.location.LocationRepository
import com.rabi.link.location.SavedLocation

/** A read projection of the existing location database, without duplicate manifests or uploads. */
class LocationRecordingReader(private val context: Context, private val databaseName: String = "rabi-location.db") {
    data class Record(val entry: RecordingStore.Entry, val sample: SavedLocation)
    fun read(from: Long, until: Long, time: Long, cursorId: String, older: Boolean?): List<Record> =
        LocationRepository(context, databaseName).use { repository ->
            val points = if (older == null) repository.recent(from, until, 1000) else repository.page(time,cursorId,older)
            points.map { sample -> Record(RecordingStore.Entry(LocationRepository.recordId(sample.id), "location", "phone",
                sample.point.time,sample.point.time,"saved",context.cacheDir,emptyList(),"位置记录"),sample) }
        }
}
