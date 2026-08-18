import assert from "node:assert/strict";
import test from "node:test";
import { translateText } from "../src/i18n/index";

test("translates performance monitoring copy and dynamic counters", () => {
  assert.equal(translateText("性能监控", "en"), "Performance monitor");
  assert.equal(translateText("开启性能记录", "en"), "Enable performance recording");
  assert.equal(translateText("最近慢操作", "en"), "Recent slow operations");
  assert.equal(translateText("每 10 秒一个图表点", "en"), "One chart point every 10 seconds");
  assert.equal(translateText("4 个文件 · 120 条内存记录", "en"), "4 files · 120 in-memory records");
});
