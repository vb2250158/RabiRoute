package com.rabi.link.modules.xiaomi;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.widget.Toast;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class MiHealthCloudResultActions {
    public interface LogSink {
        void append(String line);
    }

    private final Activity activity;
    private final LogSink log;
    private final MiHealthCloudJsonSummaryAppender jsonSummaryAppender;
    private final MiHealthCloudDownloadExporter downloadExporter;
    private final MiHealthCloudShareSender shareSender;

    public MiHealthCloudResultActions(Activity activity, LogSink log) {
        this.activity = activity;
        this.log = log;
        this.jsonSummaryAppender = new MiHealthCloudJsonSummaryAppender(log);
        this.downloadExporter = new MiHealthCloudDownloadExporter(activity, log);
        this.shareSender = new MiHealthCloudShareSender(activity, log);
    }

    public void showLastResult() {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        append("");
        append("最近一次小米云心率列表结果：");
        if (result.savedAtMillis > 0L) {
            append("保存时间戳：" + result.savedAtMillis);
        }
        if (MiHealthCloudArtifacts.hasText(result.jsonPath)) {
            append("JSON 文件：" + result.jsonPath);
        }
        if (result.hasJson()) {
            append("JSON 字节数：" + result.json.getBytes(StandardCharsets.UTF_8).length);
        }
        if (MiHealthCloudArtifacts.hasText(result.markdownPath)) {
            append("Markdown 文件：" + result.markdownPath);
        }
        if (result.hasMarkdown()) {
            append("Markdown 字节数：" + result.markdown.getBytes(StandardCharsets.UTF_8).length);
        }
        if (result.hasZipUri()) {
            append("自动保存 ZIP：" + result.zipUri);
        }
        jsonSummaryAppender.appendSummary(result.json);
        if (!result.hasLog()) {
            append("暂无云端拉取结果。请先完成小米云授权，再点“拉取心率列表”。");
        } else {
            append(result.log.trim());
        }
    }

    public void copyLastMarkdown() {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        if (!result.hasMarkdown()) {
            append("暂无可复制的云端 Markdown。请先拉取心率列表。");
            return;
        }
        ClipboardManager clipboard = (ClipboardManager) activity.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("小米健康云心率列表", result.markdown));
            Toast.makeText(activity, "云端心率 Markdown 已复制", Toast.LENGTH_SHORT).show();
        }
    }

    public void shareLastMarkdown() {
        shareLastText(MiHealthCloudContract.SHARE_MARKDOWN_TITLE, MiHealthCloudContract.MIME_MARKDOWN, false);
    }

    public void shareLastJson() {
        shareLastText(MiHealthCloudContract.SHARE_JSON_TITLE, MiHealthCloudContract.MIME_JSON, true);
    }

    public void shareLastZip() {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        if (!result.hasZipUri()) {
            append("暂无可分享的云端 ZIP。请先拉取心率列表或点“保存云ZIP”。");
            return;
        }
        shareSender.shareZip(Uri.parse(result.zipUri));
    }

    public void saveLastFilesToDownloads() {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        if (!result.hasAnyExportText()) {
            append("暂无可保存的云端结果。请先拉取心率列表。");
            return;
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        try {
            if (Build.VERSION.SDK_INT < 29) {
                append("当前 Android 版本不支持免权限写入下载目录，请使用“分享云MD/JSON”或“复制云MD”。");
                return;
            }
            if (result.hasMarkdown()) {
                Uri uri = downloadExporter.saveText(MiHealthCloudContract.markdownFileName(stamp), MiHealthCloudContract.MIME_MARKDOWN, result.markdown);
                append("Markdown 已保存：" + uri);
            }
            if (result.hasJson()) {
                Uri uri = downloadExporter.saveText(MiHealthCloudContract.jsonFileName(stamp), MiHealthCloudContract.MIME_JSON, result.json);
                append("JSON 已保存：" + uri);
            }
            downloadExporter.saveRawFiles(stamp);
            Toast.makeText(activity, "云端结果已保存到下载目录", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            append("保存云端文件失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    public void saveLastZipToDownloads() {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        if (!result.hasAnyExportText()) {
            append("暂无可打包的云端结果。请先拉取心率列表。");
            return;
        }
        if (Build.VERSION.SDK_INT < 29) {
            append("当前 Android 版本不支持免权限写入下载目录，请使用“分享云MD/JSON”。");
            return;
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date());
        try {
            Uri uri = MiHealthCloudZipExporter.saveToDownloads(
                    activity,
                    MiHealthCloudContract.zipFileName(stamp),
                    result.markdown,
                    result.json,
                    result.log
            );
            MiHealthCloudArtifacts.saveLastZipUri(activity, uri);
            append("云端 ZIP 已保存：" + uri);
            Toast.makeText(activity, "云端 ZIP 已保存到下载目录", Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            append("保存云端 ZIP 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void shareLastText(String title, String mimeType, boolean json) {
        MiHealthCloudArtifacts.LastResult result = MiHealthCloudArtifacts.readLastResult(activity);
        String text = json ? result.json : result.markdown;
        if (!MiHealthCloudArtifacts.hasText(text)) {
            append("暂无可分享的云端结果。请先拉取心率列表。");
            return;
        }
        shareSender.shareText(title, mimeType, text);
    }

    private void append(String line) {
        log.append(line);
    }
}
