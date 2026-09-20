import assert from "node:assert/strict";
import test from "node:test";
import { playbackOutputLabel, playbackOutputError } from "../src/speech/playbackPresentation";

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
