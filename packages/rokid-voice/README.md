[English](README_en.md) | 简体中文

# Rokid 语音共享包

`@rabilink/rokid-voice` 是 RabiLink 与 DSH 眼镜入口共用的语音基础包，当前为本地开发版，尚未发布或接入 DSH 真机。RabiLink 已通过应用内薄入口引用此处的唯一实现；打包时由 esbuild 内联，不要求 QuickJS 加载 npm。

## 已提取的接口

- `@rabilink/rokid-voice/task-input-handoff` 在 `0.3.0` 提供 `createTaskInputHandoffBuffer`，复用任务停顿归并，并在异步持久写入期间拥有冻结的输入批次。

### 异步持久交接

```js
import { createTaskInputHandoffBuffer } from '@rabilink/rokid-voice/task-input-handoff';
const input = createTaskInputHandoffBuffer({
  scope: JSON.stringify([backend, hostId, connectionGeneration, taskId]),
  createHandoffId: () => secureUniqueId(),
  retain: value => taskDraftStore.retain(value),
  onSettled: result => updateDraftStatus(result),
  onInterrupt: () => stopOwnedPlayback()
});
// 接入原 speechStart/speechEnd/interim/final 事件。
const result = await input.flush();
const leaving = input.dispose();
// leaving.draft 是尚未归并交接的原文。
// leaving.handoffs 保存交接 ID、原 packet 及仍可等待的 completion。
```

调用方提供唯一 `handoffId` 生成器，以及按 `{handoffId,scope,text}` 幂等保存的 `retain()`。持久写入成功须返回 `{status:'retained',handoffId}`。待写入批次独立保留，新语音继续在原归并器收集。默认最多保留 32 个未确认交接，可配置 1–256，达到容量后新批次留在归并器。失败或 ID 不匹配返回 `unconfirmed` 并保留原文，只在显式 `retryHandoff(id)` 时使用原 ID 再次请求保存。正在写入时的重试返回原 Promise。

`dispose()` 交还未交接草稿及所有未确认批次，迟到写入仍绑定原 scope，完成后仅结算原 Promise。关闭后停止界面回调。接收方必须检查原账户、Host、连接代次和任务权限。恢复原作用域时可 `restoreHandoff({handoffId,packet})`，随后显式重试。接收方负责跨重启幂等、冲突拒绝和最终持久归属。未取得 `retained` 的内容仍需作为未保存输入保留，进程终止前的持久保障取决于存储是否实际完成。

原 `createTaskUtteranceBuffer.onReady` 保留同步 boolean 合同，异步路径通过此交接入口接入。`0.3.0` 保留最终转写内部及首尾空白、换行，仅用 `trim()` 判断空输入。批次仍以一个空格连接不同识别片段，旧版已归一化的草稿可继续恢复。模型或 ASR 已经改写的格式无法由这一层还原。

- `@rabilink/rokid-voice/runtime`：`createAiuiAsrInputAdapter`、`createAiuiTtsOutputAdapter`、`VoiceRuntimeError` 和 `AIUI_NATIVE_VOICE_MODE`。由调用者注入真实 AIUI `SpeechRecognition`、可选 `SpeechRecognitionSession`、`speechSynthesis`、`SpeechSynthesisUtterance` 和 `SpeechAudioPlayer`。ASR 按宿主能力协商临时结果，停止后的异步能力结果不能重启识别；TTS 使用独立合成任务及可停止播放器。
- `@rabilink/rokid-voice/transcript-policy`：转写归一化、文本指纹、相似度和 `createTranscriptPolicy`。有限窗口内过滤重复及疑似回声；文本相似度不是声学消回声，也不能证明说话人身份。
- `@rabilink/rokid-voice/task-input`：`createTaskUtteranceBuffer` 与 TypeScript 合同。只在已打开的任务内归并最终转写，不承担工具调用、任务状态或手机设置持久化。

