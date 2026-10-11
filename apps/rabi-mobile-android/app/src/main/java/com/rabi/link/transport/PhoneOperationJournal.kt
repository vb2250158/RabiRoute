package com.rabi.link.transport

import org.json.JSONObject

/** Retire cached terminal payloads, never retire an original operation's identity. */
internal class PhoneOperationJournal(private val rows:JSONObject,private val save:(JSONObject)->Unit,private val now:()->Long=System::currentTimeMillis) {
    @Synchronized fun begin(id:String,fingerprint:String):JSONObject? {
        require(id.matches(Regex("[A-Za-z0-9:._-]{1,256}")))
        val existing=rows.optJSONObject(id)
        if(existing!=null){check(existing.getString("fingerprint")==fingerprint){"HTTP_OPERATION_CONFLICT"};return existing.getJSONObject("response")}
        check(rows.keys().asSequence().count{!rows.getJSONObject(it).has("confirmedAt")}<128){"HTTP_UNCONFIRMED_INTENT_LIMIT"}
        rows.put(id,JSONObject().put("fingerprint",fingerprint).put("createdAt",now()).put("response",receipt(id,true,"MANAGER_REQUEST_UNCONFIRMED")))
        save(rows);return null
    }
    @Synchronized fun settle(id:String,response:JSONObject,confirmed:Boolean) {
        val row=rows.getJSONObject(id);row.put("response",response)
        if(confirmed)row.put("confirmedAt",now())
        val confirmedRows=rows.keys().asSequence().map{it to rows.getJSONObject(it)}.filter{it.second.has("confirmedAt")}.sortedByDescending{it.second.getLong("confirmedAt")}.toList()
        confirmedRows.forEachIndexed{index,(key,value)->if(index>=128 || value.getLong("confirmedAt")<now()-7L*24*60*60*1000){value.put("response",receipt(key,false,"HTTP_ORIGINAL_RESULT_RETIRED"))}}
        save(rows)
    }
    companion object {
        fun receipt(id:String,uncertain:Boolean,code:String)=JSONObject().put("code",0).put("data",JSONObject().put("structuredContent",JSONObject().put("ok",false).put("uncertain",uncertain).put("operationId",id).put("statusCode",409).put("code",code)))
    }
}
