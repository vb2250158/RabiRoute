package com.rabi.link;

import android.content.Context;
import android.content.Intent;
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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Private durable message ledger plus per-conversation read and draft state. */
public final class RabiChatStore {
    public static final String ACTION_CHANGED = "com.rabi.link.conversation.STORE_CHANGED";
    public static final String EXTRA_CONVERSATION_ID = "conversation_id";
    public static final String EXTRA_LIST_STATE_ONLY = "list_state_only";
    private static final Object LOCK = new Object();

    public static final class Message {
        public final String id, role, kind, text, fileName, contentType, routeProfileId, localPath;
        public final String clientMessageId, deliveryState, failure, playbackState, playbackFailure;
        public final long createdAt;
        Message(JSONObject value) {
            id = value.optString("id"); role = value.optString("role");
            kind = value.optString("kind", "text"); text = value.optString("text");
            fileName = value.optString("fileName"); contentType = value.optString("contentType");
            routeProfileId = value.optString("routeProfileId"); localPath = value.optString("localPath");
            clientMessageId = value.optString("clientMessageId", id);
            deliveryState = value.optString("deliveryState"); failure = value.optString("failure");
            playbackState = value.optString("playbackState"); playbackFailure = value.optString("playbackFailure");
            createdAt = value.optLong("createdAt");
        }
    }

    private final AtomicFile chatFile;
    private final AtomicFile stateFile;
    private final Context application;

    /** Rebuilt from the ledger and local conversation state for one list render. */
    public static final class Summary {
        public Message latest;
        public int unread;
        public boolean pinned;
    }

    public Map<String, Summary> summaries() {
        synchronized (LOCK) {
            try {
                JSONObject state = readState();
                Map<String, Summary> result = new LinkedHashMap<>();
                for (Message message : list()) {
                    String id = normalizedId(message.routeProfileId);
                    Summary summary = result.computeIfAbsent(id, key -> new Summary());
                    if (summary.latest == null || message.createdAt >= summary.latest.createdAt) summary.latest = message;
                    if ("assistant".equals(message.role) && message.createdAt > state.getJSONObject("readAt").optLong(id)) summary.unread++;
                }
                for (String key : new String[] { "pinned", "markedUnread" }) {
                    java.util.Iterator<String> ids = state.getJSONObject(key).keys();
                    while (ids.hasNext()) result.computeIfAbsent(ids.next(), id -> new Summary());
                }
                for (Map.Entry<String, Summary> entry : result.entrySet()) {
                    entry.getValue().pinned = state.getJSONObject("pinned").optBoolean(entry.getKey());
                    if (state.getJSONObject("markedUnread").optBoolean(entry.getKey())) entry.getValue().unread = Math.max(1, entry.getValue().unread);
                }
                return result;
            } catch (Exception error) { throw new IllegalStateException("Cannot read conversation state", error); }
        }
    }

    public void setPinned(String conversationId, boolean pinned) {
        saveFlag("pinned", conversationId, pinned);
    }

    public void markUnread(String conversationId) {
        saveFlag("markedUnread", conversationId, true);
    }

    private void saveFlag(String field, String conversationId, boolean enabled) {
        String id = clean(conversationId);
        if (id.isEmpty()) throw new IllegalArgumentException("Conversation ID is required");
        synchronized (LOCK) {
            try {
                JSONObject state = readState();
                JSONObject flags = state.getJSONObject(field);
                if (flags.optBoolean(id) == enabled) return;
                if (enabled) flags.put(id, true);
                else flags.remove(id);
                write(stateFile, state.toString());
            } catch (Exception error) { throw new IllegalStateException("Cannot save conversation state", error); }
        }
        notifyChanged(id, true);
    }

    public RabiChatStore(Context context) {
        this(context.getFilesDir(), context.getApplicationContext());
    }

    RabiChatStore(File filesDirectory) {
        this(filesDirectory, null);
    }

    private RabiChatStore(File filesDirectory, Context application) {
        this.application = application;
        File directory = new File(filesDirectory, "rabi-conversation");
        directory.mkdirs();
        chatFile = new AtomicFile(new File(directory, "chat.json"));
        stateFile = new AtomicFile(new File(directory, "conversation-state.json"));
    }

