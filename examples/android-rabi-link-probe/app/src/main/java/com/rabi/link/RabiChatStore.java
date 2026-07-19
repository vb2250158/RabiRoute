package com.rabi.link;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Small private, durable chat ledger used by UI, notifications and playback. */
public final class RabiChatStore {
    public static final class Message {
        public final String id, role, kind, text, fileName, contentType, routeProfileId, localPath;
        public final long createdAt;
        Message(JSONObject value) {
            id = value.optString("id"); role = value.optString("role");
            kind = value.optString("kind", "text"); text = value.optString("text");
            fileName = value.optString("fileName"); contentType = value.optString("contentType");
            routeProfileId = value.optString("routeProfileId");
            localPath = value.optString("localPath");
            createdAt = value.optLong("createdAt");
        }
    }

    private final File file;
    private final AtomicFile atomicFile;
    public RabiChatStore(Context context) {
        File directory = new File(context.getFilesDir(), "rabi-conversation");
        directory.mkdirs(); file = new File(directory, "chat.json"); atomicFile = new AtomicFile(file);
    }

    public synchronized void append(String id, String role, String kind, String text,
                                    String fileName, String contentType) {
        append(id, role, kind, text, fileName, contentType, "");
    }
    public synchronized void append(String id, String role, String kind, String text,
                                    String fileName, String contentType, String routeProfileId) {
        append(id, role, kind, text, fileName, contentType, routeProfileId, "");
    }
    public synchronized void append(String id, String role, String kind, String text,
                                    String fileName, String contentType, String routeProfileId, String localPath) {
        try {
            JSONArray values = read();
            String stableId = id == null || id.trim().isEmpty() ? UUID.randomUUID().toString() : id;
            for (int i = 0; i < values.length(); i++) if (stableId.equals(values.getJSONObject(i).optString("id"))) return;
            values.put(new JSONObject().put("id", stableId).put("role", role).put("kind", kind)
                    .put("text", text == null ? "" : text).put("fileName", fileName == null ? "" : fileName)
                    .put("contentType", contentType == null ? "" : contentType).put("createdAt", System.currentTimeMillis()));
            values.getJSONObject(values.length() - 1).put("routeProfileId", routeProfileId == null ? "" : routeProfileId);
            values.getJSONObject(values.length() - 1).put("localPath", localPath == null ? "" : localPath);
            while (values.length() > 1000) values.remove(0);
            FileOutputStream output = null;
            try {
                output = atomicFile.startWrite();
                output.write(values.toString().getBytes(StandardCharsets.UTF_8));
                atomicFile.finishWrite(output);
            } catch (Exception error) {
                if (output != null) atomicFile.failWrite(output);
                throw error;
            }
        } catch (Exception error) { throw new IllegalStateException(error); }
    }

    public synchronized List<Message> list() {
        List<Message> result = new ArrayList<>();
        try { JSONArray values = read(); for (int i = 0; i < values.length(); i++) result.add(new Message(values.getJSONObject(i))); }
        catch (Exception ignored) { }
        return result;
    }

    private JSONArray read() throws Exception {
        if (!file.exists()) return new JSONArray();
        byte[] data;
        try (FileInputStream input = atomicFile.openRead()) {
            data = new byte[(int) file.length()]; int offset = 0, read;
            while (offset < data.length && (read = input.read(data, offset, data.length - offset)) > 0) offset += read;
        }
        return new JSONArray(new String(data, StandardCharsets.UTF_8));
    }
}
