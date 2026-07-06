package com.rabi.link.modules.xiaomi;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public final class MiHealthCloudProbeIntents {
    private MiHealthCloudProbeIntents() {
    }

    public static ProbeRequest heartRateList(Context context) {
        SharedPreferences prefs = MiHealthCloudArtifacts.prefs(context);
        String dataTypes = prefs.getString(MiHealthCloudContract.KEY_DATA_TYPES, MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES);
        long hours = prefs.getLong(MiHealthCloudContract.KEY_HOURS, 24L);
        long sliceHours = prefs.getLong(MiHealthCloudContract.KEY_SLICE_HOURS, 0L);
        int limit = prefs.getInt(MiHealthCloudContract.KEY_LIMIT, 500);
        int maxPages = prefs.getInt(MiHealthCloudContract.KEY_MAX_PAGES, 20);
        Intent intent = baseIntent(context)
                .putExtra(MiHealthCloudContract.EXTRA_DATA_TYPES, dataTypes)
                .putExtra(MiHealthCloudContract.EXTRA_HOURS, hours)
                .putExtra(MiHealthCloudContract.EXTRA_SLICE_HOURS, sliceHours)
                .putExtra(MiHealthCloudContract.EXTRA_LIMIT, limit)
                .putExtra(MiHealthCloudContract.EXTRA_MAX_PAGES, maxPages)
                .putExtra(MiHealthCloudContract.EXTRA_AUTO_SAVE_ZIP, true);
        return new ProbeRequest(
                intent,
                "已触发小米健康云心率列表拉取：" + dataTypes + "，最近 " + hours + " 小时，分片 " + sliceHours + " 小时，每页 " + limit + " 条，最多 " + maxPages + " 页。完成后会自动保存 ZIP 到下载目录。"
        );
    }

    public static ProbeRequest fullScan(Context context) {
        long hours = 168L;
        long sliceHours = 24L;
        int limit = 1000;
        int maxPages = 50;
        MiHealthCloudArtifacts.prefs(context).edit()
                .putString(MiHealthCloudContract.KEY_DATA_TYPES, MiHealthCloudContract.ALL_SDK_DATA_TYPES_SENTINEL)
                .putLong(MiHealthCloudContract.KEY_HOURS, hours)
                .putLong(MiHealthCloudContract.KEY_SLICE_HOURS, sliceHours)
                .putInt(MiHealthCloudContract.KEY_LIMIT, limit)
                .putInt(MiHealthCloudContract.KEY_MAX_PAGES, maxPages)
                .apply();
        Intent intent = baseIntent(context)
                .putExtra(MiHealthCloudContract.EXTRA_DATA_TYPES, MiHealthCloudContract.ALL_SDK_DATA_TYPES_SENTINEL)
                .putExtra(MiHealthCloudContract.EXTRA_HOURS, hours)
                .putExtra(MiHealthCloudContract.EXTRA_SLICE_HOURS, sliceHours)
                .putExtra(MiHealthCloudContract.EXTRA_LIMIT, limit)
                .putExtra(MiHealthCloudContract.EXTRA_MAX_PAGES, maxPages)
                .putExtra(MiHealthCloudContract.EXTRA_AUTO_SAVE_ZIP, true);
        return new ProbeRequest(
                intent,
                "已触发小米健康云全类型深扫：SDK 全部 data type，最近 168 小时，按 24 小时分片，每页 1000 条，最多 50 页。完成后会自动保存 ZIP 到下载目录。"
        );
    }

    private static Intent baseIntent(Context context) {
        return new Intent(context, MiHealthCloudProbeService.class);
    }

    public static final class ProbeRequest {
        public final Intent intent;
        public final String logMessage;

        private ProbeRequest(Intent intent, String logMessage) {
            this.intent = intent;
            this.logMessage = logMessage;
        }
    }
}
