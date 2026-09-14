package com.rabi.link

import org.junit.Assert.assertEquals
import org.junit.Test

class RabiAvatarLoadRulesTest {
    @Test fun exactVersionCacheIsReadyWhileRelayRefreshContinuesSilently() {
        assertEquals(RabiAvatarLoadRules.State.READY, RabiAvatarLoadRules.cachedState(true, true))
    }

    @Test fun anOlderAvatarRemainsVisibleUntilTheNewVersionLoads() {
        assertEquals(RabiAvatarLoadRules.State.STALE, RabiAvatarLoadRules.cachedState(false, true))
        assertEquals(RabiAvatarLoadRules.State.STALE, RabiAvatarLoadRules.failureState(true))
    }

    @Test fun missingAndFailedAvatarsHaveExplicitStates() {
        assertEquals(RabiAvatarLoadRules.State.LOADING, RabiAvatarLoadRules.cachedState(false, false))
        assertEquals(RabiAvatarLoadRules.State.UNAVAILABLE, RabiAvatarLoadRules.failureState(false))
    }

    @Test fun aMissingResourceIsNotPresentedAsAnotherPersonaAvatar() {
        assertEquals("未配置头像", RabiAvatarLoadRules.unavailableLabel(configured = false))
        assertEquals("头像暂不可用", RabiAvatarLoadRules.unavailableLabel(configured = true))
        assertEquals("夜雨 未配置头像", RabiAvatarLoadRules.placeholderContentDescription("夜雨"))
    }
}
