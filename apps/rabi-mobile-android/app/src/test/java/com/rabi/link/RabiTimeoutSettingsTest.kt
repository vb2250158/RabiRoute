package com.rabi.link

import com.rabiroute.sdk.RabiTimeoutSettings
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class RabiTimeoutSettingsTest {
    @Test fun overridesAreValidatedAndSnapshotsRemainIndependent() {
        val raw = JSONObject().put("android.manager.request", 90000)
        val one = RabiTimeoutSettings(raw)
        raw.put("android.manager.request", 2)
        assertEquals(90000L, one.get("android.manager.request", 45000))
        assertEquals(45000L, RabiTimeoutSettings().get("android.manager.request", 45000))
        for (invalid in listOf(0, -1, 1.5, 2147483648L, "20")) {
            assertEquals(200L, RabiTimeoutSettings(JSONObject().put("x", invalid)).get("x", 200))
        }
    }
}
