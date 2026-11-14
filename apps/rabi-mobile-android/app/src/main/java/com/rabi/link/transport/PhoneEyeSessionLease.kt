package com.rabi.link.transport

/** Local connection credential only. Renewal requires the original device credential authority. */
internal class PhoneEyeSessionLease(assertAuthority: () -> Unit, verifyDevice: () -> Unit, now: () -> Long = { System.currentTimeMillis() }) {
    companion object {
        /** Formal device credentials have a distinct kind; an application directory row is not identity proof. */
        fun requireDeviceCredential(token: String) {
            check(token.matches(Regex("rbd_[A-Za-z0-9_-]{43}"))) { "PHONE_DEVICE_CREDENTIAL_REQUIRED" }
        }
    }

    private val lease = PhoneEyeLease(assertAuthority, verifyDevice, 900000, now)
    val expiresAt: Long get() = lease.expiresAt
    fun assertCurrent() = lease.assertCurrent()
    fun renew(): Long = lease.renew()
}
