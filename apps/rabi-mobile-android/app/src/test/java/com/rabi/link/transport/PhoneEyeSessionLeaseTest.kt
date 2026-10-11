package com.rabi.link.transport

import org.junit.Assert.*
import org.junit.Test

class PhoneEyeSessionLeaseTest {
    @Test fun applicationTokenCannotAuthenticateAnEyeEvenIfItsDirectoryHasOnlyOneGlassesRow() {
        var directoryReads=0
        fun authenticate(token:String){PhoneEyeSessionLease.requireDeviceCredential(token);directoryReads++}
        assertFails{authenticate("application-token")};assertEquals(0,directoryReads)
        assertFails{authenticate("rbd_"+"a".repeat(42))};assertEquals(0,directoryReads)
        authenticate("rbd_"+"a".repeat(43));assertEquals(1,directoryReads)
    }
    @Test fun continuousUseBeyondFifteenMinutesRenewsOnlyThroughOriginalDeviceAuthority() {
        var now=0L;var current=true;var verified=0
        val lease=PhoneEyeSessionLease({check(current){"scope changed"}},{verified++},{now})
        repeat(144){now+=10*60*1000;lease.renew();lease.assertCurrent()}
        assertEquals(144,verified);assertTrue(lease.expiresAt>24*60*60*1000L)
        current=false;val old=lease.expiresAt
        assertFails{lease.renew()};assertEquals(old,lease.expiresAt);assertEquals(144,verified)
    }
    @Test fun revocationExpiredUnknownAndAuthorityChangedDuringAuthenticationCannotExtendLease() {
        var now=0L;var current=true;var revoked=false
        val lease=PhoneEyeSessionLease({check(current)},{check(!revoked);current=false},{now})
        val old=lease.expiresAt;assertFails{lease.renew()};assertEquals(old,lease.expiresAt)
        current=true;revoked=true;assertFails{lease.renew()};assertEquals(old,lease.expiresAt)
        now=old;assertFails{lease.renew()};assertEquals(old,lease.expiresAt)
    }
    private fun assertFails(block:()->Unit){try{block();fail("lease should fail closed")}catch(_:IllegalStateException){}}
}
