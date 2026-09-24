package com.rabi.link.modules.rokid;

import com.rabi.link.protocol.RabiGlassTextProtocol;
import org.json.JSONObject;
import org.junit.Test;
import static org.junit.Assert.*;

public class RabiGlassTextProtocolTest {
    private static final String ATTEMPT = "01234567-89ab-cdef-0123-456789abcdef";
    @Test public void preservesTextAndRejectsOversizeInsteadOfTruncating() throws Exception {
        JSONObject parsed = new JSONObject(RabiGlassTextProtocol.message("delivery-1", ATTEMPT, "你好\n第二行").substring(RabiGlassTextProtocol.PREFIX.length()));
        assertEquals("你好\n第二行", parsed.getString("text"));
        parsed.put("text", new String(new char[8001]).replace('\0', 'a'));
        assertFalse(RabiGlassTextProtocol.valid(parsed));
    }
    @Test public void receiptMustMatchBothMessageAndCurrentAttempt() throws Exception {
        String raw = RabiGlassTextProtocol.RECEIPT_PREFIX + new JSONObject().put("messageId", "delivery-1").put("attempt", ATTEMPT).put("state", "displayed");
        assertTrue(RabiGlassTextProtocol.matchesReceipt(raw, "delivery-1", ATTEMPT));
        assertFalse(RabiGlassTextProtocol.matchesReceipt(raw, "delivery-2", ATTEMPT));
        assertFalse(RabiGlassTextProtocol.matchesReceipt(raw, "delivery-1", "new-attempt"));
        assertFalse(RabiGlassTextProtocol.matchesReceipt(raw.replace("displayed", "accepted"), "delivery-1", ATTEMPT));
    }
}
