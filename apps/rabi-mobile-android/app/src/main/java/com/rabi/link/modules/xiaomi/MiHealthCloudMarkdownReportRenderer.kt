package com.rabi.link.modules.xiaomi

import org.json.JSONArray

internal class MiHealthCloudMarkdownReportRenderer {
    private val statsRenderer = MiHealthCloudMarkdownStatsRenderer()

    fun render(snapshot: Snapshot): String {
        val builder = StringBuilder()
        builder.append("# 小米健康云心率列表\n\n")
        builder.append("- 数据类型：").append(snapshot.dataTypeNames.joinToString(", ")).append('\n')
        builder.append("- 状态：").append(snapshot.statusMessage).append('\n')
        builder.append("- 请求范围：").append(MiHealthCloudMarkdownFormat.formatNs(snapshot.startNs)).append(" ~ ").append(MiHealthCloudMarkdownFormat.formatNs(snapshot.endNs)).append('\n')
        builder.append("- 分片小时：").append(snapshot.reportSliceHours).append('\n')
        builder.append("- 总样本数：").append(snapshot.totalPoints).append('\n')
        builder.append("- 保存时间戳：").append(snapshot.savedAtMillis).append("\n\n")
        builder.append(buildDiagnostics(snapshot))
        builder.append('\n')
        builder.append(statsRenderer.render(snapshot))
        builder.append('\n')
        builder.append("| # | 数据类型 | 开始时间 | 结束时间 | 心率/值 | 数据源 | 页码 |\n")
        builder.append("|---:|---|---|---|---|---|---:|\n")
        for (index in 0 until snapshot.pointBuffer.length()) {
            val point = snapshot.pointBuffer.optJSONObject(index) ?: continue
            builder.append('|').append(index + 1)
                .append('|').append(MiHealthCloudMarkdownFormat.escape(point.optString("dataType", "")))
                .append('|').append(MiHealthCloudMarkdownFormat.escape(point.optString("startTime", "unknown")))
                .append('|').append(MiHealthCloudMarkdownFormat.escape(point.optString("endTime", "unknown")))
                .append('|').append(MiHealthCloudMarkdownFormat.escape(MiHealthCloudMarkdownFormat.pointValueText(point)))
                .append('|').append(MiHealthCloudMarkdownFormat.escape(point.optString("sourceId", "")))
                .append('|').append(point.optInt("page", 0))
                .append("|\n")
        }
        return builder.toString()
    }

    private fun buildDiagnostics(snapshot: Snapshot): String {
        return buildString {
            append("## 诊断\n\n")
            if (snapshot.sourceBuffer.length() == 0) {
                append("- 数据源探测：无记录\n")
            } else {
                for (index in 0 until snapshot.sourceBuffer.length()) {
                    val item = snapshot.sourceBuffer.optJSONObject(index) ?: continue
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
            if (snapshot.pageBuffer.length() > 0) {
                for (index in 0 until snapshot.pageBuffer.length()) {
                    val item = snapshot.pageBuffer.optJSONObject(index) ?: continue
                    append("- 分页 ")
                        .append(item.optString("dataType"))
                        .append(" page=").append(item.optInt("page"))
                        .append(" count=").append(item.optInt("pointCount"))
                        .append(" nextPageToken=").append(if (item.optBoolean("hasNextPageToken")) "yes" else "no")
                        .append('\n')
                }
            }
            if (snapshot.rawHttpBuffer.length() > 0) {
                for (index in 0 until snapshot.rawHttpBuffer.length()) {
                    val item = snapshot.rawHttpBuffer.optJSONObject(index) ?: continue
                    append("- 原始 HTTP ")
                        .append(item.optString("stage"))
                        .append(" ")
                        .append(item.optString("dataType"))
                        .append("：http=").append(item.optInt("httpCode"))
                        .append(" length=").append(item.optInt("responseLength"))
                        .append('\n')
                }
            }
            if (snapshot.errorBuffer.length() > 0) {
                for (index in 0 until snapshot.errorBuffer.length()) {
                    val item = snapshot.errorBuffer.optJSONObject(index) ?: continue
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

    data class Snapshot(
        val dataTypeNames: List<String>,
        val statusMessage: String,
        val startNs: Long,
        val endNs: Long,
        val reportSliceHours: Long,
        val totalPoints: Int,
        val savedAtMillis: Long,
        val pointBuffer: JSONArray,
        val sourceBuffer: JSONArray,
        val pageBuffer: JSONArray,
        val rawHttpBuffer: JSONArray,
        val errorBuffer: JSONArray
    )
}
