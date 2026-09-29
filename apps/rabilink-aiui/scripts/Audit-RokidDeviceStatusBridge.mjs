import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertStatusPublisher } from './rokid-status-contract.mjs';

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const androidRoot = path.join(repoRoot, "apps", "rabi-mobile-android");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const controller = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RokidCxrController.java");
const publisher = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RabiGlassStatusPublisher.kt");
const owner = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiConversationService.java");
const callbacks = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RokidCxrCallbacks.java");
const manifest = read("apps/rabi-mobile-android/app/src/main/AndroidManifest.xml");
const relaySettings = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/RabiLinkRelaySettings.kt");
const mainActivity = read("apps/rabi-mobile-android/app/src/main/java/com/rabi/link/MainActivity.kt");
const sdk = read("packages/android-sdk/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const aiui = read("apps/rabilink-aiui/pages/home/index.ink");
const relay = read("scripts/rabilink-relay-server.mjs");

const statusOnlyStart = controller.indexOf("boolean connectStatusOnly(String token)");
const statusOnlyEnd = controller.indexOf("\n    public boolean connectGlassAppSession", statusOnlyStart);
assert.ok(statusOnlyStart >= 0 && statusOnlyEnd > statusOnlyStart, "Status-only CXR method is missing.");
const statusOnlyMethod = controller.slice(statusOnlyStart, statusOnlyEnd);
assert.match(statusOnlyMethod, /cxrLink\.connect\(token\)/, "Status-only CXR must bind through the authorized service.");
assert.doesNotMatch(statusOnlyMethod, /configCXRSession|customViewOpen|customViewUpdate/, "Status sync must not configure a CXR session or open a Custom View.");

assert.match(callbacks, /listener\.onGlassDeviceInfo\(info\)/, "GlassInfo must reach the status service listener.");
assertStatusPublisher({ publisher, owner, manifest });
assert.match(relaySettings, /statusSyncEnabled = prefs\.getBoolean\(KEY_STATUS_SYNC_ENABLED, false\)/, "Status sync must default off for legacy preferences.");
assert.match(relaySettings, /putBoolean\(KEY_STATUS_SYNC_ENABLED, true\)/, "A successful current-version Relay setup must opt in to status sync.");
// Current publisher is owned by the existing conversation service, not MainActivity startup.

assert.match(sdk, /fun publishMobileDeviceStatus\(/, "The Android SDK must expose the authenticated status publisher.");
assert.match(sdk, /\/api\/rabilink\/mobile\/device-status/, "The Android SDK must target the Relay device-status endpoint.");
assert.match(relay, /function writeMobileDeviceStatus\(/, "Relay must persist phone status by app.");
assert.match(relay, /deviceStatus: readMobileDeviceStatus\(app\)/, "Relay mobile state must include deviceStatus.");
assert.match(aiui, /applyRelayBatteryState\(state\)/, "AIUI must consume Relay status after connecting.");
assert.match(aiui, /normalizeRelayBatterySnapshot/, "AIUI must reject stale Relay battery snapshots.");
assert.match(aiui, /batterySource: source/, "AIUI must retain the real battery source.");

assert.ok(fs.existsSync(path.join(androidRoot, "app", "src", "main", "java", "com", "rabi", "link", "RabiLinkRelaySettings.kt")));
console.log("Rokid device-status bridge audit passed: conversation-owned publisher, consent/credential gates, authenticated Relay, stale-safe AIUI.");
