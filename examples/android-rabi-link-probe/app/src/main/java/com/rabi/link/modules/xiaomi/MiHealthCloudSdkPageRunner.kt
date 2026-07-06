package com.rabi.link.modules.xiaomi

import android.content.Context
import com.xiaomi.fits.sdk.FitSDK
import com.xiaomi.micloud.fit.DataSource

internal class MiHealthCloudSdkPageRunner(
    context: Context,
    private val request: MiHealthCloudProbeRequest,
    private val rawHttpRecorder: MiHealthCloudRawHttpRecorder,
    private val resultAccumulator: MiHealthCloudResultAccumulator,
    private val log: (message: String) -> Unit
) {
    private val sdk = FitSDK(context, request.appId, request.accessToken, request.dataUrl)

    fun readAll(windows: List<Pair<Long, Long>>): Int {
        var totalPoints = 0
        rawHttpRecorder.recordAllDataSources(request)
        request.dataTypeNames.forEach { dataTypeName ->
            totalPoints += readDataType(dataTypeName, windows)
        }
        return totalPoints
    }

    private fun readDataType(dataTypeName: String, windows: List<Pair<Long, Long>>): Int {
        rawHttpRecorder.recordDataSource(request, dataTypeName)
        val dataSources = getDataSources(dataTypeName)
        if (dataSources.isEmpty()) {
            log("没有找到 dataType=$dataTypeName 的数据源。")
            return 0
        }

        var totalPoints = 0
        dataSources.forEachIndexed { index, source ->
            val sourceId = source.dataStreamId
            log("[$dataTypeName] 数据源 ${index + 1}/${dataSources.size}: $sourceId")
            windows.forEachIndexed { windowIndex, window ->
                log("[$dataTypeName] 数据源 $sourceId 分片 ${windowIndex + 1}/${windows.size}: ${formatNs(window.first)} ~ ${formatNs(window.second)}")
                totalPoints += readDataSetPages(dataTypeName, sourceId, window.first, window.second)
            }
        }
        return totalPoints
    }

    private fun getDataSources(dataTypeName: String): List<DataSource> {
        return try {
            val response = MiHealthCloudCallRunner.callWithTimeout(request.requestTimeoutSeconds) {
                sdk.getDataSourceByType(dataTypeName)
            }
            log("getDataSourceByType response=${response.responseCode} success=${response.isSuccess} desc=${response.desc}")
            val responseObject = response.getObject()
            if (!response.isSuccess || responseObject == null) {
                resultAccumulator.recordSourceResult(dataTypeName, response.responseCode, response.isSuccess, response.desc, 0)
                emptyList()
            } else {
                resultAccumulator.recordSourceResult(dataTypeName, response.responseCode, response.isSuccess, response.desc, responseObject.size)
                responseObject
            }
        } catch (error: Throwable) {
            resultAccumulator.recordError("getDataSourceByType", dataTypeName, error)
            log("getDataSourceByType 失败：${error.javaClass.simpleName}: ${error.message}")
            emptyList()
        }
    }

    private fun readDataSetPages(dataTypeName: String, sourceId: String, startNs: Long, endNs: Long): Int {
        var pageToken: String? = null
        var page = 0
        var total = 0
        do {
            page += 1
            rawHttpRecorder.recordDataSet(request, dataTypeName, sourceId, startNs, endNs, request.limit, pageToken)
            val response = try {
                MiHealthCloudCallRunner.callWithTimeout(request.requestTimeoutSeconds) {
                    sdk.getDataSet(sourceId, startNs, endNs, request.limit, pageToken)
                }
            } catch (error: Throwable) {
                resultAccumulator.recordError("getDataSet page=$page source=$sourceId", dataTypeName, error)
                log("getDataSet 第 $page 页失败：${error.javaClass.simpleName}: ${error.message}")
                return total
            }

            log("getDataSet 第 $page 页 response=${response.responseCode} success=${response.isSuccess} desc=${response.desc}")
            val dataSet = response.getObject() ?: return total
            val json = dataSet.getJsonObject()
            val points = dataSet.dataPoint ?: emptyList()
            total += points.size
            points.forEach { point ->
                resultAccumulator.recordPoint(dataTypeName, sourceId, page, point)
            }
            log("第 $page 页样本数=${points.size} 累计=$total")
            points.take(3).forEach { log("样本预览：${resultAccumulator.summarizePoint(it)}") }
            points.takeLast(3).forEach { log("样本预览：${resultAccumulator.summarizePoint(it)}") }
            val nextPageToken = json.optString("nextPageToken").takeIf { it.isNotBlank() }
            resultAccumulator.recordPageResult(dataTypeName, sourceId, page, startNs, endNs, request.limit, pageToken, nextPageToken, points.size, json)
            pageToken = nextPageToken
        } while (pageToken != null && page < request.maxPages)

        if (pageToken != null) {
            log("达到 maxPages=${request.maxPages}，仍存在 nextPageToken，未继续拉取。")
        }
        log("数据源 $sourceId 拉取完成：样本数=$total")
        return total
    }

    private fun formatNs(ns: Long): String {
        return MiHealthCloudTimeFormatter.formatNs(ns)
    }
}
