package com.rabi.link;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.util.Map;
import static org.junit.Assert.*;

public final class RabiChatStoreConversationStateTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void pinAndUnpinSurviveReloadWithoutChangingOtherConversationsOrDrafts() throws Exception {
        File files = folder.newFolder();
        RabiChatStore store = new RabiChatStore(files);
        store.saveDraft("a", "unfinished");
        store.setPinned("a", true);
        store.setPinned("b", true);
        store = new RabiChatStore(files);
        assertTrue(store.summaries().get("a").pinned);
        assertTrue(store.summaries().get("b").pinned);
        store.setPinned("a", false);
        store = new RabiChatStore(files);
        assertFalse(store.summaries().containsKey("a"));
        assertTrue(store.summaries().get("b").pinned);
        assertEquals("unfinished", store.draft("a"));
        assertTrue(store.list().isEmpty());
    }

    @Test public void localUnreadMarkerSurvivesReloadAndOpeningOnlyClearsThatConversation() throws Exception {
        File files = folder.newFolder();
        RabiChatStore store = new RabiChatStore(files);
        store.appendRecorded("m1", "assistant", "text", "hello", "", "", "a", "", "m1", "received", "", 100);
        store.appendRecorded("m2", "assistant", "text", "other", "", "", "b", "", "m2", "received", "", 200);
        store.markRead("a");
        store.markUnread("a");
        store = new RabiChatStore(files);
        assertEquals(1, store.unreadCount("a"));
        assertEquals(1, store.summaries().get("a").unread);
        store.markRead("a");
        store = new RabiChatStore(files);
        assertEquals(0, store.summaries().get("a").unread);
        assertEquals(1, store.summaries().get("b").unread);
        store.markUnread("empty");
        assertEquals(1, new RabiChatStore(files).unreadCount("empty"));
        store.markRead("empty");
        assertEquals(0, new RabiChatStore(files).unreadCount("empty"));
    }

    @Test public void summariesUseLatestTimestampAndCountIncomingOnly() throws Exception {
        RabiChatStore store = new RabiChatStore(folder.newFolder());
        store.appendRecorded("new", "assistant", "text", "latest", "", "", "a", "", "new", "received", "", 300);
        store.appendRecorded("late", "assistant", "text", "late arrival", "", "", "a", "", "late", "received", "", 100);
        store.appendRecorded("out", "user", "text", "mine", "", "", "b", "", "out", "sent", "", 400);
        Map<String, RabiChatStore.Summary> summaries = store.summaries();
        assertEquals("new", summaries.get("a").latest.id);
        assertEquals(2, summaries.get("a").unread);
        assertEquals(0, summaries.get("b").unread);
    }
}
