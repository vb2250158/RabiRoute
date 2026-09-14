package com.rabi.link.modules.rokid;
import org.junit.Test;
import static org.junit.Assert.*;
public class ReceiverProcessIdentityTest {
    private String stat(int pid, long started) { return pid + " (receiver name) S " + "0 ".repeat(18) + started + " 0 0"; }
    @Test public void detectsPidReuseAndPreservesCommandWithSpaces() {
        ReceiverProcessIdentity first = ReceiverProcessIdentity.parse(stat(123,45));
        assertTrue(first.sameProcess(ReceiverProcessIdentity.parse(stat(123,45))));
        assertFalse(first.sameProcess(ReceiverProcessIdentity.parse(stat(123,46))));
        assertFalse(first.sameProcess(ReceiverProcessIdentity.parse(stat(124,45))));
    }
    @Test(expected=IllegalArgumentException.class) public void malformedProofCannotAuthorizeRecovery() { ReceiverProcessIdentity.parse("missing"); }
}
