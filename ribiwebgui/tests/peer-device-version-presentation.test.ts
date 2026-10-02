import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { readRabiLinkHome, rabiLinkDeviceVersionLabel, rabiLinkDeviceKind } from "../src/rabiLinkHomeClient";
import { personaSourceOptions } from "../src/persona/personaSourcePresentation";
import { englishCatalog } from "../src/i18n/catalog";

const identity = { id: "example-pc", guid: "example-guid", name: "Example PC", online: true, capabilities: [] };

test("home reads each PC's version and local marker from its own Manager DTO", async () => {
  const advertised = [
    { ...identity, deviceKind: "pc", rabiPcVersion: "0.3.19", isLocal: true },
    { ...identity, id: "another-pc", guid: "another-guid", deviceKind: "pc", rabiPcVersion: "0.3.18", isLocal: false },
    { ...identity, id: "old-pc", guid: "old-guid", deviceKind: "pc", rabiPcVersion: null, isLocal: false },
    { ...identity, id: "phone", guid: "phone-guid", deviceKind: "phone", rabiPcVersion: null, isLocal: false }
  ];
  const request: typeof fetch = async () => Response.json({ code: 0, data: { devices: advertised, checkedAt: "2026-01-01T00:00:00.000Z" } });
  const { devices } = await readRabiLinkHome(new AbortController().signal, request);
  assert.deepEqual(devices.map(device => device.isLocal), [true, false, false, false], "A same-named remote PC must not be marked local");
  assert.deepEqual(devices.map(device => rabiLinkDeviceVersionLabel(device)), ["RabiPC v0.3.19", "RabiPC v0.3.18", "RabiPC 版本未知", ""]);
  assert.equal(devices[1].rabiPcVersion, "0.3.18", "A remote version must never inherit the local version");
  assert.equal(devices[0].deviceKind, "pc");
});

test("only explicitly classified PCs get version labels; old PC advertisements remain unknown", () => {
  assert.equal(rabiLinkDeviceVersionLabel({ ...identity, deviceKind: "pc" }), "RabiPC 版本未知");
  assert.equal(rabiLinkDeviceKind({ ...identity, name: "Array station", deviceKind: "pc" }), "desktop", "An explicit PC classification must outrank a name heuristic");
  for (const deviceKind of ["phone", "glasses", "watch", "unknown"]) {
    assert.equal(rabiLinkDeviceVersionLabel({ ...identity, deviceKind, rabiPcVersion: "0.3.19" }), "");
  }
  assert.equal(rabiLinkDeviceVersionLabel(identity), "", "An untyped legacy device is not assumed to be a PC for version display");
});

test("persona source options identify the local PC while preserving local and remote reference keys", () => {
  const devices = [
    { deviceId: "peer-a", name: "Example PC", online: true, supported: true, trusted: false, rabiPcVersion: "0.3.18" },
    { deviceId: "peer-old", name: "Old PC", online: true, supported: false, trusted: false, rabiPcVersion: null },
    { deviceId: "peer-offline", name: "Offline PC", online: false, supported: true, trusted: true }
  ];
  const meta = { rabiName: "Example PC", computerName: "Host fallback", version: "0.3.19" };
  const options = personaSourceOptions(meta, devices, "peer-offline");
  assert.equal(options[0].title, "本机 · Example PC");
  assert.equal(options[0].value, "", "Choosing the labelled local PC keeps the local reference key");
  assert.equal(options[0].subtitle, "RabiPC v0.3.19 · 使用本机人格");
  assert.equal(options[1].value, "peer-a");
  assert.equal(options[1].subtitle, "RabiPC v0.3.18 · 在线 · 将自动连接");
  assert.equal(options[1].props.disabled, false);
  assert.equal(options[2].subtitle, "RabiPC 版本未知 · 在线 · 需要更新");
  assert.equal(options[3].subtitle, "RabiPC 版本未知 · 离线");
  assert.equal(options[3].props.disabled, false, "The saved offline owner remains selectable");
  const refreshed = personaSourceOptions({ ...meta, rabiName: "Renamed PC", version: "0.3.20" }, devices, "");
  assert.equal(refreshed[0].title, "本机 · Renamed PC");
  assert.equal(refreshed[0].subtitle, "RabiPC v0.3.20 · 使用本机人格");
  assert.equal(refreshed[1].subtitle, options[1].subtitle);
  assert.equal(refreshed[3].props.disabled, true);
});

test("source labels translate UI text without translating names or fabricating missing versions", () => {
  const translate = (text: string) => englishCatalog[text] || text;
  const options = personaSourceOptions({ rabiName: "", computerName: "Example Host", version: "0.3.19" }, [], "saved-owner", translate);
  assert.equal(options[0].title, "Local PC · Example Host");
  assert.equal(options[1].value, "saved-owner");
  assert.equal(options[1].subtitle, "RabiPC Version unknown · Saved remote PC · Status pending verification");
  assert.equal(personaSourceOptions({ version: "" }, [], "", translate)[0].title, "Local PC");
});

test("both pages consume the version presentation without turning the local PC into a remote owner", () => {
  const home = fs.readFileSync(new URL("../src/pages/RabiLinkPage.vue", import.meta.url), "utf8");
  const persona = fs.readFileSync(new URL("../src/pages/PersonaTemplatePage.vue", import.meta.url), "utf8");
  assert.match(home, /v-if="device\.isLocal"/);
  assert.match(home, /rabiLinkDeviceVersionLabel\(device, t\)/);
  assert.match(persona, /buildPersonaSourceOptions\(store\.meta, remotePersona\.devices/);
  assert.match(persona, /本机人格在本机项中选择；远端列表仅列出其他 PC。/);
});