没有网络依赖、API Key、任务投递、存储或 UI 依赖。Android CXR-L 的音频采集接口不等于 AIUI 的识别接口；React Native 端必须提供经过核实的宿主桥接，不能直接传入 CXR-L 对象冒充同一合同。

## 两端共同的交互目标

`0.1.1` 的 `createRound({ onSpeechStart })` 转发宿主 `speechstart`，可在文字返回前停播；它不代表识别启动，也不携带完整输入。调用者核对当前轮次和页面生命周期，再停止自己拥有的播放器，保留模型与后台任务。没有文字时无法应用文本回声过滤，宿主 VAD/AEC 和误触发率必须真机验证。

主链使用 Rokid ASR/TTS。参考 Codex 边说话边工作的体验：在用户启用且宿主允许的前台语音会话内，播报、推理和工具执行不能阻止用户输入。插话及时停止当前播报；后台任务保持原身份、状态和真实回执，只有明确的停止任务意图才进入后端取消流程。字幕、已播放音频和任务结果分别管理，不强制继续播放被打断回复的文字。

`0.2.0` 已提取任务内停顿归并，默认 5 秒，调用方可传入手机设置的 0–60000 毫秒整数；变更作用于下一段。它控制何时把完整输入交给上层队列，不延迟插话停播。任务外助手对话不套用此规则，模型忙也不等于任务视图已打开。Rabi 当前没有独立任务视图，因此尚未启用归并；DSH 消费接入与手机设置界面另行验收。退出任务视图不代表取消任务，本包不宣称提供完整全双工协调器。

### 任务输入接入

```js
import { createTaskUtteranceBuffer } from '@rabilink/rokid-voice/task-input';
const input = createTaskUtteranceBuffer({
  scope: JSON.stringify([backendId, hostId, connectionGeneration, taskId]),
  silenceMs: phoneSettings.taskSilenceMs ?? 5000,
  onInterrupt: () => stopOwnedPlayback(),
  onReady: packet => taskInputQueue.tryAccept(packet) // 同步 boolean，只确认队列接收
});
const round = asr.createRound({
  continuous: true,
  onSpeechStart: () => input.speechStart(),
  onSpeechEnd: () => input.speechEnd(),
  onInterim: result => input.interim(result.text),
  onFinal: result => {
    const accepted = input.final(result);
    if (!accepted.accepted) retainUnacceptedSegment(result, accepted.reason);
  }
});
```

以上回调还须经过当前识别轮核验和现有回声过滤。`onSpeechEnd` 转发官方 `speechend`，停止后的旧识别轮不会转发起止边界；每轮绑定捕获同一个 `input`，不能通过全局变量把旧轮结果送给新任务。`speechStart` 立即调用停播回调，`speechEnd` 与最终结果齐备后开始等待；新的开口/临时结果取消旧定时器。最终结果晚到后重新等待完整间隔；临时文字永不派发。

- 每段捕获当时的停顿设置，`configure({silenceMs})` 不缩短当前段。每段最多 64 个最终结果、16000 字符；最近 128 个 `resultId` 去重，重用 ID 但文字变化明确报错。超限保留已收内容并停止自动提交；调用者保留被拒绝部分，不能丢掉后半句后继续执行前半句。
- `onReady` 必须同步返回 boolean；异步函数不符合合同。它只表示上层队列是否接管输入，不能直接当成后端请求或成功回执。返回 false、抛错或误返 Promise 时保留草稿且不自动重试；上层持有实际投递 ID、幂等和回执。`flush()` 是显式提交/重试，讲话或存在未确认临时文字时拒绝。
- 退出、换任务、换 Host/连接代次、关麦或识别失败/结束时，调用 `dispose()`，取得尚未交付的最终文字草稿；旧事件和旧定时器不再发送，也不取消后台任务。临时文字不是草稿中的已确认内容，界面应提示识别中断而不是自动发送不完整命令。
- 草稿持久化由调用方拥有。仅同一 scope 的新实例可 `restoreDraft(packet)`，恢复不启动定时器；用户明确选择后才 `resumeDraft()` 或 `flush()`。新 Host/连接代次或新任务不能静默继承旧草稿。需要改投目标时交给用户明确审阅的新输入流程。
- `peek()` 和 `getState()` 提供未提交文本和收集状态；本地队列接收与 Host 的 accepted/running/completed 是不同证据。ASR 不提供可靠 speechstart/speechend 时不能声称测到了真实停顿；真机须验证事件与收音行为。

