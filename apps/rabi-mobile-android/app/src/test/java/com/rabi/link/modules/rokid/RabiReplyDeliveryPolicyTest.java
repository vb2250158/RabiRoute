package com.rabi.link.modules.rokid;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class RabiReplyDeliveryPolicyTest {
    @Test
    public void deliveredTextWithUnconfirmedPlaybackDoesNotRetryTheWholeReply() {
        RabiGlassPcBackend.ReplyDeliveryResult deliveredWithPlaybackFailure =
                new RabiGlassPcBackend.ReplyDeliveryResult(
                        true, true, false, RabiGlassPcBackend.SOURCE_PHONE,
                        "手机未确认播放完成");

        assertFalse(RabiGlassPcBackend.shouldRetryReplyDelivery(deliveredWithPlaybackFailure));
    }

    @Test
    public void replyWithoutDeviceDeliveryStillRetries() {
        RabiGlassPcBackend.ReplyDeliveryResult notDelivered =
                new RabiGlassPcBackend.ReplyDeliveryResult(
                        false, false, false, RabiGlassPcBackend.SOURCE_PHONE, "");

        assertTrue(RabiGlassPcBackend.shouldRetryReplyDelivery(notDelivered));
        assertTrue(RabiGlassPcBackend.shouldRetryReplyDelivery(null));
    }

    @Test
    public void thirdUndeliveredAttemptYieldsTheHeadAndSchedulesRecovery() {
        assertFalse(RabiGlassPcBackend.shouldDeferReplyDelivery(1));
        assertFalse(RabiGlassPcBackend.shouldDeferReplyDelivery(2));
        assertTrue(RabiGlassPcBackend.shouldDeferReplyDelivery(3));
        assertEquals(30_000L, RabiGlassPcBackend.deferredReplyRetryDelayMs(3));
        assertEquals(120_000L, RabiGlassPcBackend.deferredReplyRetryDelayMs(4));
        assertEquals(600_000L, RabiGlassPcBackend.deferredReplyRetryDelayMs(40));
    }

    @Test
    public void notificationsDistinguishUndeliveredReplyFromPlaybackFailure() {
        assertEquals(
                "回复暂未送达 · 连续尝试 3 次后已暂缓，网络恢复后自动重试",
                RabiGlassPcBackend.deferredReplyNotice());
        assertEquals(
                "回复已收到 · 语音播放未完成，可在会话中点按重播",
                RabiGlassPcBackend.playbackFailureNotice());
        assertFalse(RabiGlassPcBackend.deferredReplyNotice().contains("错误"));
        assertFalse(RabiGlassPcBackend.playbackFailureNotice().contains("重试整条回复"));
    }
}