    private void notifyChanged(String conversationId, boolean listStateOnly) {
        if (application == null) return;
        application.sendBroadcast(new Intent(ACTION_CHANGED).setPackage(application.getPackageName())
                .putExtra(EXTRA_CONVERSATION_ID, conversationId)
                .putExtra(EXTRA_LIST_STATE_ONLY, listStateOnly));
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
        appendRecorded(id, role, kind, text, fileName, contentType, routeProfileId, localPath, clientMessageId, deliveryState, failure, System.currentTimeMillis());
    }

    public void appendRecorded(String id, String role, String kind, String text, String fileName, String contentType,
                               String routeProfileId, String localPath, String clientMessageId,
                               String deliveryState, String failure, long createdAt) {
        String changedConversation = normalizedId(routeProfileId);
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
                        .put("playbackState", "").put("playbackFailure", "")
                        .put("createdAt", createdAt);
                values.put(value);
                if (values.length() > 1000) changedConversation = null;
                while (values.length() > 1000) values.remove(0);
                write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
        notifyChanged(changedConversation, false);
    }

    public void updateDelivery(String clientMessageId, String deliveryState, String failure) {
        String target = clean(clientMessageId);
        if (target.isEmpty()) return;
        Set<String> affected = new LinkedHashSet<>();
        synchronized (LOCK) {
            try {
                JSONArray values = readArray(chatFile);
                for (int i = 0; i < values.length(); i++) {
                    JSONObject value = values.getJSONObject(i);
                    if (target.equals(value.optString("clientMessageId", value.optString("id")))
                            && (!safe(deliveryState).equals(value.optString("deliveryState"))
                            || !safe(failure).equals(value.optString("failure")))) {
                        value.put("deliveryState", safe(deliveryState)).put("failure", safe(failure));
                        affected.add(normalizedId(value.optString("routeProfileId")));
                    }
                }
                if (!affected.isEmpty()) write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
        if (!affected.isEmpty()) notifyChanged(affected.size() == 1 ? affected.iterator().next() : null, false);
    }

    /** Keeps local-only TTS replay feedback with the message that owns the cached audio. */
    public void updatePlayback(String messageId, String playbackState, String playbackFailure) {
        String target = clean(messageId);
        if (target.isEmpty()) return;
        String changedConversation = null;
        synchronized (LOCK) {
            try {
                JSONArray values = readArray(chatFile);
                for (int i = 0; i < values.length(); i++) {
                    JSONObject value = values.getJSONObject(i);
                    if (target.equals(value.optString("id"))) {
                        if (safe(playbackState).equals(value.optString("playbackState"))
                                && safe(playbackFailure).equals(value.optString("playbackFailure"))) return;
                        value.put("playbackState", safe(playbackState)).put("playbackFailure", safe(playbackFailure));
                        changedConversation = normalizedId(value.optString("routeProfileId"));
                        break;
                    }
                }
                if (changedConversation != null) write(chatFile, values.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
        if (changedConversation != null) notifyChanged(changedConversation, false);
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
        synchronized (LOCK) {
            try {
                if (readState().getJSONObject("markedUnread").optBoolean(clean(conversationId))) return Math.max(1, result);
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
        return result;
    }

    public void markRead(String conversationId) {
        String target = clean(conversationId);
        long latestIncomingAt = 0;
        for (Message message : listForConversation(target)) {
            if ("assistant".equals(message.role)) latestIncomingAt = Math.max(latestIncomingAt, message.createdAt);
        }
        synchronized (LOCK) {
            try {
                JSONObject state = readState();
                if (latestIncomingAt == state.getJSONObject("readAt").optLong(target)
                        && !state.getJSONObject("markedUnread").has(target)) return;
                state.optJSONObject("readAt").put(target, latestIncomingAt);
                state.getJSONObject("markedUnread").remove(target);
                write(stateFile, state.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
        notifyChanged(target, true);
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
                if (value.equals(state.getJSONObject("drafts").optString(clean(conversationId)))) return;
                if (value.isEmpty()) state.optJSONObject("drafts").remove(clean(conversationId));
                else state.optJSONObject("drafts").put(clean(conversationId), value);
                write(stateFile, state.toString());
            } catch (Exception error) { throw new IllegalStateException(error); }
        }
    }

    private JSONObject readState() throws Exception {
        JSONObject state = readObject(stateFile);
        if (state.optJSONObject("readAt") == null) state.put("readAt", new JSONObject());
        if (state.optJSONObject("drafts") == null) state.put("drafts", new JSONObject());
        if (state.optJSONObject("pinned") == null) state.put("pinned", new JSONObject());
        if (state.optJSONObject("markedUnread") == null) state.put("markedUnread", new JSONObject());
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
