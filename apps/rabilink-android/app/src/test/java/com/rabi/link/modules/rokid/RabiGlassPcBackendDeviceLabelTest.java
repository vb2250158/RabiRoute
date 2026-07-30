package com.rabi.link.modules.rokid;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class RabiGlassPcBackendDeviceLabelTest {
    @Test
    public void phoneLabelIncludesModelAndStableSuffix() {
        assertEquals(
                "Rabi Android · HBP-AL00 · f743e5",
                RabiGlassPcBackend.deviceLabel("rabi-phone-3850263387f743e5", false, "HBP-AL00")
        );
    }

    @Test
    public void glassesLabelDoesNotClaimThePhoneModel() {
        assertEquals(
                "Rabi Glass · f743e5",
                RabiGlassPcBackend.deviceLabel("rabi-phone-3850263387f743e5", true, "")
        );
    }
}
