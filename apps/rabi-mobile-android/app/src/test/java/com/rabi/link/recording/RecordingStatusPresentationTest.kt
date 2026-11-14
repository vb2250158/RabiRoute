package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test

class RecordingStatusPresentationTest {
    @Test fun explicitPauseDoesNotClaimCompletionWhileOwnerIsStillSaving() {
        val saving = RecordingStatusPresentation.from(false,false,false,"正在停止并保存",saving=true)
        assertEquals("正在保存",saving.title)
        assertFalse(saving.recoverable)
        assertEquals("已暂停",RecordingStatusPresentation.from(false,false,false,"全天记录已暂停").title)
    }
    @Test fun currentOwnerSaveErrorRemainsVisibleAfterSwitchIsOff() {
        val failure = RecordingStatusPresentation.from(false,false,false,"全天记录已停止",saveError="写入失败")
        assertEquals("保存失败",failure.title)
        assertEquals("写入失败",failure.detail)
        assertTrue(failure.recoverable)
    }
    @Test fun savedSwitchWithoutCaptureEvidenceNeverShowsRecording() {
        val result = RecordingStatusPresentation.from(true,true,false,"")
        assertEquals("等待采集数据",result.title)
        assertTrue(result.recoverable)
        assertFalse(result.detail.isBlank())
    }
    @Test fun pausedCaptureDoesNotShowAnOldFailure() {
        assertEquals(RecordingStatusPresentation("已暂停","",false),
            RecordingStatusPresentation.from(false,false,false,"启动失败"))
    }
    @Test fun coldStartRecoveryDoesNotOfferRepeatedStartOrClaimLiveCapture() {
        val result = RecordingStatusPresentation.from(true,true,false,"上次已暂停",true)
        assertEquals("正在恢复记录",result.title)
        assertFalse(result.recoverable)
        assertFalse(result.detail.isBlank())
        assertEquals("正在记录",RecordingStatusPresentation.from(true,true,true,"正在收音",true).title)
    }
    @Test fun freshFramesShowRecordingButDoNotHideFailures() {
        assertEquals("正在记录",RecordingStatusPresentation.from(true,true,true,"录音中").title)
        val failure = RecordingStatusPresentation.from(true,true,true,"写入失败，请检查存储")
        assertEquals("采集失败",failure.title)
        assertEquals("写入失败，请检查存储",failure.detail)
    }
    @Test fun savingAndLowStorageHaveDifferentRecoveryActions() {
        assertFalse(RecordingStatusPresentation.from(true,true,false,"正在保存上一段").recoverable)
        val storage = RecordingStatusPresentation.from(true,true,false,"storage_low")
        assertTrue(storage.recoverable)
        assertTrue(storage.title.contains("空间不足"))
    }
}
