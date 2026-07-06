package com.rabi.link.modules.xiaomi;

public final class MiHealthCloudContract {
    public static final String PREFS = "mi_health_cloud";
    public static final String NOTIFICATION_CHANNEL_ID = "mi_health_cloud_probe";

    public static final String EXTRA_APP_ID = "app_id";
    public static final String EXTRA_ACCESS_TOKEN = "access_token";
    public static final String EXTRA_DATA_TYPES = "data_types";
    public static final String EXTRA_HOURS = "hours";
    public static final String EXTRA_SLICE_HOURS = "slice_hours";
    public static final String EXTRA_LIMIT = "limit";
    public static final String EXTRA_MAX_PAGES = "max_pages";
    public static final String EXTRA_AUTO_SAVE_ZIP = "auto_save_zip";
    public static final String EXTRA_REQUEST_TIMEOUT_SECONDS = "request_timeout_seconds";
    public static final String OAUTH_PARAM_ACCESS_TOKEN = "access_token";

    public static final String KEY_APP_ID = EXTRA_APP_ID;
    public static final String KEY_ACCESS_TOKEN = EXTRA_ACCESS_TOKEN;
    public static final String KEY_TOKEN_TYPE = "token_type";
    public static final String KEY_TOKEN_SAVED_AT = "token_saved_at";
    public static final String KEY_REDIRECT_URI = "redirect_uri";
    public static final String KEY_SCOPE = "scope";
    public static final String KEY_STATE = "state";
    public static final String KEY_DATA_TYPES = EXTRA_DATA_TYPES;
    public static final String KEY_HOURS = EXTRA_HOURS;
    public static final String KEY_SLICE_HOURS = EXTRA_SLICE_HOURS;
    public static final String KEY_LIMIT = EXTRA_LIMIT;
    public static final String KEY_MAX_PAGES = EXTRA_MAX_PAGES;
    public static final String KEY_LAST_PROBE_LOG = "last_probe_log";
    public static final String KEY_LAST_PROBE_AT = "last_probe_at";
    public static final String KEY_LAST_PROBE_JSON = "last_probe_json";
    public static final String KEY_LAST_PROBE_JSON_PATH = "last_probe_json_path";
    public static final String KEY_LAST_PROBE_MARKDOWN = "last_probe_markdown";
    public static final String KEY_LAST_PROBE_MARKDOWN_PATH = "last_probe_markdown_path";
    public static final String KEY_LAST_PROBE_ZIP_URI = "last_probe_zip_uri";

    public static final String LAST_JSON_FILE = "mi-health-heart-rate-last.json";
    public static final String LAST_MARKDOWN_FILE = "mi-health-heart-rate-last.md";
    public static final String RAW_HTTP_DIR = "mi-health-cloud-raw";
    public static final String ZIP_JSON_ENTRY = "mi-health-heart-rate.json";
    public static final String ZIP_MARKDOWN_ENTRY = "mi-health-heart-rate.md";
    public static final String ZIP_LOG_ENTRY = "mi-health-cloud-log.txt";

    public static final String MIME_MARKDOWN = "text/markdown";
    public static final String MIME_JSON = "application/json";
    public static final String MIME_ZIP = "application/zip";

    public static final String SHARE_MARKDOWN_TITLE = "小米健康云心率列表.md";
    public static final String SHARE_JSON_TITLE = "小米健康云心率列表.json";
    public static final String SHARE_ZIP_TITLE = "小米健康云心率列表.zip";
    public static final String DEFAULT_REDIRECT_URI = "rabi-link://oauth/xiaomi";
    public static final String DEFAULT_HEART_RATE_DATA_TYPES =
            "com.xiaomi.micloud.fit.heart_rate.bpm,com.xiaomi.micloud.fit.heart_rate.summary";
    public static final String ALL_SDK_DATA_TYPES_SENTINEL = "__all_sdk__";

    private MiHealthCloudContract() {
    }

    public static String markdownFileName(String stamp) {
        return "mi-health-heart-rate-" + stamp + ".md";
    }

    public static String jsonFileName(String stamp) {
        return "mi-health-heart-rate-" + stamp + ".json";
    }

    public static String zipFileName(String stamp) {
        return "mi-health-cloud-" + stamp + ".zip";
    }

    public static String rawJsonFileName(String stamp, String sourceName) {
        return "raw-" + stamp + "-" + sourceName;
    }
}
