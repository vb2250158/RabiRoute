package com.rabi.link.modules.xiaomi

import android.content.Context
import com.xiaomi.fits.sdk.Network
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

internal class MiHealthCloudRawHttpRecorder(
    private val context: Context,
    private val rawHttpBuffer: JSONArray,
    private val recordError: (stage: String, dataTypeName: String, error: Throwable) -> Unit,
    private val log: (message: String) -> Unit
) {
    private val rawHttpFiles = MiHealthCloudRawHttpFiles(context)

    fun clearRawHttpDir() {
        rawHttpFiles.clear()
    }

    fun recordAllDataSources(request: MiHealthCloudProbeRequest) {
        try {
            val url = buildAuthUrl(request.dataUrl, "/fitness/v1/users/me/dataSources", request.appId, request.accessToken)
            val response = MiHealthCloudCallRunner.callWithTimeout(request.requestTimeoutSeconds) {
                Network.downloadXml(context, url)
            }
            val body = response.responseString.orEmpty()
            val rawFile = saveRawHttpBody("allDataSources", "all", null, body)
            rawHttpBuffer.put(
                JSONObject()
                    .put("stage", "getAllDataSources")
                    .put("dataType", "__all__")
                    .put("method", "GET")
                    .put("endpoint", "/fitness/v1/users/me/dataSources")
                    .put("queryParams", JSONArray(listOf("token=<redacted>", "clientId=<redacted>")))
                    .put("httpCode", response.responseCode)
                    .put("responseLength", body.toByteArray(Charsets.UTF_8).size)
                    .put("rawFileName", rawFile.name)
                    .put("rawFilePath", rawFile.absolutePath)
                    .put("responseJsonSummary", MiHealthCloudRawHttpSummary.summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
            log("原始 HTTP 已请求全部 dataSources：http=${response.responseCode} bytes=${body.toByteArray(Charsets.UTF_8).size}")
        } catch (error: Throwable) {
            recordError("raw getAllDataSources", "__all__", error)
        }
    }

    fun recordDataSource(request: MiHealthCloudProbeRequest, dataTypeName: String) {
        try {
            val url = buildAuthUrl(request.dataUrl, "/fitness/v1/users/me/dataSources", request.appId, request.accessToken)
                .plus("&dataTypeName=${enc(dataTypeName)}")
            val response = MiHealthCloudCallRunner.callWithTimeout(request.requestTimeoutSeconds) {
                Network.downloadXml(context, url)
            }
            val body = response.responseString.orEmpty()
            val rawFile = saveRawHttpBody("dataSources", dataTypeName, null, body)
            rawHttpBuffer.put(
                JSONObject()
                    .put("stage", "getDataSourceByType")
                    .put("dataType", dataTypeName)
                    .put("method", "GET")
                    .put("endpoint", "/fitness/v1/users/me/dataSources")
                    .put("queryParams", JSONArray(listOf("token=<redacted>", "clientId=<redacted>", "dataTypeName=$dataTypeName")))
                    .put("httpCode", response.responseCode)
                    .put("responseLength", body.toByteArray(Charsets.UTF_8).size)
                    .put("rawFileName", rawFile.name)
                    .put("rawFilePath", rawFile.absolutePath)
                    .put("responseJsonSummary", MiHealthCloudRawHttpSummary.summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
        } catch (error: Throwable) {
            recordError("raw getDataSourceByType", dataTypeName, error)
        }
    }

    fun recordDataSet(
        request: MiHealthCloudProbeRequest,
        dataTypeName: String,
        sourceId: String,
        startNs: Long,
        endNs: Long,
        limit: Int,
        pageToken: String?
    ) {
        try {
            val datasetId = "$startNs-${endNs + 1L}"
            var url = buildAuthUrl(
                request.dataUrl,
                "/fitness/v1/users/me/dataSources/${encPath(sourceId)}/datasets/$datasetId",
                request.appId,
                request.accessToken
            ).plus("&limit=$limit")
            if (!pageToken.isNullOrBlank()) {
                url = url.plus("&pageToken=${enc(pageToken)}")
            }
            val response = MiHealthCloudCallRunner.callWithTimeout(request.requestTimeoutSeconds) {
                Network.downloadXml(context, url)
            }
            val body = response.responseString.orEmpty()
            val rawFile = saveRawHttpBody("dataSet", dataTypeName, sourceId, body)
            rawHttpBuffer.put(
                JSONObject()
                    .put("stage", "getDataSet")
                    .put("dataType", dataTypeName)
                    .put("sourceId", sourceId)
                    .put("method", "GET")
                    .put("endpoint", "/fitness/v1/users/me/dataSources/{sourceId}/datasets/{startNs-endNs}")
                    .put("queryParams", JSONArray(listOf("token=<redacted>", "clientId=<redacted>", "limit=$limit", "pageToken=${if (pageToken.isNullOrBlank()) "<empty>" else "<present>"}")))
                    .put("httpCode", response.responseCode)
                    .put("responseLength", body.toByteArray(Charsets.UTF_8).size)
                    .put("rawFileName", rawFile.name)
                    .put("rawFilePath", rawFile.absolutePath)
                    .put("responseJsonSummary", MiHealthCloudRawHttpSummary.summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
        } catch (error: Throwable) {
            recordError("raw getDataSet source=$sourceId", dataTypeName, error)
        }
    }

    private fun saveRawHttpBody(stage: String, dataTypeName: String, sourceId: String?, body: String): java.io.File {
        return rawHttpFiles.save(rawHttpBuffer.length() + 1, stage, dataTypeName, sourceId, body)
    }

    private fun buildAuthUrl(dataUrl: String, path: String, appId: String, accessToken: String): String {
        val base = dataUrl.trimEnd('/') + path
        return "$base?token=${enc(accessToken)}&clientId=${enc(appId)}"
    }

    private fun enc(value: String): String {
        return URLEncoder.encode(value, "UTF-8")
    }

    private fun encPath(value: String): String {
        return enc(value).replace("+", "%20")
    }

}
