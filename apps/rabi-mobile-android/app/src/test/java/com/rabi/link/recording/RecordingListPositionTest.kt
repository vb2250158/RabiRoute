package com.rabi.link.recording

import org.junit.Assert.*
import org.junit.Test

class RecordingListPositionTest {
    @Test fun prependingNewEventsKeepsHistoryAnchorInLargeList() {
        val ids = (100_005 downTo 1).map { "event-$it" }
        val index = RecordingListPosition.restore(ids,"event-50000","event-99999",true)
        assertEquals("event-50000",ids[index])
        assertEquals(50005,index)
    }
    @Test fun selectionWinsOnlyWhenTimelineOwnsPosition() {
        assertEquals(0,RecordingListPosition.restore(listOf("new","old"),"old","new",false))
        assertEquals(1,RecordingListPosition.restore(listOf("new","old"),"old","new",true))
    }
    @Test fun absentOrFilteredAnchorDoesNotJumpToFirstRecord() {
        assertEquals(-1,RecordingListPosition.restore(listOf("new"),"filtered",null,true))
        assertEquals(-1,RecordingListPosition.restore(emptyList(),null,null,false))
    }
}
