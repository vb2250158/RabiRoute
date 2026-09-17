package com.rabi.link.modules.rokid

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File

/** Synthetic event in an isolated cache spool; no live recording settings or user audio are touched. */
class AsrEventInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); start() }
    override fun onStart() {
        val result=Bundle(); var code=Activity.RESULT_OK
        val root=File(targetContext.cacheDir,"asr-acceptance-${java.util.UUID.randomUUID()}")
        val spool=RabiDurableAudioSpool(root,RabiDurableAudioSpool.Policy(16000,5000,1000000,0,60000),System::currentTimeMillis) { Long.MAX_VALUE }
        val uploader=RabiEventAsrUploader(targetContext)
        try {
            spool.setAsrEndpointIdentity("asr:fixture"); spool.bindCaptureEndpoint("fixture","asr:fixture")
            check(spool.append(ByteArray(32000),"phone","","fixture","transcribe",System.currentTimeMillis(),"received","fixture-event").accepted)
            spool.sealCapture()
            check(uploader.process(spool,spool.nextUpload()) { true })
            val receipt=spool.eventReceipt("fixture-event") ?: error("Missing durable transcript")
            check(receipt.has("text") && spool.nextUpload()==null)
            result.putString("transport",receipt.getString("transport"))
            result.putString("result","PASS: segmented event, persisted transcript, acknowledged shards")
        } catch(error: Throwable) { result.putString("error",error.stackTraceToString()); code=Activity.RESULT_CANCELED }
        finally { uploader.close(); spool.close(); root.deleteRecursively() }
        finish(code,result)
    }
}
