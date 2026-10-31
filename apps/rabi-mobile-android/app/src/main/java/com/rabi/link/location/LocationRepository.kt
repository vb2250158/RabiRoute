package com.rabi.link.location

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

data class SavedLocation(val id: Long, val point: LocationPoint, val address: String)

/** SQLite owns durable samples, reusable address labels and conservative request accounting. */
class LocationRepository(context: Context, databaseName: String = "rabi-location.db") : SQLiteOpenHelper(context.applicationContext, databaseName, null, 1) {
    companion object {
        private val changes = java.util.concurrent.atomic.AtomicLong()
        fun revision() = changes.get()
        fun recordId(id: Long) = "location-${id.toString().padStart(20, '0')}"
    }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE points (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, accuracy REAL NOT NULL, provider TEXT NOT NULL, address TEXT NOT NULL DEFAULT '')")
        db.execSQL("CREATE INDEX points_time ON points(time)")
        db.execSQL("CREATE TABLE addresses (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, label TEXT NOT NULL)")
        db.execSQL("CREATE TABLE usage (month TEXT PRIMARY KEY, requests INTEGER NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun add(point: LocationPoint): Long = writableDatabase.insertOrThrow("points", null, ContentValues().apply {
        put("time", point.time); put("latitude", point.latitude); put("longitude", point.longitude)
        put("accuracy", point.accuracy); put("provider", point.provider)
    }).also { changes.incrementAndGet() }
    /** Same ordering key as the unified media timeline, including mixed-kind equal timestamps. */
    fun page(time: Long, cursorId: String, older: Boolean, limit: Int = 101): List<SavedLocation> {
        val comparison = if (older) "<" else ">"
        val direction = if (older) "DESC" else "ASC"
        return readableDatabase.rawQuery(
            "SELECT id,time,latitude,longitude,accuracy,provider,address FROM points WHERE time $comparison ? OR (time=? AND ('location-' || printf('%020d',id)) $comparison ?) ORDER BY time $direction,id $direction LIMIT ?",
            arrayOf(time.toString(),time.toString(),cursorId,limit.coerceIn(1,1000).toString())).use { cursor ->
            buildList { while (cursor.moveToNext()) add(SavedLocation(cursor.getLong(0), LocationPoint(cursor.getLong(1), 0,
                cursor.getDouble(2),cursor.getDouble(3),cursor.getFloat(4),cursor.getString(5)),cursor.getString(6))) }
        }
    }
    fun recent(from: Long, until: Long, limit: Int = 200): List<SavedLocation> = readableDatabase.rawQuery(
        "SELECT id,time,latitude,longitude,accuracy,provider,address FROM points WHERE time>=? AND time<? ORDER BY time DESC,id DESC LIMIT ?",
        arrayOf(from.toString(), until.toString(), limit.coerceIn(1, 1000).toString())).use { cursor ->
        buildList { while (cursor.moveToNext()) add(SavedLocation(cursor.getLong(0), LocationPoint(cursor.getLong(1), 0,
            cursor.getDouble(2), cursor.getDouble(3), cursor.getFloat(4), cursor.getString(5)), cursor.getString(6))) }
    }
    fun count(from: Long, until: Long): Long = readableDatabase.rawQuery("SELECT COUNT(*) FROM points WHERE time>=? AND time<?",
        arrayOf(from.toString(), until.toString())).use { it.moveToFirst(); it.getLong(0) }
    fun month(now: Long): String = DateTimeFormatter.ofPattern("yyyy-MM").withZone(ZoneId.of("Asia/Shanghai")).format(Instant.ofEpochMilli(now))
    fun used(now: Long): Int = readableDatabase.rawQuery("SELECT requests FROM usage WHERE month=?", arrayOf(month(now))).use {
        if (it.moveToFirst()) it.getInt(0) else 0
    }
    @Synchronized fun reserveRequest(now: Long, limit: Int): Boolean {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val used = used(now)
            if (used >= limit) return false
            db.execSQL("INSERT OR REPLACE INTO usage(month,requests) VALUES(?,?)", arrayOf(month(now), used + 1))
            db.setTransactionSuccessful()
            return true
        } finally { db.endTransaction() }
    }
    fun cached(point: LocationPoint, now: Long): String? = readableDatabase.rawQuery(
        "SELECT latitude,longitude,label FROM addresses WHERE time>=? ORDER BY time DESC LIMIT 1000",
        arrayOf((now - 30L * 86_400_000).toString())).use { c ->
        while (c.moveToNext()) {
            val other = point.copy(latitude = c.getDouble(0), longitude = c.getDouble(1))
            if (LocationPolicy.distance(point, other) <= LocationPolicy.CACHE_RADIUS_METERS) return c.getString(2)
        }
        null
    }
    fun label(id: Long, point: LocationPoint, label: String, cache: Boolean) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.update("points", ContentValues().apply { put("address", label) }, "id=?", arrayOf(id.toString()))
            if (cache) {
                db.insertOrThrow("addresses", null, ContentValues().apply {
                    put("time", System.currentTimeMillis()); put("latitude", point.latitude); put("longitude", point.longitude); put("label", label)
                })
                // Address labels are a replaceable cache, never source track points.
                db.execSQL("DELETE FROM addresses WHERE id NOT IN (SELECT id FROM addresses ORDER BY time DESC LIMIT 1000)")
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        changes.incrementAndGet()
    }
    fun export(from: Long, until: Long, output: OutputStream) {
        output.bufferedWriter(Charsets.UTF_8).use { writer ->
            writer.write("{\"type\":\"FeatureCollection\",\"features\":[")
            readableDatabase.rawQuery("SELECT time,latitude,longitude,accuracy,provider,address FROM points WHERE time>=? AND time<? ORDER BY time,id",
                arrayOf(from.toString(), until.toString())).use { c ->
                var comma = false
                while (c.moveToNext()) {
                    if (comma) writer.write(",")
                    comma = true
                    writer.write(JSONObject().put("type", "Feature").put("geometry", JSONObject().put("type", "Point")
                        .put("coordinates", JSONArray().put(c.getDouble(2)).put(c.getDouble(1))))
                        .put("properties", JSONObject().put("time", Instant.ofEpochMilli(c.getLong(0)).toString())
                            .put("accuracyMeters", c.getDouble(3)).put("provider", c.getString(4)).put("address", c.getString(5))).toString())
                }
            }
            writer.write("]}")
        }
    }
}
