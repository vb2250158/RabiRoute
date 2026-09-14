package com.rabi.link.modules.rokid;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;

final class RokidReportClipboard {
    void copy(Context context, String report) {
        ClipboardManager clipboard = (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) {
            clipboard.setPrimaryClip(ClipData.newPlainText("Rokid 眼镜探针日志", report));
        }
    }
}
