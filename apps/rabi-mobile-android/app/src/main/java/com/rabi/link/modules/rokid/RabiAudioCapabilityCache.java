package com.rabi.link.modules.rokid;

/** Event-invalidated capability snapshot, including negative answers. No time-based polling. */
final class RabiAudioCapabilityCache {
    private long revision;
    private long loadedRevision = -1;
    private boolean agent;
    private boolean transcribe;
    synchronized long revision() { return revision; }
    synchronized void invalidate() { revision++; }
    synchronized Boolean get(String policy) {
        if (loadedRevision != revision) return null;
        return "agent".equals(policy) ? agent : "transcribe".equals(policy) && transcribe;
    }
    synchronized boolean store(long requestedRevision, boolean supportsAgent, boolean supportsTranscribe) {
        if (requestedRevision != revision) return false;
        agent = supportsAgent; transcribe = supportsTranscribe; loadedRevision = revision;
        return true;
    }
}
