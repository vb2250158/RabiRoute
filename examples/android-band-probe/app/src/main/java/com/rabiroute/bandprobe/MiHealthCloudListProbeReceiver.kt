package com.rabiroute.bandprobe

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.IBinder
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Log
import com.xiaomi.fits.sdk.FitSDK
import com.xiaomi.fits.sdk.Network
import com.xiaomi.micloud.fit.DataPoint
import com.xiaomi.micloud.fit.DataSource
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.net.URLEncoder
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class MiHealthCloudListProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val serviceIntent = Intent(context, MiHealthCloudProbeService::class.java).apply {
            putExtras(intent)
        }
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}

class MiHealthCloudProbeService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startAsForeground()
        acquireWakeLock()
        Thread {
            try {
                MiHealthCloudListProbe(applicationContext, intent ?: Intent()).run()
            } catch (error: Throwable) {
                Log.e(TAG, "小米健康云列表探针失败：${error.javaClass.simpleName}: ${error.message}", error)
            } finally {
                showFinishedNotification()
                releaseWakeLock()
                stopSelf(startId)
            }
        }.start()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    private fun startAsForeground() {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun buildNotification(): Notification {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "小米健康云拉取",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("Rabi 手环探针")
            .setContentText("正在拉取小米健康云数据")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
    }

    private fun showFinishedNotification() {
        val prefs = getSharedPreferences("mi_health_cloud", MODE_PRIVATE)
        val zipUri = prefs.getString("last_probe_zip_uri", "").orEmpty()
        val status = try {
            val json = prefs.getString("last_probe_json", "").orEmpty()
            if (json.isBlank()) {
                "拉取已结束，暂无 JSON 结果"
            } else {
                val root = JSONObject(json)
                val points = root.optJSONArray("points")?.length() ?: 0
                val sources = root.optJSONArray("dataSources")?.length() ?: 0
                val pages = root.optJSONArray("pages")?.length() ?: 0
                val raw = root.optJSONArray("rawHttp")?.length() ?: 0
                val errors = root.optJSONArray("errors")?.length() ?: 0
                "${root.optString("status", "拉取已结束")}，points=$points，sources=$sources，pages=$pages，raw=$raw，errors=$errors"
            }
        } catch (_: Throwable) {
            "拉取已结束"
        }
        val text = if (zipUri.isBlank()) {
            "$status。打开 App 查看结果。"
        } else {
            "$status。ZIP 已保存，可打开 App 分享。"
        }
        val openIntent = PendingIntent.getActivity(
            this,
            1,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("小米健康云拉取完成")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(openIntent)
            .setAutoCancel(true)
            .build()
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(FINISHED_NOTIFICATION_ID, notification)
    }

    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) {
            return
        }
        val manager = getSystemService(PowerManager::class.java) ?: return
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RabiBandProbe:MiHealthCloud").apply {
            setReferenceCounted(false)
            acquire(TimeUnit.MINUTES.toMillis(30))
        }
        Log.i(TAG, "已获取拉取期间 WakeLock，最长 30 分钟。")
    }

    private fun releaseWakeLock() {
        val lock = wakeLock ?: return
        if (lock.isHeld) {
            lock.release()
            Log.i(TAG, "已释放拉取期间 WakeLock。")
        }
        wakeLock = null
    }

    private companion object {
        const val TAG = "RabiMiHealthCloud"
        const val CHANNEL_ID = "mi_health_cloud_probe"
        const val NOTIFICATION_ID = 1002
        const val FINISHED_NOTIFICATION_ID = 1003
    }
}

