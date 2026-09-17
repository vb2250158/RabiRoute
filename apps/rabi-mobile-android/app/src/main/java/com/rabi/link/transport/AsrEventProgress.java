package com.rabi.link.transport;

import java.util.concurrent.ConcurrentHashMap;

/** Transient processing ownership. Queue metadata and durable receipts remain the source of pending/completed states. */
public final class AsrEventProgress {
    private static final ConcurrentHashMap<String, String> states = new ConcurrentHashMap<>();
    private AsrEventProgress() { }
    public static String get(String id) { return states.getOrDefault(id, "pending"); }
    public static void processing(String id) { states.put(id, "processing"); }
    public static void retry(String id) { states.put(id, "retry"); }
    public static void complete(String id) { states.remove(id); }
}
