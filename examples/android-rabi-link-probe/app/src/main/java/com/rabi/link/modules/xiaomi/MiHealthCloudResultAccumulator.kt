package com.rabi.link.modules.xiaomi

import com.xiaomi.micloud.fit.DataPoint
import org.json.JSONArray
import org.json.JSONObject

internal class MiHealthCloudResultAccumulator {
    val rawHttpBuffer = JSONArray()

    private val pointBuffer = JSONArray()
    private val sourceBuffer = JSONArray()
    private val pageBuffer = JSONArray()
    private val errorBuffer = JSONArray()

    val pointCount: Int
        get() = pointBuffer.length()

    val rawHttpCount: Int
        get() = rawHttpBuffer.length()

    val errorCount: Int
        get() = errorBuffer.length()

    fun recordPoint(dataTypeName: String, sourceId: String, page: Int, point: DataPoint) {
        pointBuffer.put(normalizePoint(dataTypeName, sourceId, page, point))
    }

    fun summarizePoint(point: DataPoint): String {
        return try {
            val json = point.jsonObject
            val startNs = json.optLong("startTimeNanos", -1L)
            val endNs = json.optLong("endTimeNanos", -1L)
            val value = json.optJSONArray("value")
            "start=${formatNs(startNs)} end=${formatNs(endNs)} value=$value"
        } catch (error: Throwable) {
            point.toString()
        }
    }

    fun recordSourceResult(dataTypeName: String, responseCode: Int, success: Boolean, desc: String?, sourceCount: Int) {
        sourceBuffer.put(
            JSONObject()
                .put("dataType", dataTypeName)
                .put("endpoint", "/fitness/v1/users/me/dataSources")
                .put("responseCode", responseCode)
                .put("success", success)
                .put("desc", desc ?: "")
                .put("sourceCount", sourceCount)
        )
    }

    fun recordPageResult(
        dataTypeName: String,
        sourceId: String,
        page: Int,
        startNs: Long,
        endNs: Long,
        limit: Int,
        pageToken: String?,
        nextPageToken: String?,
        pointCount: Int,
        rawDataSetJson: JSONObject
    ) {
        pageBuffer.put(
            JSONObject()
                .put("dataType", dataTypeName)
                .put("sourceId", sourceId)
                .put("endpoint", "/fitness/v1/users/me/dataSources/{sourceId}/datasets/{startNs-endNs}")
                .put("page", page)
                .put("startTimeNanos", startNs)
                .put("endTimeNanos", endNs)
                .put("startTime", formatNs(startNs))
                .put("endTime", formatNs(endNs))
                .put("limit", limit)
                .put("hasPageToken", !pageToken.isNullOrBlank())
                .put("hasNextPageToken", !nextPageToken.isNullOrBlank())
                .put("pointCount", pointCount)
                .put("rawKeys", JSONArray(rawDataSetJson.keys().asSequence().toList()))
                .put("rawDataPointCount", rawDataSetJson.optJSONArray("dataPoint")?.length() ?: -1)
        )
    }

    fun recordError(stage: String, dataTypeName: String, error: Throwable) {
        errorBuffer.put(
            JSONObject()
                .put("stage", stage)
                .put("dataType", dataTypeName)
                .put("type", error.javaClass.simpleName)
                .put("message", error.message ?: "")
        )
    }

    fun snapshot(
        dataTypeNames: List<String>,
        statusMessage: String,
        startNs: Long,
        endNs: Long,
        reportSliceHours: Long,
        totalPoints: Int
    ): MiHealthCloudMarkdownReportRenderer.Snapshot {
        return MiHealthCloudMarkdownReportRenderer.Snapshot(
            dataTypeNames = dataTypeNames,
            statusMessage = statusMessage,
            startNs = startNs,
            endNs = endNs,
            reportSliceHours = reportSliceHours,
            totalPoints = totalPoints,
            savedAtMillis = System.currentTimeMillis(),
            pointBuffer = pointBuffer,
            sourceBuffer = sourceBuffer,
            pageBuffer = pageBuffer,
            rawHttpBuffer = rawHttpBuffer,
            errorBuffer = errorBuffer
        )
    }

    private fun normalizePoint(dataTypeName: String, sourceId: String, page: Int, point: DataPoint): JSONObject {
        return try {
            val json = JSONObject(point.jsonObject.toString())
            val startNs = json.optLong("startTimeNanos", -1L)
            val endNs = json.optLong("endTimeNanos", -1L)
            val value = json.optJSONArray("value") ?: JSONArray()
            JSONObject()
                .put("dataType", dataTypeName)
                .put("sourceId", sourceId)
                .put("page", page)
                .put("uniqueKey", buildPointKey(dataTypeName, sourceId, startNs, endNs, value))
                .put("startTimeNanos", startNs)
                .put("endTimeNanos", endNs)
                .put("startTime", formatNs(startNs))
                .put("endTime", formatNs(endNs))
                .put("value", value)
                .put("raw", json)
        } catch (error: Throwable) {
            JSONObject()
                .put("dataType", dataTypeName)
                .put("sourceId", sourceId)
                .put("page", page)
                .put("error", "${error.javaClass.simpleName}: ${error.message}")
                .put("rawText", point.toString())
        }
    }

    private fun buildPointKey(dataTypeName: String, sourceId: String, startNs: Long, endNs: Long, value: JSONArray): String {
        return listOf(dataTypeName, sourceId, startNs.toString(), endNs.toString(), value.toString()).joinToString("|")
    }

    private fun formatNs(ns: Long): String {
        return MiHealthCloudTimeFormatter.formatNs(ns)
    }
}
