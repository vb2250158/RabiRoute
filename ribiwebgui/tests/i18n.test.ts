import assert from "node:assert/strict";
import test from "node:test";
import { translateText } from "../src/i18n/index";

test("translates exact interface copy and preserves surrounding whitespace", () => {
  assert.equal(translateText("人格配置", "en"), "Persona configuration");
  assert.equal(translateText("语音服务", "en"), "Speech service");
  assert.equal(translateText("目标测试机报告", "en"), "Target-machine report");
  assert.equal(translateText("启动时预热", "en"), "Warm up at startup");
  assert.equal(translateText("  保存配置  ", "en"), "  Save configuration  ");
});

test("translates dynamic counts and adapter summaries", () => {
  assert.equal(translateText("8 条模板", "en"), "8 templates");
  assert.equal(
    translateText("main · NapCat / OneBot + 定时触发", "en"),
    "main · NapCat / OneBot + Heartbeat"
  );
  assert.equal(
    translateText("RabiLink · 角色面板 + RabiLink / Relay 直连", "en"),
    "RabiLink · Role panel + RabiLink / Relay"
  );
});

test("translates rule metadata while preserving configured names and regex", () => {
  assert.equal(
    translateText("群聊-普通消息 · 匹配：Rabi|RabiRoute|看板娘", "en"),
    "Group: ordinary message · Match: Rabi|RabiRoute|看板娘"
  );
  assert.equal(
    translateText("定时触发 / rabi-heartbeat", "en"),
    "Heartbeat / rabi-heartbeat"
  );
  assert.equal(translateText("Rabi 看板娘呼唤", "en"), "Rabi 看板娘呼唤");
});

test("translates dynamic diagnostic copy without changing runtime values", () => {
  assert.equal(
    translateText("http://127.0.0.1:8794/rabilink · 未响应", "en"),
    "http://127.0.0.1:8794/rabilink · unreachable"
  );
  assert.equal(
    translateText("已触发「Rabi 看板娘成长自检」，请在最近日志和通知数里确认投递结果。", "en"),
    "Triggered “Rabi 看板娘成长自检”. Check Recent logs and Delivery count for the result."
  );
});

test("leaves unknown user data and Chinese locale text unchanged", () => {
  assert.equal(translateText("QQ 消息监听", "en"), "QQ 消息监听");
  assert.equal(translateText("人格配置", "zh-CN"), "人格配置");
});
