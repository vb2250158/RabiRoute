import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyCompanionScene, readCompanionSceneRules } from "./companionScene.js";
import type { CompanionObservation } from "../shared/companionActivity.js";
const rules = readCompanionSceneRules(JSON.parse(fs.readFileSync("packages/rabi-companion/scene-rules.json", "utf8")));
const observe = (processName: string, title: string, media?: CompanionObservation["media"]): CompanionObservation =>
  ({ sequence: 1, capturedAt: 100, source: "window", window: { id: "1", processName, title }, media });

test("foreground players and video pages classify before an Agent reply; ordinary browsing stays uncertain", () => {
  for (const process of ["PotPlayerMini64.exe", "vlc.exe", "mpc-hc.exe", "mpc-be64.exe"])
    assert.equal(classifyCompanionScene(observe(process, "Episode 1"), rules), "watch");
  assert.equal(classifyCompanionScene(observe("chrome.exe", "Episode 1_哔哩哔哩_bilibili"), rules), "watch");
  assert.equal(classifyCompanionScene(observe("msedge.exe", "A video - YouTube"), rules), "watch");
  assert.equal(classifyCompanionScene(observe("chrome.exe", "DSH Web"), rules), "uncertain");
  assert.equal(classifyCompanionScene(observe("Game-Win64-Shipping.exe", "Game"), rules), "play");
  for (const process of ["code.exe", "devenv.exe", "WindowsTerminal.exe", "WINWORD.EXE", "EXCEL.EXE", "obsidian.exe"])
    assert.equal(classifyCompanionScene(observe(process, "Work"), rules), "work");
  assert.equal(classifyCompanionScene(observe("explorer.exe", "Files"), rules), "other");
});
test("only a matching foreground video session supplies playback evidence", () => {
  const video = { kind: "video", status: "playing", title: "Episode 2" } as const;
  assert.equal(classifyCompanionScene(observe("unknown.exe", "Episode 2 | App", video), rules), "watch");
  assert.equal(classifyCompanionScene(observe("chrome.exe", "Work", video), rules), "uncertain");
  assert.equal(classifyCompanionScene(observe("unknown.exe", "Episode 2", { ...video, kind: "audio" }), rules), "uncertain");
  assert.equal(classifyCompanionScene(observe("unknown.exe", "Episode 2", { ...video, status: "paused" }), rules), "uncertain");
});
test("rules must carry bounded evidence", () => {
  assert.throws(() => readCompanionSceneRules({ rules: [{ kind: "watch" }] }));
  assert.throws(() => readCompanionSceneRules({ rules: [{ kind: "uncertain", titlePattern: "a" }] }));
  assert.throws(() => readCompanionSceneRules({ rules: [{ kind: "watch", titlePattern: "[" }] }));
  assert.throws(() => readCompanionSceneRules({ rules: Array(65).fill({ kind: "watch", titlePattern: "a" }) }));
});

test("padded native game titles classify without mistaking launchers or remote viewers for games", () => {
  assert.equal(classifyCompanionScene(observe("HTGame.exe", "异环  "), rules), "play");
  assert.equal(classifyCompanionScene(observe("unknown.exe", "  原神  "), rules), "play");
  assert.equal(classifyCompanionScene(observe("GameViewer.exe", "Remote desktop"), rules), "uncertain");
  assert.equal(classifyCompanionScene(observe("HTGameLauncher.exe", "Launcher"), rules), "uncertain");
});
