import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const probeRoot = path.resolve(projectRoot, "..", "rabilink-android");
const adb = String(process.env.RABILINK_E2E_ADB || path.join(probeRoot, "out", "tools", "android-sdk", "platform-tools", "adb.exe"));
const statusFile = String(process.env.RABILINK_E2E_STATUS_FILE || "").trim();
const reportPath = path.join(projectRoot, "dist", "real-glasses-device-status.json");

assert.ok(statusFile, "RABILINK_E2E_STATUS_FILE is required.");
assert.ok(fs.existsSync(statusFile), "Relay device status file does not exist.");
assert.ok(fs.existsSync(adb), "ADB executable does not exist.");

function adbText(args) {
  const result = spawnSync(adb, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `ADB failed: ${args.join(" ")}`);
  return result.stdout || "";
}

const row = JSON.parse(fs.readFileSync(statusFile, "utf8"));
const logcat = adbText(["logcat", "-d", "-s", "RabiLinkGlassStatus:D", "CXRLink:I", "*:S"]);
const services = adbText(["shell", "dumpsys", "activity", "services", "com.rabi.link"]);
const deviceRows = [...logcat.matchAll(/onGlassDeviceInfo=.*?battery=(\d+).*?charging=(true|false)/g)];
const publishRows = [...logcat.matchAll(/Published battery=(\d+) charging=(true|false) stale=(true|false)/g)];
const lastDevice = deviceRows.at(-1);
const lastPublish = publishRows.at(-1);
const statusOnlyProven = logcat.includes("connectStatusOnly=true")
  || /链路状态 cxr=true bt=true customView=false/.test(logcat);

assert.ok(statusOnlyProven, "The phone did not prove a display-free CXR status connection.");
assert.ok(lastDevice, "No real GlassInfo callback was found in phone logs.");
assert.ok(lastPublish, "No successful Relay status publication was found in phone logs.");
assert.ok(services.includes("RokidDeviceStatusSyncService"), "The phone status foreground service is not running.");
assert.equal(Number(lastPublish[1]), Number(row.batteryLevel), "Latest published battery must match Relay persistence.");
assert.equal(lastPublish[2] === "true", row.charging === true, "Latest published charging state must match Relay persistence.");
assert.equal(row.source, "rokid-cxr-phone");
assert.equal(logcat.includes("customViewOpen"), false, "Status sync must not open a Custom View.");
assert.equal(logcat.includes("configCXRSession"), false, "Status sync must not configure a display session.");

const report = {
  checkedAt: new Date().toISOString(),
  ok: true,
  phonePackage: "com.rabi.link",
  serviceRunning: true,
  statusOnlyConnection: statusOnlyProven,
  customViewOpened: false,
  displaySessionConfigured: false,
  glassInfoCallbacks: deviceRows.length,
  successfulPublishes: publishRows.length,
  batteryLevel: Number(row.batteryLevel),
  charging: row.charging === true,
  source: row.source,
  observedAt: row.observedAt,
  receivedAt: row.receivedAt,
  tokenStored: false
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Real glasses status evidence passed: ${report.batteryLevel}%, charging=${report.charging}, publishes=${report.successfulPublishes}.`);
