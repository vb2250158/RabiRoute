package com.rabi.link.modules.xiaomi

import java.util.Locale

internal class MiHealthCloudMarkdownStatsRenderer {
    fun render(snapshot: MiHealthCloudMarkdownReportRenderer.Snapshot): String {
        val counts = linkedMapOf<String, Int>()
        var firstNs = Long.MAX_VALUE
        var lastNs = Long.MIN_VALUE
        var min = Double.MAX_VALUE
        var max = -Double.MAX_VALUE
        var sum = 0.0
        var valueCount = 0
        val uniqueKeys = linkedSetOf<String>()
        for (index in 0 until snapshot.pointBuffer.length()) {
            val point = snapshot.pointBuffer.optJSONObject(index) ?: continue
            val dataType = point.optString("dataType", "<unknown>")
            counts[dataType] = (counts[dataType] ?: 0) + 1
            uniqueKeys += point.optString("uniqueKey", "${dataType}|${point.optString("sourceId")}|${point.optLong("startTimeNanos")}|${point.optLong("endTimeNanos")}|${point.optJSONArray("value")}")
            val startNs = point.optLong("startTimeNanos", -1L)
            if (startNs > 0L) {
                firstNs = minOf(firstNs, startNs)
                lastNs = maxOf(lastNs, startNs)
            }
            val value = MiHealthCloudMarkdownFormat.pointNumericValue(point)
            if (value != null) {
                min = minOf(min, value)
                max = maxOf(max, value)
                sum += value
                valueCount += 1
            }
        }

        return buildString {
            append("## 摘要\n\n")
            append("- 样本总数：").append(snapshot.pointBuffer.length()).append('\n')
            append("- 去重后样本数：").append(uniqueKeys.size).append('\n')
            append("- 疑似重复样本数：").append(snapshot.pointBuffer.length() - uniqueKeys.size).append('\n')
            if (firstNs != Long.MAX_VALUE) {
                append("- 实际时间范围：").append(MiHealthCloudMarkdownFormat.formatNs(firstNs)).append(" ~ ").append(MiHealthCloudMarkdownFormat.formatNs(lastNs)).append('\n')
            }
            counts.forEach { (dataType, count) ->
                append("- ").append(dataType).append("：").append(count).append(" 条\n")
            }
            if (valueCount > 0) {
                append("- 数值统计：count=").append(valueCount)
                    .append(" min=").append("%.1f".format(Locale.US, min))
                    .append(" max=").append("%.1f".format(Locale.US, max))
                    .append(" avg=").append("%.1f".format(Locale.US, sum / valueCount))
                    .append('\n')
            }
        }
    }
}
