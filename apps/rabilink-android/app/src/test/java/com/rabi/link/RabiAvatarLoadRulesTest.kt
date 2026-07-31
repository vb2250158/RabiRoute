package com.rabi.link

import org.junit.Assert.assertEquals
import org.junit.Test

class RabiAvatarLoadRulesTest {
    @Test fun exactCacheIsShownWhileTheRelayCopyIsValidated() {
        assertEquals(RabiAvatarLoadRules.State.VALIDATING, RabiAvatarLoadRules.cachedState(true, true))
    }

    @Test fun anOlderAvatarRemainsVisibleUntilTheNewVersionLoads() {
        assertEquals(RabiAvatarLoadRules.State.STALE, RabiAvatarLoadRules.cachedState(false, true))
        assertEquals(RabiAvatarLoadRules.State.STALE, RabiAvatarLoadRules.failureState(true))
    }

    @Test fun missingAndFailedAvatarsHaveExplicitStates() {
        assertEquals(RabiAvatarLoadRules.State.LOADING, RabiAvatarLoadRules.cachedState(false, false))
        assertEquals(RabiAvatarLoadRules.State.UNAVAILABLE, RabiAvatarLoadRules.failureState(false))
    }
}
