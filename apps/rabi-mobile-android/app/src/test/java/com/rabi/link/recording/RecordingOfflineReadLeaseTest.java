package com.rabi.link.recording;

import com.rabi.link.RabiConversationService;
import java.util.Collections;
import java.util.concurrent.CompletableFuture;
import org.junit.Test;
import static org.junit.Assert.*;

public class RecordingOfflineReadLeaseTest {
    private CompletableFuture<?> barrier() throws Exception {
        java.lang.reflect.Field field=RabiConversationService.class.getDeclaredField("archiveShutdownBarrier");
        field.setAccessible(true);
        return (CompletableFuture<?>)field.get(null);
    }
    @Test(timeout=10000) public void offlineExportDelaysNextWriterUntilItsLastRead() throws Exception {
        AutoCloseable lease=RabiConversationService.pinLocalEvents(Collections.singletonList("saved-event"));
        try { assertFalse(barrier().isDone()); }
        finally { lease.close(); }
        assertTrue(barrier().isDone());
        lease.close(); // Closing twice must not strand the next owner.
        assertTrue(barrier().isDone());
    }
    @Test(timeout=10000) public void invalidIdentityCannotCreateAReadLease() throws Exception {
        CompletableFuture<?> previous=barrier();
        try {
            RabiConversationService.pinLocalEvents(Collections.singletonList("../outside"));
            fail("Invalid record identity accepted");
        } catch(IllegalArgumentException expected) { assertSame(previous,barrier()); }
    }
    @Test(timeout=10000) public void overlappingReadersReleaseOnlyTheirOwnLease() throws Exception {
        AutoCloseable first=RabiConversationService.pinLocalEvents(Collections.singletonList("first"));
        AutoCloseable second=RabiConversationService.pinLocalEvents(Collections.singletonList("second"));
        try {
            second.close(); second.close();
            assertFalse("One reader must still exclude the next writer",barrier().isDone());
        } finally { first.close(); second.close(); }
        assertTrue(barrier().isDone());
    }
}
