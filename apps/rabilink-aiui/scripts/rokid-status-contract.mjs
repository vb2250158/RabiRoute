import assert from 'node:assert/strict';
export function assertStatusPublisher({publisher,owner,manifest}) {
  for (const marker of ['if (!settings.running) return','if (binding.isEmpty() || !relay.statusSyncEnabled) return','if (closed || !settings.running || !settings.uploadEnabled) return','if (!relay.configured || !relay.statusSyncEnabled) return','if (closed || !latest.running || !latest.uploadEnabled) return','identity(current.baseUrl, current.token) != binding','data.getString("binding") != identity(relay.baseUrl, relay.token)','sdk.publishMobileDeviceStatus(relay.baseUrl, relay.token','AtomicFile','MessageDigest.getInstance("SHA-256")','override fun close() { closed = true; worker.shutdown() }']) assert.ok(publisher.includes(marker),`Status publisher gate/lifecycle missing: ${marker}`);
  for(const marker of ['new com.rabi.link.modules.rokid.RabiGlassStatusPublisher(this','glassStatusPublisher.accept(info.batteryLevel, info.ischarging)','glassStatusPublisher.onNetworkAvailable()','glassStatusPublisher.close()']) assert.ok(owner.includes(marker),`Conversation owner binding missing: ${marker}`);
  assert.doesNotMatch(publisher,/customViewOpen|customViewUpdate|connectCustomViewSession|configCXRSession|setGlassBrightness|setGlassVolume|connectStatusOnly|scheduleAtFixedRate/, 'Publisher must not own CXR/session/UI/timer');
  assert.match(manifest,/RabiConversationService[\s\S]*?android:exported="false"/,'Conversation owner must not be externally exported');
  assert.doesNotMatch(manifest,/RokidDeviceStatusSyncService/,'Retired standalone service must not return');
}
