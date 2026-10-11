package com.rabi.link.transport

/** Local connection credential only. Renewal requires the original device credential authority. */
internal class PhoneEyeSessionLease(private val assertAuthority:()->Unit,private val verifyDevice:()->Unit,private val now:()->Long={System.currentTimeMillis()}) {
    companion object {
        /** Formal device credentials have a distinct kind; an application directory row is not identity proof. */
        fun requireDeviceCredential(token:String){check(token.matches(Regex("rbd_[A-Za-z0-9_-]{43}"))){"PHONE_DEVICE_CREDENTIAL_REQUIRED"}}
    }
    @Volatile var expiresAt:Long=now()+900000
        private set
    fun assertCurrent(){assertAuthority();check(expiresAt>now()){"PHONE_BRIDGE_PAIRING_EXPIRED"}}
    @Synchronized fun renew():Long {
        assertCurrent()
        verifyDevice()
        assertCurrent()
        expiresAt=now()+900000
        return expiresAt
    }
}
