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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

/** Private durable message ledger plus per-conversation read and draft state. */
public final class RabiChatStore {
    private static final Object LOCK = new Object();

    public static final class Message {
        public final String id, role, kind, text, fileName, contentType, routeProfileId, localPath;
        public final String clientMessageId, deliveryState, failure;
        public final long createdAt;
        Message(JSONObject value) {
            id = value.optString("id"); role = value.optString("role");
            kind = value.optString("kind", "text"); text = value.optString("text");
            fileName = value.optString("fileName"); contentType = value.optString("contentType");
            routeProfileId = value.optString("routeProfileId"); localPath = value.optString("localPath");
            clientMessageId = value.optString("clientMessageId", id);
            deliveryState = value.optString("deliveryState"); failure = value.optString("failure");
            createdAt = value.optLong("createdAt");
        }
    }

    private final AtomicFile chatFile;
    private final AtomicFile stateFile;

    public RabiChatStore(Context context) {
        File directory = new File(context.getFilesDir(), "rabi-conversation");
        directory.mkdirs();
        chatFile = new AtomicFile(new File(directory, "chat.json"));
        stateFile = new AtomicFile(new File(directory, "conversation-state.json"));
    }

    public void append(String id, String role, String kind, String text, String fileName, String contentType) {
        append(id, role, kind, text, fileName, contentType, "");
    }

    public void append(String id, String role, String kind, String text, String fileName, String contentType, String routeProfileId) {
        append(id, role, kind, text, fileName, contentType, routeProfileId, "");
    }

    public void append(String id, String role, String kind, String text, String fileName, String contentType,
                       String routeProfileId, String localPath) {
        append(id, role, kind, text, fileName, contentType, routeProfileId, localPath,
                id, "user".equals(role) ? "sent" : "received", "");
    }

