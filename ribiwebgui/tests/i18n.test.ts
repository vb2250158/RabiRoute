import assert from "node:assert/strict";
import test from "node:test";
import { translateText } from "../src/i18n/index";

test("translates exact interface copy and preserves surrounding whitespace", () => {
  assert.equal(translateText("人格配置", "en"), "Persona configuration");
  assert.equal(translateText("语音服务", "en"), "Speech service");
  assert.equal(translateText("当前 Route 已订阅主机 ASR", "en"), "Current Route is subscribed to host ASR");
  assert.equal(translateText("没有 Route 订阅语音消息", "en"), "No Route subscribes to speech messages");
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
  assert.equal(translateText("默认 100 · 上限 200", "en"), "Default 100 · Maximum 200");
  assert.equal(translateText("常驻监听中 · 2 个 Route 已订阅", "en"), "Persistent listening · 2 Routes subscribed");
  assert.equal(
    translateText("0 表示不注入 语音消息端 历史；未单独设置时使用 100 条。", "en"),
    "0 disables Speech endpoint history injection; unset values use 100 messages."
  );
});

test("translates speech delivery and persona configuration copy", () => {
  assert.equal(translateText("热投递", "en"), "Hot delivery");
  assert.equal(
    translateText("开启（hot）：每段 ASR 立即投递。关闭（keyword）：未命中关键词时只记录，命中当前人格关键词时才投递。", "en"),
    "On (hot): deliver every ASR segment immediately. Off (keyword): record without waking when no keyword matches, and deliver only when a current-persona keyword matches."
  );
  assert.equal(translateText("语音唤醒关键词", "en"), "Speech wake-up keywords");
  assert.equal(translateText("最近消息上下文", "en"), "Recent message context");
  assert.equal(
    translateText("当前关键词为空：转写会继续记录，但不会唤醒 Agent。建议至少加入人格名和常用称呼。", "en"),
    "The keyword list is empty: transcripts will still be recorded, but the Agent will not wake. Add at least the persona name and common forms of address."
  );
  assert.equal(
    translateText("Speaker 1 / Speaker 2 只是当前会话里的分段标签，不是生物声纹身份。", "en"),
    "Speaker 1 / Speaker 2 are diarization labels within the current session, not biometric voice identities."
  );
  assert.equal(
    translateText("自动声纹识别不可用", "en"),
    "Automatic voiceprint recognition unavailable"
  );
  assert.equal(
    translateText("已删除说话人资料，并解除 3 条绑定。", "en"),
    "Speaker profile deleted and 3 bindings removed."
  );
  assert.equal(translateText("说话人 / 声纹设置", "en"), "Speaker / voiceprint settings");
  assert.equal(
    translateText("已看到 18 句话 · 预览最近 10 句", "en"),
    "18 utterances found · previewing the latest 10"
  );
  assert.equal(
    translateText("2 个会话 · 27 句话 · 预览最近 10 句", "en"),
    "2 sessions · 27 utterances · previewing the latest 10"
  );
  assert.equal(translateText("相对缓存路径", "en"), "Relative cache path");
  assert.equal(translateText("缓存文件（旧记录）", "en"), "Cached file (legacy record)");
  assert.equal(translateText("预计过期时间", "en"), "Expected expiry");
  assert.equal(
    translateText("上方仅保留当前页面运行期的转写预览；下方读取按日期持久化的最近 ASR/TTS 双向记录。", "en"),
    "The preview above is limited to the current page session; the section below reads recent persistent bidirectional ASR/TTS records stored by date."
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
