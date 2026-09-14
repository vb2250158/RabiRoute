package com.rabi.link.recording;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Local user bookmarks; marking never sends media or invokes an Agent. */
public final class RecordingMarkerStore {
    private RecordingMarkerStore() { }
    public static void add(Context context, String recordId, long at) throws Exception {
        File root = new File(context.getFilesDir(), "rabi-record-markers");
        if (!root.isDirectory() && !root.mkdirs()) throw new IllegalStateException("Marker directory unavailable");
        String id = UUID.randomUUID().toString();
        JSONObject data = new JSONObject().put("id", id).put("recordId", recordId == null ? "" : recordId)
                .put("at", at).put("kind", "bookmark");
        AtomicFile target = new AtomicFile(new File(root, id + ".json"));
        FileOutputStream stream = target.startWrite();
        try { stream.write(data.toString().getBytes(StandardCharsets.UTF_8)); target.finishWrite(stream); }
        catch (Exception error) { target.failWrite(stream); throw error; }
    }
}