private class MiHealthCloudListProbe(
    private val context: Context,
    private val intent: Intent
) {
    private val logBuffer = StringBuilder()
    private val pointBuffer = JSONArray()
    private val sourceBuffer = JSONArray()
    private val pageBuffer = JSONArray()
    private val rawHttpBuffer = JSONArray()
    private val errorBuffer = JSONArray()
    private var statusMessage = "未完成"
    private var reportSliceHours = 0L
    private var autoSaveZip = false

    fun run() {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_LAST_PROBE_LOG, "").apply()
        clearRawHttpDir()
        val appId = intent.getStringExtra("app_id") ?: prefs.getString(KEY_APP_ID, "").orEmpty()
        val accessToken = intent.getStringExtra("access_token") ?: prefs.getString(KEY_ACCESS_TOKEN, "").orEmpty()
        val dataUrl = intent.getStringExtra("data_url") ?: DEFAULT_DATA_URL
        val dataTypeNames = readDataTypeNames()
        val hours = intent.getLongExtra("hours", 24L).coerceAtLeast(1L)
        val sliceHours = intent.getLongExtra("slice_hours", 0L).coerceAtLeast(0L)
        reportSliceHours = sliceHours
        val limit = intent.getIntExtra("limit", 500).coerceIn(1, 5000)
        val maxPages = intent.getIntExtra("max_pages", 20).coerceIn(1, 200)
        val requestTimeoutSeconds = intent.getLongExtra("request_timeout_seconds", 30L).coerceIn(5L, 180L)
        autoSaveZip = intent.getBooleanExtra("auto_save_zip", false)

        log("开始小米健康云列表探针：dataTypes=${dataTypeNames.joinToString(",")} hours=$hours sliceHours=$sliceHours limit=$limit maxPages=$maxPages timeout=${requestTimeoutSeconds}s autoSaveZip=$autoSaveZip dataUrl=$dataUrl")
        if (appId.isBlank() || accessToken.isBlank()) {
            statusMessage = "缺少 app_id 或 access_token"
            log("缺少 app_id 或 access_token。该路线需要小米健康云 OAuth 授权，不能复用小米健康私有登录态。")
            log("调用示例：adb shell am broadcast -n com.rabiroute.bandprobe/.MiHealthCloudListProbeReceiver --es app_id '<appId>' --es access_token '<token>'")
            log("也可以打开 APK 内 OAuth 页面：adb shell am start -n com.rabiroute.bandprobe/.MiHealthOAuthActivity --es app_id '<appId>'")
            saveJson(dataTypeNames, 0L, 0L, 0)
            saveMarkdown(dataTypeNames, 0L, 0L, 0)
            saveLog()
            maybeAutoSaveZip()
            return
        }

        val sdk = FitSDK(context, appId, accessToken, dataUrl)
        val endNs = TimeUnit.MILLISECONDS.toNanos(System.currentTimeMillis())
        val startNs = endNs - TimeUnit.HOURS.toNanos(hours)
        val windows = buildWindows(startNs, endNs, sliceHours)
        var totalPoints = 0
        recordRawAllDataSourcesProbe(dataUrl, appId, accessToken, requestTimeoutSeconds)
        dataTypeNames.forEach { dataTypeName ->
            recordRawDataSourceProbe(dataUrl, appId, accessToken, dataTypeName, requestTimeoutSeconds)
            val dataSources = getDataSources(sdk, dataTypeName, requestTimeoutSeconds)
            if (dataSources.isEmpty()) {
                log("没有找到 dataType=$dataTypeName 的数据源。")
                return@forEach
            }
            dataSources.forEachIndexed { index, source ->
                val sourceId = source.dataStreamId
                log("[$dataTypeName] 数据源 ${index + 1}/${dataSources.size}: $sourceId")
                windows.forEachIndexed { windowIndex, window ->
                    log("[$dataTypeName] 数据源 $sourceId 分片 ${windowIndex + 1}/${windows.size}: ${formatNs(window.first)} ~ ${formatNs(window.second)}")
                    totalPoints += readDataSetPages(dataTypeName, sdk, dataUrl, appId, accessToken, sourceId, window.first, window.second, limit, maxPages, requestTimeoutSeconds)
                }
            }
        }
        statusMessage = if (totalPoints > 0) {
            "成功拉取样本"
        } else {
            "请求完成但样本数为 0"
        }
        log("小米健康云列表探针结束：总样本数=$totalPoints")
        saveJson(dataTypeNames, startNs, endNs, totalPoints)
        saveMarkdown(dataTypeNames, startNs, endNs, totalPoints)
        saveLog()
        maybeAutoSaveZip()
    }

    private fun readDataTypeNames(): List<String> {
        val raw = intent.getStringExtra("data_types")
            ?: intent.getStringExtra("data_type")
            ?: DEFAULT_HEART_RATE_DATA_TYPES
        if (raw.trim().equals("__all_sdk__", ignoreCase = true)) {
            return ALL_SDK_DATA_TYPES.split(',')
        }
        return raw.split(',', ';', '\n')
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .distinct()
            .ifEmpty { DEFAULT_HEART_RATE_DATA_TYPES.split(',') }
    }

    private fun buildWindows(startNs: Long, endNs: Long, sliceHours: Long): List<Pair<Long, Long>> {
        if (sliceHours <= 0L) {
            return listOf(startNs to endNs)
        }
        val sliceNs = TimeUnit.HOURS.toNanos(sliceHours)
        if (sliceNs <= 0L || sliceNs >= endNs - startNs) {
            return listOf(startNs to endNs)
        }
        val windows = mutableListOf<Pair<Long, Long>>()
        var current = startNs
        while (current < endNs) {
            val next = minOf(current + sliceNs, endNs)
            windows += current to next
            current = next
        }
        return windows
    }

    private fun getDataSources(sdk: FitSDK, dataTypeName: String, timeoutSeconds: Long): List<DataSource> {
        return try {
            val response = callWithTimeout(timeoutSeconds) {
                sdk.getDataSourceByType(dataTypeName)
            }
            log("getDataSourceByType response=${response.responseCode} success=${response.isSuccess} desc=${response.desc}")
            val responseObject = response.getObject()
            if (!response.isSuccess || responseObject == null) {
                recordSourceResult(dataTypeName, response.responseCode, response.isSuccess, response.desc, 0)
                emptyList()
            } else {
                recordSourceResult(dataTypeName, response.responseCode, response.isSuccess, response.desc, responseObject.size)
                responseObject
            }
        } catch (error: Throwable) {
            recordError("getDataSourceByType", dataTypeName, error)
            log("getDataSourceByType 失败：${error.javaClass.simpleName}: ${error.message}")
            emptyList()
        }
    }

    private fun readDataSetPages(
        dataTypeName: String,
        sdk: FitSDK,
        dataUrl: String,
        appId: String,
        accessToken: String,
        sourceId: String,
        startNs: Long,
        endNs: Long,
        limit: Int,
        maxPages: Int,
        timeoutSeconds: Long
    ): Int {
        var pageToken: String? = null
        var page = 0
        var total = 0
        do {
            page += 1
            recordRawDataSetProbe(dataTypeName, dataUrl, appId, accessToken, sourceId, startNs, endNs, limit, pageToken, timeoutSeconds)
            val response = try {
                callWithTimeout(timeoutSeconds) {
                    sdk.getDataSet(sourceId, startNs, endNs, limit, pageToken)
                }
            } catch (error: Throwable) {
                recordError("getDataSet page=$page source=$sourceId", dataTypeName, error)
                log("getDataSet 第 $page 页失败：${error.javaClass.simpleName}: ${error.message}")
                return total
            }

            log("getDataSet 第 $page 页 response=${response.responseCode} success=${response.isSuccess} desc=${response.desc}")
            val dataSet = response.getObject() ?: return total
            val json = dataSet.getJsonObject()
            val points = dataSet.dataPoint ?: emptyList<DataPoint>()
            total += points.size
            points.forEach { point ->
                pointBuffer.put(normalizePoint(dataTypeName, sourceId, page, point))
            }
            log("第 $page 页样本数=${points.size} 累计=$total")
            points.take(3).forEach { log("样本预览：${summarizePoint(it)}") }
            points.takeLast(3).forEach { log("样本预览：${summarizePoint(it)}") }
            val nextPageToken = json.optString("nextPageToken").takeIf { it.isNotBlank() }
            recordPageResult(dataTypeName, sourceId, page, startNs, endNs, limit, pageToken, nextPageToken, points.size, json)
            pageToken = nextPageToken
        } while (pageToken != null && page < maxPages)

        if (pageToken != null) {
            log("达到 maxPages=$maxPages，仍存在 nextPageToken，未继续拉取。")
        }
        log("数据源 $sourceId 拉取完成：样本数=$total")
        return total
    }

    private fun log(message: String) {
        Log.i(TAG, message)
        logBuffer.append(message).append('\n')
        saveLog()
    }

    private fun saveLog() {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_PROBE_LOG, logBuffer.toString())
            .putLong(KEY_LAST_PROBE_AT, System.currentTimeMillis())
            .apply()
    }

    private fun saveJson(dataTypeNames: List<String>, startNs: Long, endNs: Long, totalPoints: Int) {
        val root = JSONObject()
            .put("status", statusMessage)
            .put("dataTypes", JSONArray(dataTypeNames))
            .put("requestedStartTimeNanos", startNs)
            .put("requestedEndTimeNanos", endNs)
            .put("requestedStartTime", formatNs(startNs))
            .put("requestedEndTime", formatNs(endNs))
            .put("sliceHours", reportSliceHours)
            .put("totalPoints", totalPoints)
            .put("savedAtMillis", System.currentTimeMillis())
            .put("dataSources", sourceBuffer)
            .put("pages", pageBuffer)
            .put("rawHttp", rawHttpBuffer)
            .put("errors", errorBuffer)
            .put("points", pointBuffer)
        val jsonText = root.toString(2)
        val file = File(context.filesDir, LAST_JSON_FILE)
        file.writeText(jsonText, Charsets.UTF_8)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_PROBE_JSON, jsonText)
            .putString(KEY_LAST_PROBE_JSON_PATH, file.absolutePath)
            .apply()
        log("完整 JSON 已保存：${file.absolutePath}，points=${pointBuffer.length()}，bytes=${jsonText.toByteArray(Charsets.UTF_8).size}")
    }

    private fun saveMarkdown(dataTypeNames: List<String>, startNs: Long, endNs: Long, totalPoints: Int) {
        val builder = StringBuilder()
        builder.append("# 小米健康云心率列表\n\n")
        builder.append("- 数据类型：").append(dataTypeNames.joinToString(", ")).append('\n')
        builder.append("- 状态：").append(statusMessage).append('\n')
        builder.append("- 请求范围：").append(formatNs(startNs)).append(" ~ ").append(formatNs(endNs)).append('\n')
        builder.append("- 分片小时：").append(reportSliceHours).append('\n')
        builder.append("- 总样本数：").append(totalPoints).append('\n')
        builder.append("- 保存时间戳：").append(System.currentTimeMillis()).append("\n\n")
        builder.append(buildMarkdownDiagnostics())
        builder.append('\n')
        builder.append(buildMarkdownStats())
        builder.append('\n')
        builder.append("| # | 数据类型 | 开始时间 | 结束时间 | 心率/值 | 数据源 | 页码 |\n")
        builder.append("|---:|---|---|---|---|---|---:|\n")
        for (index in 0 until pointBuffer.length()) {
            val point = pointBuffer.optJSONObject(index) ?: continue
            builder.append('|').append(index + 1)
                .append('|').append(escapeMd(point.optString("dataType", "")))
                .append('|').append(escapeMd(point.optString("startTime", "unknown")))
                .append('|').append(escapeMd(point.optString("endTime", "unknown")))
                .append('|').append(escapeMd(pointValueText(point)))
                .append('|').append(escapeMd(point.optString("sourceId", "")))
                .append('|').append(point.optInt("page", 0))
                .append("|\n")
        }

        val markdown = builder.toString()
        val file = File(context.filesDir, LAST_MARKDOWN_FILE)
        file.writeText(markdown, Charsets.UTF_8)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_PROBE_MARKDOWN, markdown)
            .putString(KEY_LAST_PROBE_MARKDOWN_PATH, file.absolutePath)
            .apply()
        log("完整 Markdown 已保存：${file.absolutePath}，points=${pointBuffer.length()}，bytes=${markdown.toByteArray(Charsets.UTF_8).size}")
    }

    private fun maybeAutoSaveZip() {
        if (!autoSaveZip) {
            return
        }
        if (Build.VERSION.SDK_INT < 29) {
            log("自动保存 ZIP 跳过：Android 10 以下需要存储权限。")
            return
        }
        try {
            val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
            val uri = saveZipToDownloads("mi-health-cloud-$stamp.zip")
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_LAST_PROBE_ZIP_URI, uri.toString())
                .apply()
            log("云端 ZIP 已自动保存到下载目录：$uri")
        } catch (error: Throwable) {
            recordError("auto save zip", "__export__", error)
            log("自动保存 ZIP 失败：${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun saveZipToDownloads(fileName: String): Uri {
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/zip")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/RabiRouteBandProbe")
        }
        val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("MediaStore 返回空 URI")
        val stream = context.contentResolver.openOutputStream(uri)
            ?: throw IllegalStateException("无法打开输出流")
        ZipOutputStream(stream).use { zip ->
            addTextZipEntry(zip, "mi-health-heart-rate.json", File(context.filesDir, LAST_JSON_FILE).readText(Charsets.UTF_8))
            addTextZipEntry(zip, "mi-health-heart-rate.md", File(context.filesDir, LAST_MARKDOWN_FILE).readText(Charsets.UTF_8))
            addTextZipEntry(zip, "mi-health-cloud-log.txt", logBuffer.toString())
            val rawDir = File(context.filesDir, RAW_HTTP_DIR)
            rawDir.listFiles()?.filter { it.isFile }?.sortedBy { it.name }?.forEach { file ->
                addFileZipEntry(zip, "raw/${file.name}", file)
            }
        }
        return uri
    }

    private fun addTextZipEntry(zip: ZipOutputStream, name: String, text: String) {
        zip.putNextEntry(ZipEntry(name))
        zip.write(text.toByteArray(Charsets.UTF_8))
        zip.closeEntry()
    }

    private fun addFileZipEntry(zip: ZipOutputStream, name: String, file: File) {
        zip.putNextEntry(ZipEntry(name))
        FileInputStream(file).use { input ->
            input.copyTo(zip)
        }
        zip.closeEntry()
    }

    private fun buildMarkdownDiagnostics(): String {
        return buildString {
            append("## 诊断\n\n")
            if (sourceBuffer.length() == 0) {
                append("- 数据源探测：无记录\n")
            } else {
                for (index in 0 until sourceBuffer.length()) {
                    val item = sourceBuffer.optJSONObject(index) ?: continue
                    append("- 数据源 ")
                        .append(item.optString("dataType"))
                        .append("：success=").append(item.optBoolean("success"))
                        .append(" response=").append(item.optInt("responseCode"))
                        .append(" count=").append(item.optInt("sourceCount"))
                    val desc = item.optString("desc", "")
                    if (desc.isNotBlank()) {
                        append(" desc=").append(desc.replace("\n", " "))
                    }
                    append('\n')
                }
            }
            if (pageBuffer.length() > 0) {
                for (index in 0 until pageBuffer.length()) {
                    val item = pageBuffer.optJSONObject(index) ?: continue
                    append("- 分页 ")
                        .append(item.optString("dataType"))
                        .append(" page=").append(item.optInt("page"))
                        .append(" count=").append(item.optInt("pointCount"))
                        .append(" nextPageToken=").append(if (item.optBoolean("hasNextPageToken")) "yes" else "no")
                        .append('\n')
                }
            }
            if (rawHttpBuffer.length() > 0) {
                for (index in 0 until rawHttpBuffer.length()) {
                    val item = rawHttpBuffer.optJSONObject(index) ?: continue
                    append("- 原始 HTTP ")
                        .append(item.optString("stage"))
                        .append(" ")
                        .append(item.optString("dataType"))
                        .append("：http=").append(item.optInt("httpCode"))
                        .append(" length=").append(item.optInt("responseLength"))
                        .append('\n')
                }
            }
            if (errorBuffer.length() > 0) {
                for (index in 0 until errorBuffer.length()) {
                    val item = errorBuffer.optJSONObject(index) ?: continue
                    append("- 错误 ")
                        .append(item.optString("stage"))
                        .append(" ")
                        .append(item.optString("dataType"))
                        .append("：")
                        .append(item.optString("type"))
                        .append(": ")
                        .append(item.optString("message"))
                        .append('\n')
                }
            }
        }
    }

    private fun buildMarkdownStats(): String {
        val counts = linkedMapOf<String, Int>()
        var firstNs = Long.MAX_VALUE
        var lastNs = Long.MIN_VALUE
        var min = Double.MAX_VALUE
        var max = -Double.MAX_VALUE
        var sum = 0.0
        var valueCount = 0
        val uniqueKeys = linkedSetOf<String>()
        for (index in 0 until pointBuffer.length()) {
            val point = pointBuffer.optJSONObject(index) ?: continue
            val dataType = point.optString("dataType", "<unknown>")
            counts[dataType] = (counts[dataType] ?: 0) + 1
            uniqueKeys += point.optString("uniqueKey", "${dataType}|${point.optString("sourceId")}|${point.optLong("startTimeNanos")}|${point.optLong("endTimeNanos")}|${point.optJSONArray("value")}")
            val startNs = point.optLong("startTimeNanos", -1L)
            if (startNs > 0L) {
                firstNs = minOf(firstNs, startNs)
                lastNs = maxOf(lastNs, startNs)
            }
            val value = pointNumericValue(point)
            if (value != null) {
                min = minOf(min, value)
                max = maxOf(max, value)
                sum += value
                valueCount += 1
            }
        }

        return buildString {
            append("## 摘要\n\n")
            append("- 样本总数：").append(pointBuffer.length()).append('\n')
            append("- 去重后样本数：").append(uniqueKeys.size).append('\n')
            append("- 疑似重复样本数：").append(pointBuffer.length() - uniqueKeys.size).append('\n')
            if (firstNs != Long.MAX_VALUE) {
                append("- 实际时间范围：").append(formatNs(firstNs)).append(" ~ ").append(formatNs(lastNs)).append('\n')
            }
            counts.forEach { (dataType, count) ->
                append("- ").append(dataType).append("：").append(count).append(" 条\n")
            }
            if (valueCount > 0) {
                append("- 数值统计：count=").append(valueCount)
                    .append(" min=").append("%.1f".format(java.util.Locale.US, min))
                    .append(" max=").append("%.1f".format(java.util.Locale.US, max))
                    .append(" avg=").append("%.1f".format(java.util.Locale.US, sum / valueCount))
                    .append('\n')
            }
        }
    }

    private fun <T> callWithTimeout(timeoutSeconds: Long, block: () -> T): T {
        val executor = Executors.newSingleThreadExecutor()
        return try {
            val future = executor.submit(Callable { block() })
            future.get(timeoutSeconds, TimeUnit.SECONDS)
        } catch (error: TimeoutException) {
            throw RuntimeException("请求超过 ${timeoutSeconds}s 未返回", error)
        } finally {
            executor.shutdownNow()
        }
    }

    private fun summarizePoint(point: DataPoint): String {
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

    private fun pointValueText(point: JSONObject): String {
        val value = point.optJSONArray("value") ?: return ""
        if (value.length() == 1) {
            val first = value.opt(0)
            if (first is JSONObject) {
                val bpm = first.opt("fpVal") ?: first.opt("intVal") ?: first.opt("value")
                if (bpm != null) {
                    return bpm.toString()
                }
            }
        }
        return value.toString()
    }

    private fun buildPointKey(dataTypeName: String, sourceId: String, startNs: Long, endNs: Long, value: JSONArray): String {
        return listOf(dataTypeName, sourceId, startNs.toString(), endNs.toString(), value.toString()).joinToString("|")
    }

    private fun pointNumericValue(point: JSONObject): Double? {
        val value = point.optJSONArray("value") ?: return null
        if (value.length() == 0) {
            return null
        }
        val first = value.optJSONObject(0) ?: return null
        return when {
            first.has("fpVal") -> first.optDouble("fpVal")
            first.has("intVal") -> first.optInt("intVal").toDouble()
            first.has("value") -> first.optDouble("value")
            else -> null
        }
    }

    private fun escapeMd(text: String): String {
        return text.replace("|", "\\|").replace("\n", " ")
    }

    private fun recordSourceResult(dataTypeName: String, responseCode: Int, success: Boolean, desc: String?, sourceCount: Int) {
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

    private fun recordRawDataSourceProbe(
        dataUrl: String,
        appId: String,
        accessToken: String,
        dataTypeName: String,
        timeoutSeconds: Long
    ) {
        try {
            val url = buildAuthUrl(dataUrl, "/fitness/v1/users/me/dataSources", appId, accessToken)
                .plus("&dataTypeName=${enc(dataTypeName)}")
            val response = callWithTimeout(timeoutSeconds) {
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
                    .put("responseJsonSummary", summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
        } catch (error: Throwable) {
            recordError("raw getDataSourceByType", dataTypeName, error)
        }
    }

    private fun recordRawAllDataSourcesProbe(
        dataUrl: String,
        appId: String,
        accessToken: String,
        timeoutSeconds: Long
    ) {
        try {
            val url = buildAuthUrl(dataUrl, "/fitness/v1/users/me/dataSources", appId, accessToken)
            val response = callWithTimeout(timeoutSeconds) {
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
                    .put("responseJsonSummary", summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
            log("原始 HTTP 已请求全部 dataSources：http=${response.responseCode} bytes=${body.toByteArray(Charsets.UTF_8).size}")
        } catch (error: Throwable) {
            recordError("raw getAllDataSources", "__all__", error)
        }
    }

    private fun recordRawDataSetProbe(
        dataTypeName: String,
        dataUrl: String,
        appId: String,
        accessToken: String,
        sourceId: String,
        startNs: Long,
        endNs: Long,
        limit: Int,
        pageToken: String?,
        timeoutSeconds: Long
    ) {
        try {
            val datasetId = "$startNs-${endNs + 1L}"
            var url = buildAuthUrl(
                dataUrl,
                "/fitness/v1/users/me/dataSources/${encPath(sourceId)}/datasets/$datasetId",
                appId,
                accessToken
            ).plus("&limit=$limit")
            if (!pageToken.isNullOrBlank()) {
                url = url.plus("&pageToken=${enc(pageToken)}")
            }
            val response = callWithTimeout(timeoutSeconds) {
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
                    .put("responseJsonSummary", summarizeJsonBody(body))
                    .put("responsePreview", body.take(2000))
            )
        } catch (error: Throwable) {
            recordError("raw getDataSet source=$sourceId", dataTypeName, error)
        }
    }

    private fun saveRawHttpBody(stage: String, dataTypeName: String, sourceId: String?, body: String): File {
        val dir = File(context.filesDir, RAW_HTTP_DIR)
        dir.mkdirs()
        val index = rawHttpBuffer.length() + 1
        val sourcePart = sourceId?.let { "-" + safeFilePart(it).take(48) }.orEmpty()
        val file = File(dir, "%03d-%s-%s%s.json".format(index, safeFilePart(stage), safeFilePart(dataTypeName), sourcePart))
        file.writeText(body, Charsets.UTF_8)
        return file
    }

    private fun clearRawHttpDir() {
        val dir = File(context.filesDir, RAW_HTTP_DIR)
        if (!dir.exists()) {
            return
        }
        dir.listFiles()?.forEach { file ->
            if (file.isFile) {
                file.delete()
            }
        }
    }

    private fun safeFilePart(value: String): String {
        return value.replace(Regex("[^A-Za-z0-9._-]+"), "_").trim('_').ifBlank { "unknown" }
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

    private fun summarizeJsonBody(body: String): JSONObject {
        if (body.isBlank()) {
            return JSONObject().put("kind", "empty")
        }
        return try {
            val root = JSONObject(body)
            val summary = JSONObject()
                .put("kind", "object")
                .put("keys", JSONArray(root.keys().asSequence().toList()))
            val data = root.opt("data")
            if (data is JSONObject) {
                summary.put("dataKeys", JSONArray(data.keys().asSequence().toList()))
            } else if (data is JSONArray) {
                summary.put("dataLength", data.length())
            }
            summary
        } catch (error: Throwable) {
            JSONObject()
                .put("kind", "non-json")
                .put("error", "${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun recordPageResult(
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

    private fun recordError(stage: String, dataTypeName: String, error: Throwable) {
        errorBuffer.put(
            JSONObject()
                .put("stage", stage)
                .put("dataType", dataTypeName)
                .put("type", error.javaClass.simpleName)
                .put("message", error.message ?: "")
        )
    }

    private fun formatNs(ns: Long): String {
        if (ns <= 0L) {
            return "unknown"
        }
        val instant = Instant.ofEpochMilli(TimeUnit.NANOSECONDS.toMillis(ns))
        return DateTimeFormatter.ofPattern("MM-dd HH:mm:ss")
            .withZone(ZoneId.systemDefault())
            .format(instant)
    }

    private companion object {
        const val TAG = "RabiMiHealthCloud"
        const val DEFAULT_DATA_URL = "https://data.micloud.xiaomi.net"
        const val PREFS = "mi_health_cloud"
        const val KEY_APP_ID = "app_id"
        const val KEY_ACCESS_TOKEN = "access_token"
        const val KEY_LAST_PROBE_LOG = "last_probe_log"
        const val KEY_LAST_PROBE_AT = "last_probe_at"
        const val KEY_LAST_PROBE_JSON = "last_probe_json"
        const val KEY_LAST_PROBE_JSON_PATH = "last_probe_json_path"
        const val KEY_LAST_PROBE_MARKDOWN = "last_probe_markdown"
        const val KEY_LAST_PROBE_MARKDOWN_PATH = "last_probe_markdown_path"
        const val KEY_LAST_PROBE_ZIP_URI = "last_probe_zip_uri"
        const val LAST_JSON_FILE = "mi-health-heart-rate-last.json"
        const val LAST_MARKDOWN_FILE = "mi-health-heart-rate-last.md"
        const val RAW_HTTP_DIR = "mi-health-cloud-raw"
        const val DEFAULT_HEART_RATE_DATA_TYPES = "com.xiaomi.micloud.fit.heart_rate.bpm,com.xiaomi.micloud.fit.heart_rate.summary"
        const val ALL_SDK_DATA_TYPES =
            "com.xiaomi.micloud.fit.step_count.delta," +
                "com.xiaomi.micloud.fit.step_count.cumulative," +
                "com.xiaomi.micloud.fit.step_count.cadence," +
                "com.xiaomi.micloud.fit.activity.segment," +
                "com.xiaomi.micloud.fit.calories.consumed," +
                "com.xiaomi.micloud.fit.calories.expended," +
                "com.xiaomi.micloud.fit.calories.bmr," +
                "com.xiaomi.micloud.fit.power.sample," +
                "com.xiaomi.micloud.fit.activity.sample," +
                "com.xiaomi.micloud.fit.heart_rate.bpm," +
                "com.xiaomi.micloud.fit.location.sample," +
                "com.xiaomi.micloud.fit.location.track," +
                "com.xiaomi.micloud.fit.distance.delta," +
                "com.xiaomi.micloud.fit.distance.cumulative," +
                "com.xiaomi.micloud.fit.speed," +
                "com.xiaomi.micloud.fit.cycling.wheel_revolution.cumulative," +
                "com.xiaomi.micloud.fit.cycling.wheel_revolution.rpm," +
                "com.xiaomi.micloud.fit.cycling.pedaling.cumulative," +
                "com.xiaomi.micloud.fit.cycling.pedaling.cadence," +
                "com.xiaomi.micloud.fit.height," +
                "com.xiaomi.micloud.fit.weight," +
                "com.xiaomi.micloud.fit.body.fat.percentage," +
                "com.xiaomi.micloud.fit.activity.summary," +
                "com.xiaomi.micloud.fit.calories.bmr.summary," +
                "com.xiaomi.micloud.fit.distance.delta," +
                "com.xiaomi.micloud.fit.calories.consumed," +
                "com.xiaomi.micloud.fit.calories.expended," +
                "com.xiaomi.micloud.fit.heart_rate.summary," +
                "com.xiaomi.micloud.fit.location.bounding_box," +
                "com.xiaomi.micloud.fit.power.summary," +
                "com.xiaomi.micloud.fit.speed.summary," +
                "com.xiaomi.micloud.fit.body.fat.percentage.summary," +
                "com.xiaomi.micloud.fit.weight.summary"
    }
}
