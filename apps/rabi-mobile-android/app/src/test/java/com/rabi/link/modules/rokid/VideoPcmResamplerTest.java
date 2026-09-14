package com.rabi.link.modules.rokid;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

public class VideoPcmResamplerTest {
    private byte[] render(int frames, int chunk) throws Exception {
        VideoPcmResampler resampler = new VideoPcmResampler(48000, 2, false);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (int start = 0; start < frames; start += chunk) {
            int count = Math.min(chunk, frames - start);
            ByteBuffer buffer = ByteBuffer.allocate(count * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (int n = 0; n < count; n++) { buffer.putShort((short) 12000); buffer.putShort((short) 4000); }
            buffer.flip(); resampler.accept(buffer, out);
        }
        resampler.finish(out); return out.toByteArray();
    }
    @Test public void downmixAndResampleOneSecond() throws Exception {
        byte[] result = render(48000, 1024);
        assertEquals(32000, result.length);
        ByteBuffer pcm = ByteBuffer.wrap(result).order(ByteOrder.LITTLE_ENDIAN);
        while (pcm.hasRemaining()) assertEquals(8000, pcm.getShort());
    }
    @Test public void boundariesDoNotChangeOutput() throws Exception {
        assertArrayEquals(render(48000, 48000), render(48000, 37));
    }
    @Test public void emptyInputRemainsEmpty() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        new VideoPcmResampler(16000, 1, false).finish(out);
        assertEquals(0, out.size());
    }
    @Test public void upsamplingRetainsOneSecondDuration() throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        VideoPcmResampler sampler = new VideoPcmResampler(8000, 1, false);
        sampler.accept(ByteBuffer.allocate(16000), out); sampler.finish(out);
        assertEquals(32000, out.size());
    }
}
