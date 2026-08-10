import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { NodeTypes, parse as parseTemplate } from "@vue/compiler-dom";
import * as ts from "typescript";
import { translateText } from "../src/i18n/index";

test("translates exact interface copy and preserves surrounding whitespace", () => {
  assert.equal(translateText("人格配置", "en"), "Persona configuration");
  assert.equal(translateText("语音服务", "en"), "Speech service");
  assert.equal(translateText("当前 Route 已订阅主机 ASR", "en"), "Current Route is subscribed to host ASR");
  assert.equal(translateText("没有 Route 订阅语音消息", "en"), "No Route subscribes to speech messages");
  assert.equal(translateText("目标测试机报告", "en"), "Target-machine report");
  assert.equal(translateText("启动时预热", "en"), "Warm up at startup");
  assert.equal(translateText("计划审批", "en"), "Plan approval");
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
  assert.equal(translateText("默认 12 · 上限 200", "en"), "Default 12 · Maximum 200");
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
  assert.equal(translateText("人格声纹归类", "en"), "Persona voiceprint classification");
  assert.equal(translateText("多电脑人格同步", "en"), "Multi-PC persona sync");
  assert.equal(translateText("同步当前人格", "en"), "Sync current persona");
  assert.equal(translateText("确认文件冲突", "en"), "Confirm file conflict");
  assert.equal(translateText("自动对账已完成", "en"), "Automatic reconciliation complete");
  assert.equal(translateText("12 个变化 · 2 个冲突", "en"), "12 changes · 2 conflicts");
  assert.equal(
    translateText("自动对账保留了待同步标记，将在连接事件或有界重试时继续：temporary failure", "en"),
    "Automatic reconciliation retained its pending marker and will continue on a connection event or bounded retry: temporary failure"
  );
  assert.equal(translateText("这是我", "en"), "This is me");
  assert.equal(translateText("清除判断", "en"), "Clear decision");
  assert.equal(translateText("12 个分段", "en"), "12 segments");
  assert.equal(translateText("标记下一段", "en"), "Mark the next recording");
  assert.equal(translateText("已找到 2 个本次候选", "en"), "2 candidates found for this attempt");
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

test("translates Codex Hook management copy", () => {
  assert.equal(translateText("Hook 管理", "en"), "Hook management");
  assert.equal(translateText("会话入口上下文", "en"), "Task-entry context");
  assert.equal(translateText("推理期上下文刷新", "en"), "Reasoning-time context refresh");
  assert.equal(translateText("计划任务会话完成通知", "en"), "Plan-task completion notification");
  assert.equal(
    translateText("；默认开启。", "en"),
    "; enabled by default."
  );
});

test("translates primary Agent selection copy", () => {
  assert.equal(translateText("主控 Agent", "en"), "Primary Agent");
  assert.equal(
    translateText("命中规则的消息只投递给主控 Agent；其他 Agent 保留配置，不会收到默认消息。", "en"),
    "Messages that match a rule are delivered only to the Primary Agent. Other Agent configurations remain available but do not receive default deliveries."
  );
});

test("translates Quick setup copy across all three steps", () => {
  const copy = new Map<string, string>([
    ["可以组合多个入口；单个入口可在消息适配器页继续停用或调整权限。", "You can combine multiple inputs. Disable an individual input or adjust its permissions later on the Message adapters page."],
    ["QQ 群聊、私聊实时入口", "Real-time QQ group and private messages"],
    ["企业微信群聊双向入口", "Two-way WeCom group messages"],
    ["下游 Agent 设备入口，支持局域网发现和任务投递", "Downstream Agent device input with LAN discovery and task delivery"],
    ["桌面语音笔记转写入口", "Desktop voice-note transcription input"],
    ["小爱音箱语音转写入口", "XiaoAI speaker transcription input"],
    ["眼镜是消息来源；系统内置 RabiLink 负责转接", "Glasses are the message source; the built-in RabiLink service handles forwarding"],
    ["保存后可在运行日志里手动触发一次，用来验证 Agent 端是否能收到心跳。", "After saving, trigger one heartbeat from Runtime logs to verify that the Agent receives it."],
    ["远端 Agent 是下游 Agent 设备入口；远端设备只运行独立 bridge，无人值守等待 RabiGUI 扫描。保存后在“消息适配器”页扫描局域网，选择设备并输入密码连接。", "Remote Agent is an input for downstream Agent devices. The remote device runs only the standalone bridge and waits unattended for RabiGUI discovery. After saving, scan the LAN on Message adapters, select the device, and enter its password."],
    ["快速配置只绑定一个 Agent；先确定处理端和项目目录，再选择会话。", "Quick setup binds one Agent. Choose the handler and project directory first, then select a task."],
    ["Codex/ChatGPT Desktop 是真实消息的唯一 owner。RabiRoute 读取 Desktop 可见任务目录并通过 Desktop IPC 投递；Codex CLI 是独立 Runtime，不作为 Desktop 投递的备用路径。", "Codex/ChatGPT Desktop is the sole owner of real messages. RabiRoute reads Desktop-visible tasks and delivers through Desktop IPC. Codex CLI is a separate runtime and is not a fallback for Desktop delivery."],
    ["人格可选与配置确认", "Optional persona and configuration review"],
    ["不配置人格时，只按消息入口默认模板把来源和回传 API 投递给 Agent。", "Without a persona, the default input template sends only the source and send API to the Agent."],
    ["会话名 + 最后会话时间", "Task name + last activity"],
    ["选择已有会话，或输入新会话名", "Select an existing task or enter a new task name"]
  ]);

  for (const [source, expected] of copy) {
    assert.equal(translateText(source, "en"), expected, source);
  }
  assert.equal(translateText("人格 ID · XinghaiBuilder", "en"), "Persona ID · XinghaiBuilder");
  assert.equal(translateText("自动：RabiRoute", "en"), "Automatic: RabiRoute");
  assert.equal(translateText("已复制 RabiLink 回调地址", "en"), "RabiLink callback URL copied");
});

test("Quick setup has no untranslated static component copy", () => {
  const filename = new URL("../src/components/QuickSetupDialog.vue", import.meta.url);
  const source = fs.readFileSync(filename, "utf8");
  const { descriptor } = parseSfc(source, { filename: filename.pathname });
  assert.ok(descriptor.template, "QuickSetupDialog.vue should contain a template");
  const template = parseTemplate(descriptor.template.content);
  const untranslated: string[] = [];
  const inspect = (value: string): void => {
    const normalized = value.trim();
    if (/[\u3400-\u9fff]/u.test(normalized) && translateText(normalized, "en") === normalized) {
      untranslated.push(normalized);
    }
  };
  const walk = (node: any): void => {
    if (node.type === NodeTypes.TEXT) inspect(node.content);
    if (node.type === NodeTypes.ELEMENT) {
      for (const prop of node.props) {
        if (prop.type === NodeTypes.ATTRIBUTE && prop.value) inspect(prop.value.content);
      }
    }
    if (node.children) for (const child of node.children) walk(child);
    if (node.branches) for (const branch of node.branches) walk(branch);
  };
  walk(template);

  assert.ok(descriptor.scriptSetup, "QuickSetupDialog.vue should contain script setup");
  const script = ts.createSourceFile(
    filename.pathname,
    descriptor.scriptSetup.content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const walkScript = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) inspect(node.text);
    ts.forEachChild(node, walkScript);
  };
  walkScript(script);

  assert.deepEqual(untranslated, []);
});

test("translates plan directory and step-local approval copy", () => {
  assert.equal(translateText("计划描述", "en"), "Plan description");
  assert.equal(translateText("计划附件", "en"), "Plan attachments");
  assert.equal(translateText("审批意见记录", "en"), "Approval feedback history");
  assert.equal(translateText("点击查看大图", "en"), "Click to enlarge");
  assert.equal(translateText("点击预览视频", "en"), "Click to preview video");
  assert.equal(translateText("图片预览", "en"), "Image preview");
  assert.equal(translateText("视频预览", "en"), "Video preview");
  assert.equal(translateText("预览 Markdown", "en"), "Preview Markdown");
  assert.equal(translateText("Markdown 预览", "en"), "Markdown preview");
  assert.equal(translateText("下载原文件", "en"), "Download source");
  assert.equal(translateText("计划目录", "en"), "Plan directory");
  assert.equal(translateText("点击计划快速跳转", "en"), "Select a plan to jump");
  assert.equal(translateText("当前结果", "en"), "Current results");
  assert.equal(translateText("状态排序", "en"), "Status order");
  assert.equal(translateText("时间排序", "en"), "Update time");
  assert.equal(translateText("筛选状态", "en"), "Filter statuses");
  assert.equal(
    translateText("点击完成后更新目录和计划卡片", "en"),
    "Select Done to update the directory and plan cards"
  );
  assert.equal(
    translateText("复制失败：当前浏览器不允许自动复制，请手动选择文本复制。", "en"),
    "Copy failed: This browser does not allow automatic copying. Select and copy the text manually."
  );
  assert.equal(translateText("计划项", "en"), "Plan item");
  assert.equal(translateText("步骤进度", "en"), "Step progress");
  assert.equal(translateText("执行计划", "en"), "Execution plan");
  assert.equal(translateText("正在执行", "en"), "Executing");
  assert.equal(translateText("等待 QA 验收", "en"), "Awaiting QA acceptance");
  assert.equal(
    translateText("核对本步骤的执行边界后提交审批意见", "en"),
    "Review this step's execution boundaries before submitting approval feedback"
  );
  assert.equal(
    translateText("输入 @ 可引用计划附件；Enter 直接提交，Shift+Enter 换行。提交后由 Agent 判断如何处理，不会直接改变计划状态。", "en"),
    "Type @ to reference a plan attachment. Press Enter to submit or Shift+Enter for a new line. The Agent decides how to handle the feedback; submitting it does not directly change plan status."
  );
  assert.equal(
    translateText("当前不能正式批准；可提交补充资料或调整建议，输入 @ 可引用计划附件。Enter 提交，Shift+Enter 换行。", "en"),
    "Formal approval is unavailable. Add missing details or request changes, or type @ to reference a plan attachment. Press Enter to submit or Shift+Enter for a new line."
  );
  assert.equal(translateText("添加附件", "en"), "Add attachments");
  assert.equal(
    translateText("支持选择文件，也可以在输入框中按 Ctrl+V 粘贴图片。", "en"),
    "Choose files, or press Ctrl+V in the feedback field to paste an image."
  );
  assert.equal(
    translateText("上一条意见已记录，正在通知 Agent；你可以继续编辑下一条，通知完成后即可提交。", "en"),
    "The previous feedback was recorded and is being delivered to the Agent. You can edit the next message now and submit it after delivery finishes."
  );
  assert.equal(
    translateText("当前没有可投递的 Route；你可以先编辑，选择或绑定 Route 后再提交。", "en"),
    "No Route is available for delivery. You can keep editing and submit after selecting or binding a Route."
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
  assert.equal(
    translateText("已接受「Rabi 看板娘成长自检」，正在后台投递；请在最近日志中确认最终结果。", "en"),
    "Accepted “Rabi 看板娘成长自检”. Delivery continues in the background; check Recent logs for the final result."
  );
  assert.equal(
    translateText("「Rabi 看板娘成长自检」已经在后台投递中，没有重复启动；请在最近日志中确认最终结果。", "en"),
    "“Rabi 看板娘成长自检” is already being delivered in the background, so no duplicate was started. Check Recent logs for the final result."
  );
});

test("leaves unknown user data and Chinese locale text unchanged", () => {
  assert.equal(translateText("QQ 消息监听", "en"), "QQ 消息监听");
  assert.equal(translateText("人格配置", "zh-CN"), "人格配置");
});
