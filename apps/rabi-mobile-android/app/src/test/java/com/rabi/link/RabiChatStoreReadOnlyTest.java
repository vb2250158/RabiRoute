package com.rabi.link;

import org.junit.Test;
import org.junit.Rule;
import org.junit.rules.TemporaryFolder;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import static org.junit.Assert.*;

public final class RabiChatStoreReadOnlyTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    @Test public void readingOldBlankRouteHistoryKeepsBytesAndNeverAssignsItToNewPersona() throws Exception {
        File files = folder.newFolder("files");
        File directory = new File(files, "rabi-conversation");
        assertTrue(directory.mkdir());
        File history = new File(directory, "chat.json");
        byte[] original = ("[\n {\"id\":\"original\",\"role\":\"assistant\",\"text\":\"fixture retained\","
            + "\"routeProfileId\":\"\",\"createdAt\":123},"
            + "{\"id\":\"bound\",\"role\":\"user\",\"text\":\"fixture bound\",\"routeProfileId\":\"old-persona\"}\n]")
            .getBytes(StandardCharsets.UTF_8);
        Files.write(history.toPath(), original);
        RabiChatStore store = new RabiChatStore(files);
        assertEquals(2, store.list().size());
        assertEquals("", store.list().get(0).routeProfileId);
        assertEquals(1, store.listForConversation(RabiConversationRules.LEGACY_CONVERSATION_ID).size());
        assertTrue(store.listForConversation("new-persona").isEmpty());
        assertEquals(1, store.listForConversation("old-persona").size());
        assertTrue(store.conversationIds().contains(RabiConversationRules.LEGACY_CONVERSATION_ID));
        assertFalse(store.conversationIds().contains("new-persona"));
        assertArrayEquals(original, Files.readAllBytes(history.toPath()));
        assertFalse(new File(directory, "conversation-state.json").exists());
    }
}
