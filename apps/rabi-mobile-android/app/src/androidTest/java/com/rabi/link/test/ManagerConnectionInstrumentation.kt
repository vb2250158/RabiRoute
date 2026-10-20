package com.rabi.link.test

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import com.rabi.link.RabiLinkRelaySettings
import com.rabi.link.transport.RabiManagerHttpTransport
import com.rabiroute.sdk.RabiRouteSdk

/** Native transport acceptance; archive enrollment requires explicit configureArchive/includeHistory arguments. */
class ManagerConnectionInstrumentation : Instrumentation() {
    private lateinit var args: Bundle
    override fun onCreate(arguments: Bundle) { super.onCreate(arguments); args = arguments; start() }
    override fun onStart() {
        val result = Bundle()
        var code = Activity.RESULT_CANCELED
        try {
            val relay = RabiLinkRelaySettings.load(targetContext)
            check(relay.configured)
            RabiManagerHttpTransport(targetContext).use { transport ->
                val sdk = RabiRouteSdk(managerTransport = transport)
                val directory = sdk.getMobileState(relay.baseUrl, relay.token)
                val target = args.getString("targetDeviceId") ?: error("Explicit targetDeviceId required")
                check(directory.rawJson.getString("connectionOwnerDeviceId") == target)
                val meta = sdk.requestMobileManager(relay.baseUrl, relay.token, target, "/meta")
                check(meta.getString("rabiGuid") == args.getString("expectedGuid"))
                check(meta.getString("applicationGenerationId") == args.getString("expectedGeneration"))
                check(meta.getJSONObject("health").getBoolean("live"))
                result.putString("managerName", meta.getString("rabiName"))
                result.putString("managerGeneration", meta.getString("applicationGenerationId"))
                result.putString("managerInstanceId", meta.getString("managerInstanceId"))
                var asr = sdk.mobileAsrSettings(relay.baseUrl, relay.token)
                if(args.getString("configureArchive") == "true") {
                    check(asr.workers.any { it.id == target && it.online }) { "Current PC is absent from ASR directory" }
                    val priority = listOf(target)+asr.workers.map { it.id }.filter { it != target }
                    sdk.mobileAsrSettings(relay.baseUrl,relay.token,priority)
                    asr = sdk.mobileAsrSettings(relay.baseUrl,relay.token)
                    check(asr.selectedWorkerId == target)
                    val worker = directory.workers.single { it.id == target }
                    val archive = com.rabi.link.recording.RecordingArchiveTransport(targetContext,relay,worker)
                    val cap = archive.probeCapabilities()
                    com.rabi.link.recording.RecordingArchiveSession.configure(targetContext,worker,
                        cap.getString("storageNamespaceId"),cap.getLong("bindingRevision"),true)
                    com.rabi.link.recording.RecordingResourceCache.save(targetContext,true,
                        com.rabi.link.recording.RecordingResourceCache.hours(targetContext))
                    if(args.getString("includeHistory") == "true")
                        com.rabi.link.recording.RecordingArchiveSession.authorizeExisting(targetContext)
                    result.putString("archiveWorker",target)
                    result.putBoolean("playbackCacheEnabled",com.rabi.link.recording.RecordingResourceCache.enabled(targetContext))
                }
                result.putString("asrSelectedWorker", asr.selectedWorkerId)
                result.putInt("asrWorkers", asr.workers.size)
                result.putString("result", "passed: phone to current PC meta and ASR directory")
                code = Activity.RESULT_OK
            }
        } catch (error: Throwable) {
            result.putString("result", "failed")
            result.putString("error", error.message ?: error.javaClass.simpleName)
        }
        finish(code, result)
    }
}
