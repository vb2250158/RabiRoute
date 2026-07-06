package com.rabi.link.modules.xiaomi;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

final class MiHealthCloudShareSender {
    private final Activity activity;
    private final MiHealthCloudResultActions.LogSink log;

    MiHealthCloudShareSender(Activity activity, MiHealthCloudResultActions.LogSink log) {
        this.activity = activity;
        this.log = log;
    }

    void shareText(String title, String mimeType, String text) {
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(mimeType);
            send.putExtra(Intent.EXTRA_TITLE, title);
            send.putExtra(Intent.EXTRA_SUBJECT, title);
            send.putExtra(Intent.EXTRA_TEXT, text);
            activity.startActivity(Intent.createChooser(send, "分享" + title));
        } catch (Exception error) {
            append("分享云端结果失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    void shareZip(Uri zipUri) {
        try {
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(MiHealthCloudContract.MIME_ZIP);
            send.putExtra(Intent.EXTRA_TITLE, MiHealthCloudContract.SHARE_ZIP_TITLE);
            send.putExtra(Intent.EXTRA_SUBJECT, MiHealthCloudContract.SHARE_ZIP_TITLE);
            send.putExtra(Intent.EXTRA_STREAM, zipUri);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(Intent.createChooser(send, "分享小米健康云 ZIP"));
        } catch (Exception error) {
            append("分享云端 ZIP 失败：" + error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void append(String line) {
        log.append(line);
    }
}