Rabi 保留自己的 Manager 身份、权限、幂等和任务适配；DSH 保留 Remote 连接、会话、队列和审批适配。不得为共享语音逻辑统一或复制两端凭据，不重写现有 P2P/Relay 协议。

## 验证与后续接入

### 共用助手循环与待实现部分

模型决策协议与串行工具循环现已提取到 [`@rabilink/assistant-runtime`](../assistant-runtime/README.md)，Rabi 页面已使用统一会话。`rabi_api_call` 写入分类和 Rabi 回执字段留在 Rabi 工具适配器中；DSH 已完成开发包与自己的工具适配器夹具集成。真实设备链路、任务跟进和通知仍待实现。

- Profile 提供提示词与工具声明；工具适配器提供操作分类、执行和回执规范化。共享循环拥有串行模型请求、turn/request/call 身份、超时和引导；后端保留权限与幂等核验。
- 后台任务接口需提供提交、引导、显式取消、状态跟随及固定目标的任务引用。长任务返回真实受理回执后继续跟进，分别表达受理、运行、完成、失败、待用户输入与结果未知。
- 前台对话与后台工作各自管理生命周期；插话停声、退出任务视图、触摸关麦都不隐式取消后台任务。DSH 保留 Harness queue / Codex turn/steer，Rabi 保留目标电脑和真实投递回执。
- 通知按后端事件 ID/水位去重、断线补偿并保留来源任务。模型摘要不替代完成事实；播报结束不证明用户已听到。缺少跨任务事件源时明确覆盖范围。
- 按[主动智能设计](../../主动智能设计思路.md)，同一循环接收用户表达、工具结果和已授权情境事件，恢复带来源与有效期的上下文，形成并核实意图假设，判断参与方式、行动并验证跟进。不能把主动参与简化成语音关键词路由，也不能以模型推测代替事实、权限或记忆写入。

当前循环仍在工具返回后才消费引导，尚不能保证长任务运行时立即交谈。跨任务通知和独立后台协调尚未实现；本包只提供已列出的语音基础与任务输入归并。

`npm test` 覆盖 12 项归并行为、取消与恢复竞争；`node <仓库根>/node_modules/typescript/bin/tsc -p test/tsconfig.json` 验证严格类型消费。AIUI `check:agent` 已纳入共享测试。尚无两端手机设置与真机任务输入的验收证据。

在 `apps/rabilink-aiui` 运行 `node scripts/Smoke-RabiLinkVoiceRuntime.mjs`、`node scripts/Smoke-RabiLinkTranscriptPolicy.mjs`、`node scripts/Test-AiuiNativeVoiceContract.mjs` 和 `node scripts/Smoke-RabiLinkAiuiRuntime.mjs`。这些验证共享代码及页面合同，不能证明眼镜声学效果。正式接入仍需实际 Ink、设备连续采集/播放、插话延迟、回声、断连和第二轮对话验收。

可通过 `npm pack` 生成仅含本包文件的开发快照供另一工作区验证；发布、正式安装与依赖锁定分别处理，禁止复制源文件形成另一维护副本。

参考：[Rokid 官方 AIUI Skill](https://github.com/yodaos-project/AIUI/tree/00c6ec71ee313817705683248b3ebe2acf0937f0/skills/aiui-dev)、[OpenAI 语音架构](https://developers.openai.com/api/docs/guides/voice-agents)、[语音会话与任务状态分离](https://developers.openai.com/api/docs/guides/live-conversations)。后两项仅为交互设计参考，不引入 OpenAI 语音依赖，也不证明 Codex 的内部实现。
