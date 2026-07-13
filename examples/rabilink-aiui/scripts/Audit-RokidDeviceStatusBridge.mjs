import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const androidRoot = path.join(repoRoot, "examples", "android-rabi-link-probe");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const controller = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/modules/rokid/RokidCxrController.java");
const service = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/modules/rokid/RokidDeviceStatusSyncService.java");
const callbacks = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/modules/rokid/RokidCxrCallbacks.java");
const manifest = read("examples/android-rabi-link-probe/app/src/main/AndroidManifest.xml");
const relaySettings = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/RabiLinkRelaySettings.kt");
const mainActivity = read("examples/android-rabi-link-probe/app/src/main/java/com/rabi/link/MainActivity.kt");
const sdk = read("sdk/android/rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt");
const aiui = read("examples/rabilink-aiui/pages/home/index.ink");
const relay = read("scripts/rabilink-relay-server.mjs");

const statusOnlyStart = controller.indexOf("boolean connectStatusOnly(String token)");
const statusOnlyEnd = controller.indexOf("\n    boolean connectGlassAppSession", statusOnlyStart);
assert.ok(statusOnlyStart >= 0 && statusOnlyEnd > statusOnlyStart, "Status-only CXR method is missing.");
const statusOnlyMethod = controller.slice(statusOnlyStart, statusOnlyEnd);
assert.match(statusOnlyMethod, /cxrLink\.connect\(token\)/, "Status-only CXR must bind through the authorized service.");
assert.doesNotMatch(statusOnlyMethod, /configCXRSession|customViewOpen|customViewUpdate/, "Status sync must not configure a CXR session or open a Custom View.");

assert.match(callbacks, /listener\.onGlassDeviceInfo\(info\)/, "GlassInfo must reach the status service listener.");
assert.match(service, /connectStatusOnly\(rokidToken\.trim\(\)\)/, "The foreground service must use status-only CXR binding.");
assert.match(service, /controller\.getGlassDeviceInfo\(\)/, "The foreground service must query real GlassInfo.");
assert.match(service, /info\.batteryLevel/, "The foreground service must map real batteryLevel.");
assert.match(service, /info\.ischarging/, "The foreground service must map real charging state.");
assert.match(service, /publishMobileDeviceStatus/, "The foreground service must publish sanitized status through the SDK.");
assert.match(service, /getStatusSyncEnabled\(\)/, "Legacy phone settings must not silently opt in to the new foreground service.");
assert.doesNotMatch(service, /customViewOpen|connectCustomViewSession|setGlassBrightness|setGlassVolume/, "The status service must not alter the glasses UI or settings.");
assert.match(manifest, /RokidDeviceStatusSyncService/, "The status service must be packaged in the phone APK.");
assert.match(manifest, /RokidDeviceStatusSyncService[\s\S]*?android:exported="false"/, "The status service must not be externally exported.");
assert.match(relaySettings, /statusSyncEnabled = prefs\.getBoolean\(KEY_STATUS_SYNC_ENABLED, false\)/, "Status sync must default off for legacy preferences.");
assert.match(relaySettings, /putBoolean\(KEY_STATUS_SYNC_ENABLED, true\)/, "A successful current-version Relay setup must opt in to status sync.");
assert.match(mainActivity, /it\.configured && it\.statusSyncEnabled/, "Automatic service startup must honor the explicit opt-in flag.");

assert.match(sdk, /fun publishMobileDeviceStatus\(/, "The Android SDK must expose the authenticated status publisher.");
assert.match(sdk, /\/api\/rabilink\/mobile\/device-status/, "The Android SDK must target the Relay device-status endpoint.");
assert.match(relay, /function writeMobileDeviceStatus\(/, "Relay must persist phone status by app.");
assert.match(relay, /deviceStatus: readMobileDeviceStatus\(app\)/, "Relay mobile state must include deviceStatus.");
assert.match(aiui, /applyRelayBatteryState\(state\)/, "AIUI must consume Relay status after connecting.");
assert.match(aiui, /normalizeRelayBatterySnapshot/, "AIUI must reject stale Relay battery snapshots.");
assert.match(aiui, /batterySource: source/, "AIUI must retain the real battery source.");

assert.ok(fs.existsSync(path.join(androidRoot, "app", "src", "main", "java", "com", "rabi", "link", "RabiLinkRelaySettings.kt")));
console.log("Rokid device-status bridge audit passed: status-only CXR, authenticated Relay, stale-safe AIUI.");
