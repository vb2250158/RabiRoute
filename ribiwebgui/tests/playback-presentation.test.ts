import assert from "node:assert/strict";
import test from "node:test";
import { playbackOutputLabel, playbackOutputError } from "../../src/plugins/io.rabiroute.manager.speech/web/speech/playbackPresentation";

test("a disconnected remote selection stays remote and explains recovery", () => {
  const state = { source: "remote", selectedOnline: false } as const;
  assert.equal(playbackOutputLabel(state), "远端设备（已离线）");
  assert.match(playbackOutputError(state)!, /重新连接设备或切换到本机/);
});

test("local and connected remote output remain playable", () => {
  const local = { source: "local", selectedOnline: true } as const;
  const remote = { source: "remote", selectedOnline: true } as const;
  assert.equal(playbackOutputLabel(local), "本机");
  assert.equal(playbackOutputLabel(remote, "Room speaker"), "Room speaker");
  assert.equal(playbackOutputError(local), null);
  assert.equal(playbackOutputError(remote), null);
  assert.equal(playbackOutputLabel(null), "状态未知");
});

test("an unavailable saved selection is never described as local and offers selection recovery", () => {
  const state = { source: "unavailable", selectedOnline: false, selectionStorageError: "fixture storage error" } as const;
  assert.equal(playbackOutputLabel(state, "本机"), "请重新选择音频设备");
  assert.match(playbackOutputError(state)!, /重新选择设备/);
  assert.match(playbackOutputError(state)!, /原设置会保留备份/);
});
