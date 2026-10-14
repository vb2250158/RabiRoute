import assert from "node:assert/strict";
import test from "node:test";
import { desktopPetActions } from "../src/desktopPetActions";
import type { DesktopPetAnimation } from "../src/desktopPetClient";

test("custom actions use manifest triggers and single PNG images are counted separately", () => {
  const image: DesktopPetAnimation = { type: "png-sequence", assets: ["/frame.png"], fps: 12, loop: true };
  const result = desktopPetActions({ id: "sample", name: "Sample", personaId: "sample", states: {
    idle: image, nap: image, stretch: { ...image, assets: ["/1.png", "/2.png"], loop: false, next: "idle" },
    thinking: { type: "gif", assets: ["/thinking.gif"], fps: 12, loop: true },
    success: image, attention: image
  }, idleBehavior: { sleepState: "nap", randomStates: ["stretch"] } });
  assert.equal(result.length, 6);
  assert.equal(result.filter(item => item.staticImage).length, 4);
  assert.equal(result.find(item => item.id === "nap")?.group, "待机与休眠");
  assert.equal(result.find(item => item.id === "stretch")?.group, "空闲随机动作");
  assert.deepEqual(result.find(item => item.id === "thinking")?.uses, ["手动播放"]);
  assert.equal(result.find(item => item.id === "success")?.group, "任务与连接反馈");
  assert.equal(result.find(item => item.id === "attention")?.group, "鼠标交互");
});

test("mode gestures are described from the manifest pools and run has a motion use", () => {
  const loop: DesktopPetAnimation = { type: "png-sequence", assets: ["/frame.png"], fps: 12, loop: true };
  const result = desktopPetActions({ id: "sample", name: "Sample", personaId: "sample", states: {
    idle: loop, desk: loop, nod: { ...loop, loop: false, next: "desk" }, run: loop
  }, modeAnimationSets: { focus: { idleState: "desk", randomMinSeconds: 45, randomMaxSeconds: 120,
    randomStates: ["nod"], clickStates: ["nod"] } } });
  assert.equal(result.find(action => action.id === "desk")?.group, "陪伴模式动作");
  assert.deepEqual(result.find(action => action.id === "nod")?.uses, ["focus：随机动作", "focus：点击动作"]);
  assert.deepEqual(result.find(action => action.id === "run")?.uses, ["较远距离移动时奔跑"]);
});
