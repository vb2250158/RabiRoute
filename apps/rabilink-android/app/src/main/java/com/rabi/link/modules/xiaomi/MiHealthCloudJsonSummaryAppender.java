package com.rabi.link.modules.xiaomi;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class MiHealthCloudJsonSummaryAppender {
    private final MiHealthCloudResultActions.LogSink log;

    MiHealthCloudJsonSummaryAppender(MiHealthCloudResultActions.LogSink log) {
        this.log = log;
    }

    void appendSummary(String jsonText) {
        if (jsonText == null || jsonText.trim().isEmpty()) {
            return;
        }
        try {
            JSONObject root = new JSONObject(jsonText);
            JSONArray points = root.optJSONArray("points");
            if (points == null) {
                append("云端 JSON 摘要：没有 points 数组。");
                return;
            }
            append("云端状态：" + root.optString("status", "<未知>"));
            JSONArray dataSources = root.optJSONArray("dataSources");
            JSONArray pages = root.optJSONArray("pages");
            JSONArray rawHttp = root.optJSONArray("rawHttp");
            JSONArray errors = root.optJSONArray("errors");
            append("云端诊断汇总：dataSources=" + lengthOf(dataSources)
                    + " pages=" + lengthOf(pages)
                    + " rawHttp=" + lengthOf(rawHttp)
                    + " errors=" + lengthOf(errors));
            appendDataSourceDiagnostics(dataSources);
            appendPageDiagnostics(pages);
            appendRawHttpDiagnostics(rawHttp);
            appendErrors(errors);

            Map<String, Integer> counts = new HashMap<>();
            long firstNs = Long.MAX_VALUE;
            long lastNs = Long.MIN_VALUE;
            double min = Double.MAX_VALUE;
            double max = -Double.MAX_VALUE;
            double sum = 0.0;
            int valueCount = 0;
            Set<String> uniqueKeys = new HashSet<>();

            for (int i = 0; i < points.length(); i++) {
                JSONObject point = points.optJSONObject(i);
                if (point == null) {
                    continue;
                }
                String dataType = point.optString("dataType", "<unknown>");
                counts.put(dataType, counts.containsKey(dataType) ? counts.get(dataType) + 1 : 1);
                uniqueKeys.add(point.optString("uniqueKey", dataType + "|" + point.optString("sourceId") + "|" + point.optLong("startTimeNanos") + "|" + point.optLong("endTimeNanos") + "|" + point.optJSONArray("value")));
                long startNs = point.optLong("startTimeNanos", -1L);
                if (startNs > 0L) {
                    firstNs = Math.min(firstNs, startNs);
                    lastNs = Math.max(lastNs, startNs);
                }
                Double value = extractNumericValue(point.optJSONArray("value"));
                if (value != null) {
                    min = Math.min(min, value);
                    max = Math.max(max, value);
                    sum += value;
                    valueCount += 1;
                }
            }

            append("云端 JSON 摘要：points=" + points.length());
            append("去重后样本数：" + uniqueKeys.size() + "，疑似重复：" + (points.length() - uniqueKeys.size()));
            if (firstNs != Long.MAX_VALUE) {
                append("时间范围：" + formatNanos(firstNs) + " ~ " + formatNanos(lastNs));
            }
            for (Map.Entry<String, Integer> entry : counts.entrySet()) {
                append("类型计数：" + entry.getKey() + " = " + entry.getValue());
            }
            if (valueCount > 0) {
                append(String.format(Locale.US, "数值统计：count=%d min=%.1f max=%.1f avg=%.1f", valueCount, min, max, sum / valueCount));
            }
        } catch (Exception error) {
            append("云端 JSON 摘要解析失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void appendDataSourceDiagnostics(JSONArray dataSources) {
        if (dataSources == null || dataSources.length() == 0) {
            append("数据源诊断：无记录");
            return;
        }
        for (int i = 0; i < dataSources.length(); i++) {
            JSONObject item = dataSources.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("数据源诊断：" + item.optString("dataType", "<unknown>")
                    + " success=" + item.optBoolean("success")
                    + " response=" + item.optInt("responseCode")
                    + " count=" + item.optInt("sourceCount")
                    + " desc=" + item.optString("desc", ""));
        }
    }

    private void appendErrors(JSONArray errors) {
        if (errors == null || errors.length() == 0) {
            return;
        }
        for (int i = 0; i < errors.length(); i++) {
            JSONObject item = errors.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("云端错误：" + item.optString("stage")
                    + " " + item.optString("dataType")
                    + " " + item.optString("type")
                    + ": " + item.optString("message"));
        }
    }

    private void appendPageDiagnostics(JSONArray pages) {
        if (pages == null || pages.length() == 0) {
            return;
        }
        for (int i = 0; i < pages.length(); i++) {
            JSONObject item = pages.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("分页诊断：" + item.optString("dataType", "<unknown>")
                    + " page=" + item.optInt("page")
                    + " count=" + item.optInt("pointCount")
                    + " next=" + item.optBoolean("hasNextPageToken"));
        }
    }

    private void appendRawHttpDiagnostics(JSONArray rawHttp) {
        if (rawHttp == null || rawHttp.length() == 0) {
            return;
        }
        for (int i = 0; i < rawHttp.length(); i++) {
            JSONObject item = rawHttp.optJSONObject(i);
            if (item == null) {
                continue;
            }
            append("原始HTTP：" + item.optString("stage")
                    + " " + item.optString("dataType")
                    + " http=" + item.optInt("httpCode")
                    + " bytes=" + item.optInt("responseLength"));
        }
    }

    private Double extractNumericValue(JSONArray valueArray) {
        if (valueArray == null || valueArray.length() == 0) {
            return null;
        }
        JSONObject first = valueArray.optJSONObject(0);
        if (first == null) {
            return null;
        }
        if (first.has("fpVal")) {
            return first.optDouble("fpVal");
        }
        if (first.has("intVal")) {
            return (double) first.optInt("intVal");
        }
        if (first.has("value")) {
            return first.optDouble("value");
        }
        return null;
    }

    private int lengthOf(JSONArray array) {
        return array == null ? 0 : array.length();
    }

    private String formatNanos(long nanos) {
        long millis = nanos / 1000000L;
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date(millis));
    }

    private void append(String line) {
        log.append(line);
    }
}
