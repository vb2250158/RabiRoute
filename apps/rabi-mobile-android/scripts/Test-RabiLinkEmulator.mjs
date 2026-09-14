import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.join(scriptDir, "rabilink-emulator-relay-stub.mjs");
const adbPath = process.env.RABI_EMULATOR_ADB || "adb";
const serial = process.env.RABI_EMULATOR_SERIAL || "";
const hostIp = process.env.RABI_EMULATOR_HOST_IP || "";
const stubPort = Number(process.env.RABI_EMULATOR_STUB_PORT || 18894);
const useAdbReverse = process.env.RABI_EMULATOR_ADB_REVERSE !== "0";
const packageName = "com.rabi.link";

if (!useAdbReverse && !hostIp) {
  throw new Error("RABI_EMULATOR_HOST_IP is required when RABI_EMULATOR_ADB_REVERSE=0.");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function adb(...args) {
  const target = serial ? ["-s", serial] : [];
  const result = spawnSync(adbPath, [...target, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `adb failed: ${args.join(" ")}`).trim());
  }
  return result.stdout || "";
}

function writePreference(name, xml) {
  const encoded = Buffer.from(xml, "utf8").toString("base64");
  adb(
    "shell",
    `run-as ${packageName} sh -c 'echo ${encoded} | base64 -d > shared_prefs/${name}.xml'`,
  );
}

function startStub() {
  return spawn(process.execPath, [stubPath], {
    cwd: scriptDir,
    env: {
      ...process.env,
      RABI_EMULATOR_STUB_HOST: "0.0.0.0",
      RABI_EMULATOR_STUB_PORT: String(stubPort),
    },
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitForStub() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${stubPort}/__state`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await sleep(250);
  }
  throw new Error("Emulator relay stub did not start.");
}

async function stopStub(child) {
  if (!child || child.exitCode != null) return;
  child.kill();
  const deadline = Date.now() + 5_000;
  while (child.exitCode == null && Date.now() < deadline) await sleep(100);
}

async function stubState() {
  const response = await fetch(`http://127.0.0.1:${stubPort}/__state`);
  if (!response.ok) throw new Error(`Stub state failed: HTTP ${response.status}`);
  return response.json();
}

function captureSnapshot(state) {
  let captureXml = "";
  try {
    captureXml = adb("shell", `run-as ${packageName} cat shared_prefs/rabi_phone_audio_capture.xml`);
  } catch {
    captureXml = "";
  }
  const serviceDump = adb("shell", "dumpsys", "activity", "services", packageName);
  const powerDump = adb("shell", "dumpsys", "power");
  return {
    serviceRunning: serviceDump.includes("RabiConversationService"),
    audioStarts: state.audioStarts,
    audioChunks: state.audioChunks,
    audioBytes: state.audioBytes,
    lastSequence: state.lastSequence,
    sourceDeviceId: state.lastSourceDeviceId,
    routeProfileId: state.lastRouteProfileId,
    captureActive: /name="active" value="true"/.test(captureXml),
    wakeLockHeld: powerDump.includes("RabiLink:PhoneAudioCapture"),
  };
}

let stub;
try {
  if (useAdbReverse) {
    adb("reverse", `tcp:${stubPort}`, `tcp:${stubPort}`);
  }
  adb("shell", "am", "force-stop", packageName);
  writePreference(
    "rabi_link_relay_bridge",
    `<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name='relayBaseUrl'>http://${useAdbReverse ? "127.0.0.1" : hostIp}:${stubPort}/rabilink</string><string name='token'>emulator-test-token</string><boolean name='deviceStatusSyncEnabled' value='false' /></map>`,
  );
  writePreference(
    "rabi_mobile_message_target",
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name='routeProfileId'>__emulator_test__</string></map>",
  );
  writePreference(
    "rabi_conversation_settings",
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?><map><string name='inputMode'>PHONE</string><string name='proactivityPreference'>quiet</string><boolean name='autoPlayAgentVoice' value='false' /><string name='ttsModel'>local-tts/gpt-sovits</string><string name='ttsVoice'>YeYu</string></map>",
  );

  stub = startStub();
  await waitForStub();
  adb("shell", "am", "start", "-n", `${packageName}/.MainActivity`);
  await sleep(15_000);
  const initial = captureSnapshot(await stubState());

  await stopStub(stub);
  stub = undefined;
  await sleep(5_000);

  stub = startStub();
  await waitForStub();
  await sleep(15_000);
  const recovered = captureSnapshot(await stubState());

  process.stdout.write(`${JSON.stringify({ ok: true, serial: serial || "default-adb-device", initial, recovered }, null, 2)}\n`);
} finally {
  await stopStub(stub);
  try {
    adb("shell", "am", "force-stop", packageName);
  } catch {
    // Best-effort cleanup on the isolated emulator only.
  }
  if (useAdbReverse) {
    try {
      adb("reverse", "--remove", `tcp:${stubPort}`);
    } catch {
      // Best-effort cleanup of the test-only port mapping.
    }
  }
}
