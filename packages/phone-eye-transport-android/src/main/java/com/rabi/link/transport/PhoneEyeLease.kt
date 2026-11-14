package com.rabi.link.transport

/** A renewable device lease whose authority is checked before and after verification. */
class PhoneEyeLease(
    private val assertAuthority: () -> Unit,
    private val verifyDevice: () -> Unit,
    private val durationMillis: Long,
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    init { require(durationMillis > 0) }

    @Volatile var expiresAt: Long = now() + durationMillis
        private set

    fun assertCurrent() {
        assertAuthority()
        check(expiresAt > now()) { "PHONE_BRIDGE_PAIRING_EXPIRED" }
    }

    @Synchronized fun renew(): Long {
        assertCurrent()
        verifyDevice()
        assertCurrent()
        expiresAt = now() + durationMillis
        return expiresAt
    }
}
