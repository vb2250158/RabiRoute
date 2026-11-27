package com.rabi.link;

import android.content.Context;
import android.os.SystemClock;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/** Consumes requests scoped to one capability on the authenticated phone connection. */
public final class RabiPhoneFileConnection implements AutoCloseable {
    private static final int MAX_RESPONSE = 256 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Context context;
    private final com.rabi.link.location.PhoneLocationAccess location;
    private final com.rabi.link.phonecontrol.PhoneScreenAccess screen;
    private final com.rabi.link.phonecontrol.PhoneInputAccess input;
    private final ExecutorService screenWaiters;
    private final ExecutorService phoneInputs;
    private final String path;
    private final String errorPrefix;

    public RabiPhoneFileConnection(Context context) {
        this(context, "files", "PHONE_FILES");
    }

    public static RabiPhoneFileConnection location(Context context) {
        return new RabiPhoneFileConnection(context, "location", "PHONE_LOCATION");
    }

    public static RabiPhoneFileConnection screen(Context context) {
        return new RabiPhoneFileConnection(context, "screen", "PHONE_SCREEN");
    }

    private RabiPhoneFileConnection(Context context, String channel, String errorPrefix) {
        this.context = context.getApplicationContext();
        this.location = "location".equals(channel) ? new com.rabi.link.location.PhoneLocationAccess(this.context) : null;
        this.screen = "screen".equals(channel) ? new com.rabi.link.phonecontrol.PhoneScreenAccess() : null;
        this.input = screen != null && com.rabi.link.phonecontrol.PhoneInputAccess.supported(this.context)
                ? new com.rabi.link.phonecontrol.PhoneInputAccess(this.context) : null;
        this.screenWaiters = screen == null ? null : Executors.newFixedThreadPool(2);
        this.phoneInputs = input == null ? null : Executors.newFixedThreadPool(2);
        this.path = "/api/rabilink/mobile/" + channel;
        this.errorPrefix = errorPrefix;
    }

    public static String newSession() {
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return String.format(java.util.Locale.ROOT, "%064x", new BigInteger(1, bytes));
    }

    public void available(String base, String token, String phoneId, String session, BooleanSupplier connected) {
        if (worker.isShutdown()) return;
        try {
            worker.execute(() -> {
                if (!connected.getAsBoolean()) return;
                try {
                    drain(base, token, phoneId, session, connected);
                } catch (Exception ignored) {
                    // The original caller receives the Relay deadline outcome. Never repeat a mutation here.
                }
            });
        } catch (java.util.concurrent.RejectedExecutionException ignored) {
            // Service closed during event dispatch.
        }
    }

    private void drain(String base, String token, String phoneId, String session, BooleanSupplier connected) throws Exception {
        JSONObject identity = new JSONObject().put("phoneId", phoneId);
        while (connected.getAsBoolean()) {
            JSONObject job = post(base, token, session, "claim", identity).optJSONObject("data");
            if (job == null) return;
            long deadline = SystemClock.elapsedRealtime() + job.optLong("remainingMs");
            String action = job.getString("action");
            ExecutorService executor = "screen.wait".equals(action) ? screenWaiters
                    : ("input.perform".equals(action) || "apps.open".equals(action)) ? phoneInputs : null;
            if (executor != null) {
                // Long work leaves the claim worker free to serve stop and status.
                executor.execute(() -> {
                    try { complete(base, token, phoneId, session, connected, job, deadline); }
                    catch (Exception ignored) { /* The original receipt owns expiry and recovery. */ }
                });
            } else {
                complete(base, token, phoneId, session, connected, job, deadline);
            }
        }
    }

    private void complete(String base, String token, String phoneId, String session, BooleanSupplier connected,
                          JSONObject job, long deadline) throws Exception {
        Runnable guard = () -> {
            if (!connected.getAsBoolean() || SystemClock.elapsedRealtime() >= deadline) {
                throw new java.util.concurrent.CancellationException(errorPrefix + "_SESSION_CHANGED");
            }
        };
        int status = 200;
        JSONObject result;
        try {
            guard.run();
            String action = job.getString("action");
            JSONObject input = job.getJSONObject("input");
            JSONObject data;
            if (location != null) {
                data = location.execute(action, input, guard);
            } else if (screen != null) {
                if (action.startsWith("input.") || action.startsWith("apps.")) {
                    if (this.input == null) throw new RabiPhoneFiles.Failure(503, "PHONE_INPUT_UNAVAILABLE");
                    data = this.input.execute(action, input, guard, phoneId);
                } else {
                    data = screen.execute(action, input, guard, phoneId);
                }
            } else if ("file.settings.read".equals(action) || "file.settings.update".equals(action)) {
                if ("file.settings.update".equals(action)) {
                    Object enabled = input.opt("enabled");
                    if (!(enabled instanceof Boolean)) throw new RabiPhoneFiles.Failure(400, "PHONE_FILES_REQUEST_INVALID");
                    RabiPhoneFiles.setEnabled(context, new RabiLinkRelayConfig(base, token, true), (Boolean) enabled);
                }
                data = RabiPhoneFiles.status(context, base, token);
            } else {
                Runnable access = () -> {
                    guard.run();
                    RabiPhoneFiles.requireAccess(context, base, token);
                };
                access.run();
                data = RabiPhoneFiles.open(context, base, token).execute(action, input, access);
            }
            result = new JSONObject().put("code", 0).put("data", data);
        } catch (RabiPhoneFiles.Failure error) {
            status = error.getStatus();
            result = new JSONObject().put("code", -1).put("errorCode", error.getCode());
        } catch (java.util.concurrent.CancellationException error) {
            status = 409;
            result = new JSONObject().put("code", -1).put("errorCode", errorPrefix + "_SESSION_CHANGED");
        } catch (IllegalArgumentException error) {
            boolean files = location == null && screen == null;
            status = files ? 500 : 400;
            result = new JSONObject().put("code", -1).put("errorCode", files ? "PHONE_FILE_IO_FAILED" : errorPrefix + "_REQUEST_INVALID");
        } catch (Exception error) {
            status = 500;
            result = new JSONObject().put("code", -1).put("errorCode", location == null && screen == null ? "PHONE_FILE_IO_FAILED" : errorPrefix + "_READ_FAILED");
        }
        post(base, token, session, "result", new JSONObject().put("phoneId", phoneId)
                .put("requestId", job.getString("id")).put("status", status).put("result", result));
    }

    private JSONObject post(String base, String token, String session, String operation, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path + "/" + operation).openConnection();
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("content-type", "application/json");
            connection.setRequestProperty("x-rabilink-token", token);
            connection.setRequestProperty("x-rabilink-phone-session", session);
            connection.setConnectTimeout(5_000);
            connection.setReadTimeout(10_000);
            connection.setDoOutput(true);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
            if (connection.getResponseCode() != 200) throw new IOException("Phone file transport unavailable");
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int count; (count = input.read(buffer)) != -1;) {
                    if (bytes.size() + count > MAX_RESPONSE) throw new IOException("Phone file response too large");
                    bytes.write(buffer, 0, count);
                }
                return new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    @Override
    public void close() {
        worker.shutdownNow();
        if (screenWaiters != null) screenWaiters.shutdownNow();
        if (phoneInputs != null) phoneInputs.shutdownNow();
    }
}