    public void append(String id, String role, String kind, String text, String fileName, String contentType,
                       String routeProfileId, String localPath, String clientMessageId,
                       String deliveryState, String failure) {
        synchronized (LOCK) {
            try {
                JSONArray values = readArray(chatFile);
                String stableId = clean(id).isEmpty() ? UUID.randomUUID().toString() : clean(id);
                for (int i = 0; i < values.length(); i++) {
                    if (stableId.equals(values.getJSONObject(i).optString("id"))) return;
                }
                JSONObject value = new JSONObject()
                        .put("id", stableId).put("role", clean(role)).put("kind", clean(kind).isEmpty() ? "text" : clean(kind))
                        .put("text", safe(text)).put("fileName", safe(fileName)).put("contentType", safe(contentType))
                        .put("routeProfileId", safe(routeProfileId)).put("localPath", safe(localPath))
                        .put("clientMessageId", clean(clientMessageId).isEmpty() ? stableId : clean(clientMessageId))
                        .put("deliveryState", safe(deliveryState)).put("failure", safe(failure))
                        .put("createdAt", System.currentTimeMillis());
                values.put(value);
                while (values.length() > 1000) values.remove(0);
                write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    public void updateDelivery(String clientMessageId, String deliveryState, String failure) {
        String target = clean(clientMessageId);
        if (target.isEmpty()) return;
        synchronized (LOCK) {
            try {
                JSONArray values = readArray(chatFile);
                boolean changed = false;
                for (int i = 0; i < values.length(); i++) {
                    JSONObject value = values.getJSONObject(i);
                    if (target.equals(value.optString("clientMessageId", value.optString("id")))) {
                        value.put("deliveryState", safe(deliveryState)).put("failure", safe(failure));
                        changed = true;
                    }
                }
                if (changed) write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    public List<Message> list() {
        synchronized (LOCK) {
            List<Message> result = new ArrayList<>();
            try {
                JSONArray values = readArray(chatFile);
                for (int i = 0; i < values.length(); i++) result.add(new Message(values.getJSONObject(i)));
            } catch (Exception ignored) { }
            return result;
        }
    }

    public List<Message> listForConversation(String conversationId) {
        String target = clean(conversationId);
        List<Message> result = new ArrayList<>();
        for (Message message : list()) if (target.equals(normalizedId(message.routeProfileId))) result.add(message);
        return result;
    }

    public Set<String> conversationIds() {
        Set<String> result = new LinkedHashSet<>();
        for (Message message : list()) result.add(normalizedId(message.routeProfileId));
        return result;
    }

    public Message latest(String conversationId) {
        List<Message> messages = listForConversation(conversationId);
        return messages.isEmpty() ? null : messages.get(messages.size() - 1);
    }

    public int unreadCount(String conversationId) {
        long readAt = readAt(conversationId);
        int result = 0;
        for (Message message : listForConversation(conversationId)) {
            if ("assistant".equals(message.role) && message.createdAt > readAt) result++;
        }
        return result;
    }

    public void markRead(String conversationId) {
        String target = clean(conversationId);
        long latestIncomingAt = 0;
        for (Message message : listForConversation(target)) {
            if ("assistant".equals(message.role)) latestIncomingAt = Math.max(latestIncomingAt, message.createdAt);
        }
        if (latestIncomingAt <= 0) return;
        synchronized (LOCK) {
            try {
                JSONObject state = readState();
                state.optJSONObject("readAt").put(target, latestIncomingAt);
                write(stateFile, state.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    public long readAt(String conversationId) {
        synchronized (LOCK) {
            try { return readState().optJSONObject("readAt").optLong(clean(conversationId)); }
            catch (Exception ignored) { return 0; }
        }
    }

    public String draft(String conversationId) {
        synchronized (LOCK) {
            try { return readState().optJSONObject("drafts").optString(clean(conversationId)); }
            catch (Exception ignored) { return ""; }
        }
    }

    public void saveDraft(String conversationId, String draft) {
        synchronized (LOCK) {
            try {
                JSONObject state = readState();
                String value = safe(draft);
                if (value.length() > 4000) value = value.substring(0, 4000);
                if (value.isEmpty()) state.optJSONObject("drafts").remove(clean(conversationId));
                else state.optJSONObject("drafts").put(clean(conversationId), value);
                write(stateFile, state.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    /** One-time migration: blank-route history goes to one deterministic conversation, never every conversation. */
    public void migrateLegacyMessages(String fallbackConversationId) {
        String target = clean(fallbackConversationId);
        if (target.isEmpty()) target = RabiConversationRules.LEGACY_CONVERSATION_ID;
        synchronized (LOCK) {
            try {
                JSONArray values = readArray(chatFile);
                boolean changed = false;
                for (int i = 0; i < values.length(); i++) {
                    JSONObject value = values.getJSONObject(i);
                    if (clean(value.optString("routeProfileId")).isEmpty()) {
                        value.put("routeProfileId", target);
                        changed = true;
                    }
                }
                if (changed) write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    private JSONObject readState() throws Exception {
        JSONObject state = readObject(stateFile);
        if (state.optJSONObject("readAt") == null) state.put("readAt", new JSONObject());
        if (state.optJSONObject("drafts") == null) state.put("drafts", new JSONObject());
        return state;
    }

    private static String normalizedId(String routeProfileId) {
        String value = clean(routeProfileId);
        return value.isEmpty() ? RabiConversationRules.LEGACY_CONVERSATION_ID : value;
    }

    private static JSONArray readArray(AtomicFile file) throws Exception {
        if (!file.getBaseFile().exists()) return new JSONArray();
        return new JSONArray(readText(file));
    }

    private static JSONObject readObject(AtomicFile file) throws Exception {
        if (!file.getBaseFile().exists()) return new JSONObject();
        String value = readText(file);
        return value.trim().isEmpty() ? new JSONObject() : new JSONObject(value);
    }

    private static String readText(AtomicFile file) throws Exception {
        try (FileInputStream input = file.openRead(); ByteArrayOutputStreamCompat output = new ByteArrayOutputStreamCompat()) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void write(AtomicFile file, String value) throws Exception {
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(value.getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw error;
        }
    }

    private static String safe(String value) { return value == null ? "" : value; }
    private static String clean(String value) { return safe(value).trim(); }

    /** Avoids another public dependency while still reading AtomicFile safely. */
    private static final class ByteArrayOutputStreamCompat extends java.io.ByteArrayOutputStream { }
}
