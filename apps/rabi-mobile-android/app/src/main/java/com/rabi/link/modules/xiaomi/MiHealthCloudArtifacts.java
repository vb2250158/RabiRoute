package com.rabi.link.modules.xiaomi;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import java.io.File;

public final class MiHealthCloudArtifacts {
    private MiHealthCloudArtifacts() {
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(MiHealthCloudContract.PREFS, Context.MODE_PRIVATE);
    }

    public static LastResult readLastResult(Context context) {
        SharedPreferences prefs = prefs(context);
        return new LastResult(
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_LOG, ""),
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_JSON, ""),
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_JSON_PATH, ""),
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_MARKDOWN, ""),
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_MARKDOWN_PATH, ""),
                prefs.getString(MiHealthCloudContract.KEY_LAST_PROBE_ZIP_URI, ""),
                prefs.getLong(MiHealthCloudContract.KEY_LAST_PROBE_AT, 0L)
        );
    }

    public static void saveLastZipUri(Context context, Uri uri) {
        prefs(context)
                .edit()
                .putString(MiHealthCloudContract.KEY_LAST_PROBE_ZIP_URI, uri.toString())
                .apply();
    }

    public static File rawHttpDir(Context context) {
        return new File(context.getFilesDir(), MiHealthCloudContract.RAW_HTTP_DIR);
    }

    public static boolean hasText(String text) {
        return text != null && !text.trim().isEmpty();
    }

    public static final class LastResult {
        public final String log;
        public final String json;
        public final String jsonPath;
        public final String markdown;
        public final String markdownPath;
        public final String zipUri;
        public final long savedAtMillis;

        private LastResult(
                String log,
                String json,
                String jsonPath,
                String markdown,
                String markdownPath,
                String zipUri,
                long savedAtMillis
        ) {
            this.log = log == null ? "" : log;
            this.json = json == null ? "" : json;
            this.jsonPath = jsonPath == null ? "" : jsonPath;
            this.markdown = markdown == null ? "" : markdown;
            this.markdownPath = markdownPath == null ? "" : markdownPath;
            this.zipUri = zipUri == null ? "" : zipUri;
            this.savedAtMillis = savedAtMillis;
        }

        public boolean hasLog() {
            return hasText(log);
        }

        public boolean hasJson() {
            return hasText(json);
        }

        public boolean hasMarkdown() {
            return hasText(markdown);
        }

        public boolean hasZipUri() {
            return hasText(zipUri);
        }

        public boolean hasAnyExportText() {
            return hasMarkdown() || hasJson();
        }
    }
}
