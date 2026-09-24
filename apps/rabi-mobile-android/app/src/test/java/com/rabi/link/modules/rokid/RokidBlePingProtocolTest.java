package com.rabi.link.modules.rokid;

import org.junit.Test;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

public class RokidBlePingProtocolTest {
    @Test public void replyPreservesNonce() {
        assertEquals("pong:ab1200ff", new String(RokidBlePingProtocol.reply("ping:ab1200ff".getBytes(StandardCharsets.US_ASCII)), StandardCharsets.US_ASCII));
    }
    @Test public void rejectsNonProtocolAndOversizedInput() {
        for (String text : new String[]{"", "ping:abc", "pong:ab1200ff", "ping:AB1200FF", "ping:ab1200ff extra", "012345678901234567890"}) {
            assertNull(RokidBlePingProtocol.reply(text.getBytes(StandardCharsets.US_ASCII)));
        }
        assertNull(RokidBlePingProtocol.reply(null));
        assertNull(RokidBlePingProtocol.reply(new byte[]{(byte) 255}));
    }
}
