package com.rabi.link.modules.xiaomi

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal class MiHealthCloudResultStore(
    private val context: Context
) {
    private val markdownRenderer = MiHealthCloudMarkdownReportRenderer()

    fun clearLog() {
        saveLog("")
    }

    fun saveLog(logText: String) {
        MiHealthCloudArtifacts.prefs(context)
            .edit()
            .putString(MiHealthCloudContract.KEY_LAST_PROBE_LOG, logText)
            .putLong(MiHealthCloudContract.KEY_LAST_PROBE_AT, System.currentTimeMillis())
            .apply()
    }

    fun saveJson(snapshot: MiHealthCloudMarkdownReportRenderer.Snapshot) {
        val root = JSONObject()
            .put("status", snapshot.statusMessage)
            .put("dataTypes", JSONArray(snapshot.dataTypeNames))
            .put("requestedStartTimeNanos", snapshot.startNs)
            .put("requestedEndTimeNanos", snapshot.endNs)
            .put("requestedStartTime", formatNs(snapshot.startNs))
            .put("requestedEndTime", formatNs(snapshot.endNs))
            .put("sliceHours", snapshot.reportSliceHours)
            .put("totalPoints", snapshot.totalPoints)
            .put("savedAtMillis", snapshot.savedAtMillis)
            .put("dataSources", snapshot.sourceBuffer)
            .put("pages", snapshot.pageBuffer)
            .put("rawHttp", snapshot.rawHttpBuffer)
            .put("errors", snapshot.errorBuffer)
            .put("points", snapshot.pointBuffer)
        val jsonText = root.toString(2)
        val file = File(context.filesDir, MiHealthCloudContract.LAST_JSON_FILE)
        file.writeText(jsonText, Charsets.UTF_8)
        MiHealthCloudArtifacts.prefs(context)
            .edit()
            .putString(MiHealthCloudContract.KEY_LAST_PROBE_JSON, jsonText)
            .putString(MiHealthCloudContract.KEY_LAST_PROBE_JSON_PATH, file.absolutePath)
            .apply()
    }

    fun saveMarkdown(snapshot: MiHealthCloudMarkdownReportRenderer.Snapshot) {
        val markdown = markdownRenderer.render(snapshot)
        val file = File(context.filesDir, MiHealthCloudContract.LAST_MARKDOWN_FILE)
        file.writeText(markdown, Charsets.UTF_8)
        MiHealthCloudArtifacts.prefs(context)
            .edit()
            .putString(MiHealthCloudContract.KEY_LAST_PROBE_MARKDOWN, markdown)
            .putString(MiHealthCloudContract.KEY_LAST_PROBE_MARKDOWN_PATH, file.absolutePath)
            .apply()
    }

    fun maybeAutoSaveZip(
        autoSaveZip: Boolean,
        logText: String,
        recordError: (stage: String, dataTypeName: String, error: Throwable) -> Unit,
        log: (message: String) -> Unit
    ) {
        if (!autoSaveZip) {
            return
        }
        if (Build.VERSION.SDK_INT < 29) {
            log("自动保存 ZIP 跳过：Android 10 以下需要存储权限。")
            return
        }
        try {
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val uri = MiHealthCloudZipExporter.saveToDownloads(
                context,
                MiHealthCloudContract.zipFileName(stamp),
                File(context.filesDir, MiHealthCloudContract.LAST_MARKDOWN_FILE).readText(Charsets.UTF_8),
                File(context.filesDir, MiHealthCloudContract.LAST_JSON_FILE).readText(Charsets.UTF_8),
                logText
            )
            MiHealthCloudArtifacts.prefs(context)
                .edit()
                .putString(MiHealthCloudContract.KEY_LAST_PROBE_ZIP_URI, uri.toString())
                .apply()
            log("云端 ZIP 已自动保存到下载目录：$uri")
        } catch (error: Throwable) {
            recordError("auto save zip", "__export__", error)
            log("自动保存 ZIP 失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun formatNs(ns: Long): String {
        if (ns <= 0L) {
            return "unknown"
        }
        return MiHealthCloudTimeFormatter.formatNs(ns)
    }
}
