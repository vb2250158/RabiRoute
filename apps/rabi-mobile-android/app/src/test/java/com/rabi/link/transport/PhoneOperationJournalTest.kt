package com.rabi.link.transport

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PhoneOperationJournalTest {
    @Test fun unknownCapacityRejectsANewIntentBeforeDispatchAndRetainsOriginalAfterAging() {
        var durable=JSONObject();var now=1L
        val journal=PhoneOperationJournal(JSONObject(),{durable=JSONObject(it.toString())},{now})
        repeat(128){assertNull(journal.begin("unknown:$it","fingerprint-$it"))};now+=8L*24*60*60*1000
        try{journal.begin("unknown:128","new-fingerprint");fail("unknown intent exceeded capacity")}catch(error:IllegalStateException){assertEquals("HTTP_UNCONFIRMED_INTENT_LIMIT",error.message)}
        assertEquals(128,durable.length());assertNotNull(journal.begin("unknown:0","fingerprint-0"))
        journal.settle("unknown:0",PhoneOperationJournal.receipt("unknown:0",false,"confirmed"),true)
        assertNull(journal.begin("unknown:128","new-fingerprint"))
        assertTrue(journal.begin("unknown:1","fingerprint-1")!!.getJSONObject("data").getJSONObject("structuredContent").getBoolean("uncertain"))
    }
    @Test fun moreThan128SuccessfulWritesRemainAvailableAndOldIdentitiesCannotReplay() {
        var durable=JSONObject();var now=1000000000L
        val journal=PhoneOperationJournal(JSONObject(),{durable=JSONObject(it.toString())},{now})
        assertNull(journal.begin("unknown-original","unknown-target-fingerprint"))
        repeat(400){id->assertNull(journal.begin("write:$id","target-$id"));journal.settle("write:$id",JSONObject().put("code",0).put("data",JSONObject().put("structuredContent",JSONObject().put("ok",true).put("uncertain",false).put("data","original-$id"))),true);now++}
        assertEquals(401,durable.length());assertTrue(journal.begin("unknown-original","unknown-target-fingerprint")!!.getJSONObject("data").getJSONObject("structuredContent").getBoolean("uncertain"))
        assertEquals("HTTP_ORIGINAL_RESULT_RETIRED",journal.begin("write:0","target-0")!!.getJSONObject("data").getJSONObject("structuredContent").getString("code"))
        try{journal.begin("write:0","different-PC");fail("original target changed")}catch(_:IllegalStateException){}
        val restored=PhoneOperationJournal(durable,{durable=JSONObject(it.toString())},{now})
        assertNotNull(restored.begin("write:399","target-399"));assertNull(restored.begin("write:400","target-400"))
        now+=8L*24*60*60*1000;restored.settle("write:400",PhoneOperationJournal.receipt("write:400",false,"HTTP_ORIGINAL_STREAM_COMPLETED"),true)
        assertEquals("HTTP_ORIGINAL_RESULT_RETIRED",restored.begin("write:399","target-399")!!.getJSONObject("data").getJSONObject("structuredContent").getString("code"))
        assertTrue(restored.begin("unknown-original","unknown-target-fingerprint")!!.getJSONObject("data").getJSONObject("structuredContent").getBoolean("uncertain"))
    }
}
