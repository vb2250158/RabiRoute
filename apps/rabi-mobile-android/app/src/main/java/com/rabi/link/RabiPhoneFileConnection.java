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

/** Consumes file requests from the phone's existing authenticated Relay event connection. */
public final class RabiPhoneFileConnection implements AutoCloseable {
    private static final String PATH = "/api/rabilink/mobile/files";
    private static final int MAX_RESPONSE = 256 * 1024;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Context context;

    public RabiPhoneFileConnection(Context context) {
        this.context = context.getApplicationContext();
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
            Runnable guard = () -> {
                if (!connected.getAsBoolean() || SystemClock.elapsedRealtime() >= deadline) {
                    throw new java.util.concurrent.CancellationException("PHONE_FILES_SESSION_CHANGED");
                }
            };
            int status = 200;
            JSONObject result;
            try {
                guard.run();
                String action = job.getString("action");
                JSONObject input = job.getJSONObject("input");
                JSONObject data;
                if ("file.settings.read".equals(action) || "file.settings.update".equals(action)) {
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
                result = new JSONObject().put("code", -1).put("errorCode", "PHONE_FILES_SESSION_CHANGED");
            } catch (Exception error) {
                status = 500;
                result = new JSONObject().put("code", -1).put("errorCode", "PHONE_FILE_IO_FAILED");
            }
            post(base, token, session, "result", new JSONObject().put("phoneId", phoneId)
                    .put("requestId", job.getString("id")).put("status", status).put("result", result));
        }
    }

    private static JSONObject post(String base, String token, String session, String operation, JSONObject body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(base + PATH + "/" + operation).openConnection();
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
    }
}
