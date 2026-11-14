[English](README_en.md) | 简体中文

# 共用助手执行循环

`@rabilink/assistant-runtime` 是本地开发包。RabiLink 页面使用这里的统一会话；DSH 已用开发快照与自己的工具适配器完成夹具集成，真实 Host 和眼镜链路仍待验证。它与 `@rabilink/rokid-voice` 分工：本包管理模型决策、工具观察与前台监听生命周期，语音包提供 Rokid ASR/TTS 适配。没有 API Key、网络请求、存储、UI 或后端 SDK 依赖。

## 接口与归属

### 设置页布局（0.12.1）

分类与保存栏固定，中间内容单独滚动。宽窗口采用双列参数，窄窗口自动改为单列；可搜索功能、统一显示参数名。未保存更改会在关闭时提示，成功保存后按钮停用。共享样式随 `./ui` 自动载入，仅作用于助手面板。

### 流式播报与共享设置页（0.12.0）

播报适配器可提供 `beginStream()`，同一回复的文本增量进入同一合成会话，取消后迟到的音频不会重新播放。可选 `./ui` 导出共享设置面板，通过宿主注入的 React 和状态/命令接口工作；核心循环没有 UI 依赖。

设置页按提供商、模型及音色能力生成参数分组，支持搜索、依赖状态、数值校验和模型独立配置。详细能力目录与请求编码归语音适配器，界面不凭模型名称推断支持范围。平台支持但适配器未接入的项目明确标注。当前共享回归 133 项通过；不代表所有供应商或硬件已验收。

### 当前前台生命周期（0.10.3）

新增 `voice.setOutputEnabled(boolean)` 与构造选项 `outputEnabled`（默认 true），`getState()` 返回实际输出许可。关闭许可立即停止当前、排队和待合成音频，之后新到的回复也保持静音；现有及新建 response 的文字仍可 append/finish。恢复许可只允许新建回复播音，不补播静音期间的旧尾句，不打开麦克风，也不取消模型或已派发工具。

隐藏且任务继续时，宿主依次调用 `setOutputEnabled(false)`、`pauseListening()`；重新显示按用户播音偏好恢复输出许可，只有明确点击/唤醒才 `activate()`。`isActive` 应检查真实 owner 的有效性，不用视图可见性阻断后台文字。已有 `suspend()` 仍是硬停用并退役回复 token，不能用于需要继续接收文字的隐藏流程。原生 Session 的持久消息、输入提交回执与重建仍归产品适配器，不能把 SDK 内存文字当正式存档。

当前 116 项共享回归及严格 TypeScript 消费检查通过；其中同一组隐藏/恢复、待合成取消和迟到回调用例覆盖 AIUI 回调、浏览器音频事件和桌面队列回执三种适配夹具，并验证已受理的模型请求在隐藏后完成并保留文字。宿主接入、安装与真实麦克风/扬声器验收分别记录；夹具不能证明硬件声音效果。完整操作表见 [语音宿主合同](VOICE_HOST_CONTRACT.md)。

### 独立播报队列（0.9.0）

`@rabilink/assistant-runtime/playback` 导出 `createSpeechPlayback()`。Rabi 页面已迁移分句队列、合成/播放超时、canplay/首音频块启动、字幕归属和取消处理；旧队列、资源句柄和计时器实现已移除。传入 `runtime.tts` 时同时传入 `runtime.releaseSpeech`，由原资源拥有者完成一次清理。`cancel()` 清空尚未开始的句子，只释放当前合成和播放器；不会停止 ASR、模型或后台工具。原来的文本及任务回执仍归调用方。

```js
import { createSpeechPlayback } from '@rabilink/assistant-runtime/playback';
const playback = createSpeechPlayback({
  tts: runtime.tts, releaseSpeech: runtime.releaseSpeech,
  isActive: () => pageVisible && !destroyed,
  onEvent: event => updateSpeechView(event)
});
playback.speak('第一句', { voice: selectedVoice, volume: 1 });
playback.speak('第二句', { voice: selectedVoice, volume: 1 });
// Call from the owner's accepted speech-onset/interim/gesture handler:
playback.cancel();
// Dispose on unload; cancel on hide.
```

`speak()` 的 true 只表示接收，不代表已经播放或被听见。`synthesizing`、`play-requested`、`cue`、`ended`、`error`、`cancelled`、`idle`、`unavailable` 分别给表现层；只有原播放器 ended 才报告正常结束，合成完成和时间估算只调整失败监控。宿主 onCanplay 或首音频块之后才启动相应播放器；重复及迟到事件不能开启旧音频、覆盖新字幕或终止替代句子。音色、音量和 audio 选项在入队时快照。生命周期自己拥有 AbortSignal 和 cue 回调；使用 `cancel()` 和 `onEvent`。

源码 90 项共享测试和严格类型检查通过，新增 8 项覆盖队列选项、迟到事件、取消合成、隐藏、播放拒绝、超时、可重入清理，以及真实共享运行时内“模型继续工作、ASR 保留、语音资源只释放一次”的隔离回归。DSH 的 0.8.0 监听接入已回报隔离测试通过；0.9.0 播报接入和真实设备音频仍待验收。

### 前台监听生命周期（0.8.0）

`@rabilink/assistant-runtime/listening` 导出 `createListeningLifecycle()`，Rabi 页面已替换原本分散的启动、续听、空结束计数和启动超时实现。它接受 `runtime.asr` 或同合同的宿主适配器；直接从真实交互同步调用 `activate()`，权限仍由宿主校验。正常结束后延迟续听；默认 250ms、连续三次不足 1000ms 且没有结果时暂停、启动等待上限 15000ms，均可配置。Rabi 保留 220ms 的原续听间隔。

`canStart()` 只决定能否开始下一轮；模型忙时不能丢弃当前识别器的完整输入。`isActive()` 检查宿主可见性与生命期，隐藏后的迟到回调会释放捕获且不交付文字或 onset。页面仍须在 hide 调用 `pause()`、unload 调用 `dispose()`；此层不轮询可见性。`pause({graceful:true})` 先撤销回调归属再请求原生 stop，其结束转写不再交付。静音不制造最终文字，错误和权限拒绝不自动重试，旧轮回调与迟到启动失败不能影响替代轮。

```js
import { createListeningLifecycle } from '@rabilink/assistant-runtime/listening';
const listening = createListeningLifecycle({
  asr: runtime.asr,
  isActive: () => pageVisible && !destroyed,
  canStart: () => listeningDesired,
  onEvent: event => updateListeningView(event)
});
// In the real tap/wakeup callback, synchronously:
listening.activate({ handlers: { onFinal: result => acceptUserText(result.text) } });
// On hide/unload:
listening.pause();
listening.dispose();
```

该接口只收拢识别生命周期。分句播报队列仍由页面拥有；DSH 的 5 秒任务停顿、语音保存、scope/ID 和回执仍属于其适配器。82 项共享测试及严格类型通过，包括 10 项监听回归；Rabi 源码和指定 AIX 各 41 项页面语音合同通过。这些是软件与合成输入证据，不是麦克风、真实 TTS 或 DSH 安装验收。

### 结构化最终回复与全局格式（0.7.3）

真实 OpenAI 联测中，接口发现与只读调用成功后，模型把全局要求的前缀放在 final JSON 外，严格校验以 `framing` 拒绝。协议提示现在明确所有结构化回复的外层约束，补充完整 final 对象示例，并将全局格式放在对应的 say/text 字段内。全局提示原文及末尾位置不变；解析器不剥离对象外文字、不自动重放已执行工具。

同题复测完成 api.find、api.call 各一次，最终 text 保留全局前缀并准确返回随机计数和完整回执。这是 OpenAI 测试中间件与合成只读 HTTP 的一次实测，不保证任意模型稳定遵循，也不代表乐奇宿主或设备语音验收。

### 延后说明与插话诊断（0.7.2）

官方宿主在 `disposition: defer` 中附带 `text`，0.7.1 将其视为多余字段，导致输入未确认。0.7.2 明确允许可选、非空、最多 16000 字符的延后说明；解析后仍只返回 defer，不把说明当答案、完成回执或工具调用。其他字段、协议、请求和输入 ID 仍严格验证。

插话解析失败的回执可带 `protocolFailureReason`，只含固定原因代码，页面日志不包含原始回复。72 项共享测试、严格类型和 39 项实际 AIX 页面合同通过。官方 Studio 的真实乐奇模型诊断完成：原工具等待时回答带全局前缀的算术插话；第二条工具请求延后；原任务完成后再执行第二个工具，两个接口各一次、结果独立。工具后端与转写为模拟、记录存储为隔离内存，不能替代真实 PC、持久存储或声音验收。复现入口见 `apps/rabilink-aiui/docs/tool-wait-probe.md`。

### 按请求限定响应格式（0.7.1）

官方 Rokid 模型在普通首轮请求中返回了 `kind: interjection`，被严格校验拒绝。新增 `getAgentProtocolFailureReason(error)` 返回固定原因代码，区分封装、JSON 语法、协议/请求不匹配、错误类型及字段问题；不返回原始回复、字段名、参数或标识符。

插话 answer/defer 示例现在只由 `protocol.input()` 放入 `independent-input.responseFormats`，使用当前请求和输入的实际 ID。系统提示按当前消息选择格式，历史专用格式不延续到下一轮。解析与工具权限保持严格，格式错误不自动重放。71 项共享测试及类型检查通过；官方模拟器同题从 `unexpected-interjection` 恢复为“记住了”，追问正确返回口令，第三轮本地工具派发被宿主接受。真实工具等待中的插话、声音、设备和 DSH 运行验收仍待完成。

### 逐条插话归属（0.7.0）

独立输入使用 `conversation.interject({id, scope, text}, {assertCurrent})`。先检查 `supportsInterjectionReceipts === true`，原 `run()` 传入相同 `inputScope` 并开启 `limits.interjectWhileWaiting`。scope 是适配器捕获的原任务绑定（backend、Host、连接代际、sessionId 等），不能替换为较宽的助手通知 scope。没有活跃用户工具等待、范围不符、旧协议缺少解析器或关闭时返回 `unavailable`，不排入隐藏队列。

每条 Promise 保留不可变原输入、`modelInvoked` 和恒为 false 的 `toolDispatched`：

| status | 含义 |
| --- | --- |
| `answered` | 模型明确生成该 inputId 的答案；仅此状态含 text。不证明已展示、播出、保存或工具任务完成。 |
| `deferred` | 模型明确延后或提出工具动作；只返回原输入，不执行或缓存提议的动作。 |
| `returned` | 已接收，但工具先结束、取消、预算耗尽或输入绑定失效；尚未向模型提交。 |
| `unavailable` | 本次未接收、未向模型提交，原输入仍由调用方保留。 |
| `unconfirmed` | 已提交但格式、连接、取消或身份核验未确认；保留原 reservation，不自动重放。 |

适配器先持久保留/预留输入。`deferred/returned/unavailable` 可在同一次既有 reservation 内，用原文本、原 turnId、原 inputScope 和 guard 排入 `conversation.run()` 重新决策；不得再次 retain/reserve 或生成新 ID。切换任务或退出后 guard 必须阻止执行及结算。`answered` 的持久处理回执与展示确认分别由适配器拥有，结算失败不能重生成或自动执行。崩溃恢复依赖适配器持久 reservation，本包不新增存储真源。

同一活跃 turn 内相同 scope/id/正文共享 Promise，不同正文报 `ASSISTANT_INTERJECTION_ID_CONFLICT`；最多保留 16 条含已结算输入，整轮结束释放。跨 turn、重建及重启去重由适配器负责。输入与 options 提交时快照，不受后续对象修改影响。

模型请求仍串行。独立回复使用 `interjection` JSON、原 requestId/inputId 与 `answer/defer`；普通最终文字不算消费确认。答案仅从独立 Promise 返回，不进入原 turn 的 onText、text、工具结果或聊天记录。原工具仍按原 callId 结算。网络/请求超时会停止失效的前台模型会话，不撤销已派发后端工作；该条记 unconfirmed，其余未提交输入返还。

70 项共享测试及严格类型检查通过，新增 16 项覆盖独立结果、重复/冲突 ID、延后重审、工具先返回、范围/视图切换、返还、断连、迟到结果及旧协议。Rabi 页面仍使用下述 0.6.0 文本引导入口，尚未迁移逐条回执；DSH 保持插话关闭，等待适配器接入与持久回执失败测试。软件合同不代表产品或真机验收。

### 工具等待期间接话（0.6.0）

设置 `limits.interjectWhileWaiting=true` 后，已派发工具等待回执期间可以由同一个宿主模型回答新输入。`session.guide(text)` 自动唤醒等待；使用外部 `takeGuidance` 队列的页面在入队后调用 `session.notifyGuidance()`。默认关闭，现有消费者保持原行为。Rabi 页面已启用；收音、停播及原工具归属不变。

插话使用 `user-interjection` 消息，仅报告原 callId、工具名及 `awaiting-receipt`，不制造受理或完成回执。每次插话回复完整校验后才展示，不能派发工具；模型返回工具动作时明确失败，原后台操作不撤销。所有模型请求仍串行；工具先完成时也要等正在生成的插话回复结束，再把真实结果交给模型继续。该路径计入原步骤数、模型与整轮超时，不新建模型或推理提供方。

54 项共享回归、严格类型检查及 35 项页面语音合同覆盖工具未完成时接话、原结果回传、模型不重叠、动作帧拒绝、取消及绑定切换。页面测试使用合成模型/语音资源，不证明实际 Rokid 模型遵循或眼镜声音。任务事件订阅、跨重启通知与实际长工具联调仍待完成。

### 语音输入优先（0.5.3）

AIUI 装配层以 `getState().inputPending` 和 `onInputStateChange(boolean)` 提供当前识别轮的输入占用状态。开口或中间文字占用，静音事件不等于最终转写：最终文字已交给调用方且用户停止说话后才释放；识别结束、错误、停止或销毁也释放。没有开口事件的宿主可由 interim/final 驱动。新建 conversation 继承当前状态，旧轮迟到事件不能清空新轮；持续监听但无人说话时不占用。若宿主既不返回最终结果也不结束识别，状态仍待确认，不能靠估时当作已完成。

共享 conversation 自动让后台观察等待，Rabi mailbox 也读取同一状态，让用户输入及排队引导先运行。这里不取消已派发工具或后台任务，也不新增 Rabi 任务订阅接口；实际回声、识别停顿和真机收音仍需验收。

### 全局提示保留（0.5.2）

动作协议和工具目录放在同一条初始 system 消息前部，调用方的全局提示原文放在末尾且仅保留一次；历史消息顺序不变。此顺序避免长协议紧随人格要求而使回答格式丢失，不改变 JSON 校验、工具权限或原回执语义。真实 OpenAI 中间件对照中，旧顺序漏掉回答前缀或把它放到 JSON 外；新顺序完成接口发现、调用、回执核对并保留最终回答前缀。测试只有合成数据，不能证明任意模型稳定遵循提示或乐奇真机验收。

### 按轮绑定检查（0.5.1）

处理固定任务的草稿前核对 `conversation.supportsTurnGuard === true`。0.5.1 将此能力绑定到注入会话的 `session.supportsTurnGuard === true`，混用旧会话时返回 false，并以 `ASSISTANT_TURN_GUARD_UNSUPPORTED` 拒绝带 guard 的 run。旧包会忽略未知的 run 选项，消费端须在能力缺失时停止提交。0.5.0 开发快照缺少混装检查，固定任务输入使用 0.5.1。

```js
if (conversation.supportsTurnGuard !== true) throw new Error('TURN_GUARD_REQUIRED');
const binding = captureOriginalTaskBinding();
await conversation.run(originalDraft, {
  assertCurrent() { assertTaskBindingCurrent(binding); }
});
```

`assertCurrent` 是同步、只读、成功返回 `undefined` 的检查。闭包捕获原任务、Host、账户和连接代际，失效时抛错。共享层在实际出队、模型创建及初始化后、每次模型请求和工具派发前复核；工具派发前的检查位于所有展示回调之后。异步或非 void 返回值以 `ASSISTANT_BINDING_CHECK_MUST_BE_SYNC` 拒绝。入队时复制选项与 limits，替换调用方选项里的函数不会改变已有轮次。

`conversation.run` 的执行错误携带 `originalInput`、`cause`、`code`，并沿用会话层未消费的 `pendingGuidance`。调用方保留原草稿和持久 turn 预留，核对原后端回执后决定后续操作。错误中原文的存在不表示之前没有派发操作。共享层不会自动重放，已经派发的工具继续按原拥有者结算。后端适配器还须在真实副作用前校验授权和固定目标，尤其是其内部有异步等待时。直接使用 session 或 turn 时也可注入 `assertCurrent`。

45 项共享测试及严格类型检查覆盖排队后切换任务、选项变更、初始化期间切换、迟到模型回复、展示回调中切换、已派发操作的原归属，以及异步检查拒绝、混装旧会话和原文返还。

### 前台对话与任务观察（0.4.0）

`0.4.1` 修复单独关闭协调器后，迟到 ASR 事件与收音清理调用已关闭协调器的问题。语音资源继续按自身生命周期释放，37 项共享测试覆盖该退出路径。

`createAssistantConversation` 从 `@rabilink/assistant-runtime/conversation` 导出。传入共享 `session`、固定连接 `scope` 和持久通知回执适配器 `receipts`。AIUI 装配层可在 `createSession()` 后调用 `runtime.createConversation({scope, receipts})`，自动将 speechstart/end 接到通知排队状态。创建后将该模型会话的调度交给 conversation，用户输入调用 `conversation.run()`，活跃用户轮的补充指令调用 `guide()`。变更连接作用域时释放原协调器并创建新的会话。

一个助手可观察同一权限域内的多个后台任务。`scope` 采用本地确认的账户、固定 Host 和助手 profile/权限域，任务切换时沿用此值。`id` 在该域内唯一，例如 `JSON.stringify([backend, workspaceId, sessionId, durableSeq])`。`body.task` 可携带原任务引用供呈现与摘要使用。适配器在送入观察前，按可信连接和本地权限核对每个任务及子 Agent 的可见范围。外层 `scope` 由该绑定构造，正文作为不可信事实处理。每个任务分别维护订阅与 checkpoint，通知确认采用助手 `scope` 加完整复合 `id`。改变旧任务级作用域时，适配器需明确迁移既有确认记录或选择恢复基线，保留原数据。

```js
const conversation = runtime.createConversation({
  scope: backendConnectionScope,
  receipts: {
    has: (scope, id) => notificationStore.hasAcknowledged(scope, id),
    acknowledge: (scope, id) => notificationStore.persistAcknowledgement(scope, id)
  }
});
await conversation.run(userText);
const update = await conversation.observe({
  id: backendEventId, scope: backendConnectionScope,
  kind: backendEventKind, status: backendReportedStatus, body: backendFacts
});
if (update.status === 'processed') {
  await showTaskUpdate(update.observation, update.result.text);
  await conversation.acknowledge(update.observation.id);
}
```

适配器提供有作用域的稳定事件 ID，并拥有正式任务状态、订阅恢复与持久通知确认。`has()` 返回布尔值，`acknowledge()` 只有持久写入确认后返回 `true`。共享层保留原 `kind/status`，任务事实以 `task-observation` 和 `untrusted:true` 交给同一模型。观察轮只能生成说明文字，工具执行被禁用。`processed` 表示文字生成完成，呈现完成后才由调用方请求确认。确认失败可重试 `acknowledge()`，同一实例保留已生成结果。

调度在轮次边界优先用户输入，讲话期间推迟尚未开始的观察。通知的存储查询独立进行，用户输入可继续。用户队列和观察记录各默认最多 32 项，可配置 1–256，满时明确拒绝并由调用方保留原始内容。通知回执操作默认超时 5 秒，可配置至 30 秒。取消、销毁及失败均结算原 Promise，后端持久任务继续由原适配器管理。已生成而尚未确认的观察占用记录容量，跨重启去重由持久 `has()` 提供。呈现与确认之间中断时，恢复可能再次呈现该事件，调用方应使用稳定 ID 更新已有通知。

后台接口返回真实 `accepted/running` 及任务引用后，前台可继续后续对话。当前模型请求与已分发工具仍等待本次结算，新用户输入可排队或引导用户轮。一个观察请求开始后，后来的用户输入会在其结束后优先处理。跨任务订阅、离线补齐与正式完成提醒 UI 仍由产品适配器接入。

### AIUI 页面装配入口（0.3.0）

`@rabilink/assistant-runtime/aiui` 导出 `createAiuiAssistantRuntime`。Rabi 页面已使用它管理原生语音资源和创建共享模型会话；DSH 可注入自己的 Profile、工具适配器和宿主。它不包含 Rabi 协议、HTTP 端点、凭据、UI 或服务商选择。

```js
import { createAiuiAssistantRuntime } from '@rabilink/assistant-runtime/aiui';
import { createAiuiAsrInputAdapter, createAiuiTtsOutputAdapter } from '@rabilink/rokid-voice/runtime';

const runtime = createAiuiAssistantRuntime({
  asr: createAiuiAsrInputAdapter({ SpeechRecognitionCtor: SpeechRecognition }),
  tts: createAiuiTtsOutputAdapter({ speechSynthesisApi: speechSynthesis,
    SpeechSynthesisUtteranceCtor: SpeechSynthesisUtterance, SpeechAudioPlayerCtor: SpeechAudioPlayer }),
  session: { profile, createModel, discoverTools },
  onCleanupError: reportResourceError
});
await runtime.session.ready();
// 在宿主支持的用户交互中开始；onFinal 按应用上下文选择普通对话或任务输入。
const round = runtime.asr.createRound({ continuous: true, interimResults: true, onFinal: acceptTranscript });
await runtime.asr.start(round);
// run()/guide()、全局提示词、接口发现与 pendingGuidance 沿用下方统一会话合同。
try {
  const result = await runtime.session.run(userText);
  retainOriginalScopeDraft(result.pendingGuidance || []);
} catch (error) {
  retainOriginalScopeDraft(error.pendingGuidance || []);
  throw error;
}
```

- 构造装配实例不启动录音、模型或网络。`ready()` 才准备模型与工具，`asr.start(round)` 必须由有效交互触发；宿主需提供真实能力和麦克风权限。`createModel` 仍由调用方做服务可用性检查，普通网页不会因为导入本包而获得 Rokid 服务。
- `runtime.asr` 与 `runtime.tts` 保持注入适配器的收音/合成用法；一次持有一个识别轮和一个合成/播报输出。新轮次屏蔽旧轮事件，开口事件立即停止持有的声音，不停止识别、不取消模型、不撤销后台任务。事件是否代表用户而非回声仍取决于宿主 VAD/AEC 与调用方过滤。
- `runtime.tts.synthesize()` 返回真实 `{task, player}`，不会自动播放。调用方按宿主 canplay/ended/error 事件启动播放、更新字幕与超时。自然播放结束调用 `releaseSpeech({task,player})`；主动取消使用 `releaseSpeech(...,{abort:true})` 或 `interruptSpeech()`。仍在合成时可把原合成 Promise 作为 `task` 交给 `releaseSpeech`。已释放资源再次交还不会重复释放，旧输出不能释放新输出。
- 取消合成会立即结束等待；迟到的任务和播放器会清理，旧字幕不会再交给 UI。清理尽力执行，`onCleanupError` 报告原生清理失败；不能把本地清理调用当作硬件已停止的证明。
- `suspendVoice()` 只释放语音，保留模型会话；隐藏页面时由调用方按产品行为决定是否还需结束模型。`dispose()` 永久关闭装配实例并释放当前模型与语音，不取消后端持久任务。取消/失败的 `run()` 仍须由原调用方接住 `pendingGuidance`。
- `createSession(options)` 验证新配置后替换旧客户端模型会话；迟到候选沿共享 session 的失效规则销毁。它不自动换语音来源。普通提示词更新用 `runtime.session.configure(profile)` 延后到轮次结算；切换 Host/任务前，调用方先结束旧输入作用域并保留原草稿，再明确更换连接，不能让旧引导流入新目标。
- 分句播报队列、任务停顿归并、回声文本过滤、字幕、持久草稿与后台状态仍由各自拥有者管理。此入口统一资源装配，不会把串行工具循环变成长任务期间的独立前台对话。

本包无第三方运行依赖。Rabi 构建器将 `src/aiui-runtime.js` 与 session/turn/protocol 一并打入 AIX；不能只上传源码模块给不支持本地 npm 解析的宿主。DSH 的本地固定快照可同样打包；公开分发和真机入口仍未完成。

### 统一会话入口（0.2.0）

从 `@rabilink/assistant-runtime/session` 调用 `createAssistantSession`。Rabi 页面已接入本入口，由页面传入设备 Profile 的全局提示词、宿主模型工厂和现有工具适配器；页面保留语音、HUD、聊天记录和生命周期管理。

```js
const assistant = createAssistantSession({
  profile: { systemPrompt: globalPrompt, modelOptions: {} },
  createModel: options => LanguageModel.create(options),
  discoverTools: async ({ profile, signal }) => ({
    tools: await adapter.discover({ profile, signal }),
    executeTool: event => adapter.execute(event),
    toolPolicy: adapter.policy,
    dispose: () => adapter.releaseClient()
  }),
  onText: ({ delta, text }) => present(delta, text)
});
await assistant.ready();
const result = await assistant.run(userText);
```

`discoverTools` 返回本次绑定目标的工具适配器；查接口、读合同及调用接口由其声明的工具提供，助手依据实际合同决定后续调用。它不能直接把未鉴权的远端工具声明当作已连接工具。`createModel` 使用宿主工厂，不选择 OpenAI 或其它替代服务。

全局提示词位于首条 system 消息，随后追加应用协议；Profile 可携带适配器所需的来源引用。初始化单次合并，默认限时 30 秒；发现失败明确报错，可重试，取消和超时后的迟到模型会销毁。会话连续多轮复用模型与工具绑定。

- `run(text, options?)` 执行一轮；忙时明确返回 `ASSISTANT_BUSY`，不启动第二个模型请求。可按轮传入 `turnId`、`limits`、`onText`、`onState` 和 `takeGuidance`，不改变会话的模型、协议与工具绑定。该轮回调替代默认回调，下一轮恢复默认；外部引导函数每次最多返回 16 条，内部 `guide` 队列优先在决策边界消费，两队列不拼成超限批次。
- `guide(text)` 将完整引导交给当前轮，返回是否接收。`idle`、`finishing` 或队列满时不谎报接收；调用方保留未接收输入，在当前 run 结束后作为下一轮提交。停声仍由独立语音模块立即处理。
- 终止类工具执行期间已接收但未消费的引导，由 `run()` 的可选 `pendingGuidance` 返还。调用方保存为原会话草稿，按用户下一步意图恢复；不要自动重新打开已退出视图、换目标发送或重放工具。`accepted` 表示排队接收，不代表模型已经处理。
- 从 `0.2.6` 起，取消和销毁也通过原 `run()` 的取消结果返还该队列；初始化超时、模型异常和轮次超时通过错误的 `pendingGuidance` 返还，同时保留 `code` 和原始 `cause`，不修改宿主错误。结果与异常是互斥的交还路径，不再另存一份自动重试队列。调用方必须等待并处理原 `run()` 的结算，即使视图已退出；保存失败仍保留草稿，不改绑到新目标。
- 返还范围只含本实例 `guide()` 队列中尚未交给单轮循环的文本，不含原始 `run(input)` 或外部 `takeGuidance()` 拥有的输入。已在决策边界取走的引导不代表已成功处理，原始输入及发送记录仍由调用方保存；不能用缺少 `pendingGuidance` 推断模型或工具未执行。
- `configure(profile)` 和 `refreshTools()` 在忙时延后，在当前轮结算后换配置；不中途更换已派发操作的目标。`applied` 只表示配置已采用，必须 `ready()` 成功才表示新模型与工具就绪。
- `cancel()` 结束本轮和当前客户端会话，可重新初始化；`dispose()` 永久释放该实例。两者不调用后端任务取消接口。适配器 `dispose`/`releaseClient` 仅释放客户端，持久操作与回执仍由后端拥有。
- `getState()` 提供本实例 closed/busy/ready/pendingConfiguration 和当前轮状态，不冒充后台任务状态。

### 低层协议与单轮执行

`@rabilink/assistant-runtime/protocol` 导出 `createAgentProtocol({ id, introduction, toolInstructions })` 与 `canonicalAgentIntent`。前者返回 `id`、`modelOptions(options, tools)`、`input(requestId, data)` 和 `parseDecision(raw, requestId)`。Profile 使用自己的提示词与工具声明，默认协议为 `assistant-agent/v1`；Rabi 适配器保留现有 `rabi-agent/v1`。应用身份字段不接受 data 覆盖。

`modelOptions` 保留原初始人格提示，追加应用动作协议，将原生模型 `tools` 置空，避免两条执行链。工具观察使用宿主支持的普通 user 消息，并标注不可信数据；不假设原生 tool role 或工具结果提交 API。

全局提示词继续约束用户可见的 `say`、`final.text` 和自然语言回复，但动作 JSON 外不能加人格前缀或其他文字。`0.2.4` 拒绝带前缀或围栏的应用动作帧，不会把它误当成任务完成；流式自然语言遇到可能的 JSON 后缀时暂存该部分，整条回复验证后才显示普通 JSON，错误动作内容不进入播报。普通文字仍流式显示。这能验证封装是否有效，不能保证模型完全遵循任意人格或格式指令。

`@rabilink/assistant-runtime/turn` 导出 `createAgentTurnRuntime`，需要注入：

| 参数 | 责任 |
| --- | --- |
| `model` | 已选定宿主会话，支持 promptStreaming 或 prompt；循环不选择或创建服务商模型 |
| `protocol` | 上述协议对象；与创建模型时使用的协议保持一致 |
| `tools` | 当前可用工具声明或名称；不代表后端授权 |
| `executeTool(event)` | 后端校验权限、固定目标、持久幂等与实际执行，返回原始回执 |
| `toolPolicy.classify(decision)` | 验证后端参数与操作，返回 `{ mutation: boolean }`；缺失或无效时不派发 |
| `toolPolicy.inspectOutcome(result, decision)` | 按后端合同返回布尔 `uncertain`、`failed`、`terminal`；缺失、异常或无效时结果为未知 |
| `turnId` | 应用范围内稳定标识；派生 requestId、callId，后端再绑定真实会话与操作标识 |
| `takeGuidance/onText/onState` | 从已有拥有者取引导，发布实际文字与循环状态；不承担持久化 |

返回对象提供 `run(input)`、`cancel()` 与 `getState()`。可调限制保持原实现：requestTimeoutMs 30000、turnTimeoutMs 180000、maxToolCalls 16、maxSteps 32。

共享循环保存原始 `observation.outcome`，并附加适配器核对后的 `outcomeStatus`。工具执行抛错、回执解析失败不会变成成功。相同写意图复用原观察；未知写入阻止后续写入，允许读回；被阻止的动作带 `dispatched:false` 和 `WRITE_RECONCILIATION_REQUIRED`。这只是单轮内防重复，不能替代后端持久幂等或跨轮对账。

`completed` 仅表示**本次助手循环结束**。后端回执为 accepted/running 时保持原状，不能把助手轮次结束说成后台任务完成。`cancel()` 停止本轮模型与展示，不会撤销已经派发的工具；后端任务取消须另走原授权接口。

## 通用语音交互入口（0.10.0）

0.10.1 在中断资源时先调用原生播放器的可选 `stop()`，再 `destroy()`，避免把释放对象等同于停止播放。开发包、源码与实际安装分别核验。

`@rabilink/assistant-runtime/voice` 的 `createVoiceInteraction` 统一收音、开口停播、流式切句和串行播放。眼镜、Web、DSH 与 Rabi 使用相同代码；GUI 和可选桌宠订阅事件，不创建第二份收音或模型。打断只停止 TTS，旧回复文字和已派发工作继续。人设、全局提示词、工具及持久输入由助手层持有，远端连接另由工具适配层提供。接口与验收边界见 [宿主合同](VOICE_HOST_CONTRACT.md)。当前测试为注入式宿主验证，实际接入与真机验收分别记录。

## Rabi 与 DSH 共同方向

两端是同一种助手机制，以人格、侧重点、工具与后端适配区分。Rabi 适配器在 `apps/rabilink-aiui/utils/rabi-agent-tool-policy.js`，保留公开 API、目标电脑、权限与回执语义；DSH 需提供自己的 queue/turn-steer、会话绑定、审批与回执适配，不能套用 Rabi 字段。

按[主动智能设计](../../主动智能设计思路.md)，完整助手需要从有来源、时效与授权范围的事件恢复情境、理解意图、主动补充信息、选择参与方式、行动并验证跟进。当前本包是其中的单轮执行基础，不把关键词分流或提示词声明当成完整主动智能。

任务内停顿归并已在 [`@rabilink/rokid-voice/task-input`](../rokid-voice/README.md) 提供共享实现。DSH 已实现手机停顿设置，实际任务语音链路待接入。0.4.0 提供前台用户优先调度和带作用域的任务观察入口。跨任务订阅、离线补齐和持久任务状态由后端适配器提供，真实完成提醒待产品接入。当前工具仍串行等待真实结果再继续推理。前台退出、关麦、打断和后台任务取消分别处理。

## 验证与开发快照

本包 `npm test` 验证不同 Profile、非 Rabi 工具与真实形状的测试回执、不确定写入、无效适配器和取消。AIUI `npm run check:agent` 同时运行共享测试与 Rabi 页面/工具回归。测试后端为夹具，不能证明 DSH 已接入或眼镜已可用。

`npm pack` 只生成此包的开发快照，包含无依赖测试；接收方可在解包后运行 `npm test`。这不是发布或正式安装。源码在这里维护，不复制成两套循环。

### 0.2.3 开发变更

- Rabi 页面迁到统一会话，使用按轮回调连接历史、HUD 与 TTS；退出和改名释放旧会话，迟到模型不能覆盖新会话。
- 新增按轮选项及参数验证；内部与外部引导分别消费，保留已接收输入。
- 共用包 17 项运行测试与严格 TypeScript 消费检查通过；Rabi 模型创建另保留原配置的阶段超时，晚到资源销毁。

### 0.2.4 开发变更

- 修复人格前缀加动作 JSON 被当成普通成功回答的问题；完整和截断的带前缀动作均拒绝，普通正文内的数据 JSON 保留。
- 19 项共享运行测试通过。增加显式开启的 `apps/rabilink-aiui/simulator/Test-LiveAssistantLoop.mjs --execute`：通过已有本机代理调用真实测试模型，只访问随机路径的本地只读计数接口，不读取或输出密钥。
- 真实 `gpt-4o-mini` 测试已完成接口发现、调用及随机回执回读，但最终回复的指定前缀仍不稳定，完整格式断言失败；这是未解决的模型遵循限制，不记为验收通过。测试模型不是乐奇宿主，不能据此宣称真机模型可用。

### 0.2.5 开发变更

- 修复终止类工具返回时，已接收的补充输入随会话轮次丢失的问题。结果返还 `pendingGuidance`，保留终止语义，不新增模型请求或重放工具。
- 20 项共享运行测试通过；终止工具回归先复现丢失，再验证输入原样返还、仅一次执行及结束后拒收新输入。该字段仍需各消费端保存，测试不代表手机草稿界面已经接入。

### 0.2.6 开发变更

- 把未消费引导的交还扩展到取消、销毁、初始化超时、模型错误和轮次超时；错误保留原始 cause，兼容不可修改的宿主错误。
- 23 项共享测试通过。失败路径先复现丢失，再核对队列原文、已经交给循环的输入不重复返还、迟到资源释放，以及已派发后台操作仅执行一次。

### 0.3.0 开发变更

- 新增无 Rabi 依赖的 AIUI 装配入口，并接入 Rabi 页面的 ASR、TTS、模型候选和销毁流程。
- 新增 8 项资源所有权测试：开口只停声、迟到合成清理、旧识别回调抑制、旧输出清理隔离、模型候选替换、清理异常、预先取消和 ASR 启动失败。共享测试合计 31 项通过。

## 0.11 常驻宿主与可选 UI

`./resident` 的 `createResidentInteraction` 由原生宿主持有。明确 start 后，移除所有 GUI/桌宠订阅仍保持语音；`pauseCapture` 只暂停输入，`setOutputEnabled(false)` 只静音输出，`stop`/`dispose` 释放语音服务，但不取消独立原生 Session 已受理的模型或工具任务。开口打断只停止当前声音，继续保留文字。

`openServices` 必须返回可等待的 `dispose`。启动取消、权限延迟、设备清理失败均受代际围栏保护；清理未确认时不能新开设备。宿主进程的原生 Job 所有权由 PC 壳负责，不由 SDK 定时轮询代替。

`./ui` 提供独立可选 `createAssistantPanel(React, primitives)`。它只读取 Host 状态、提交命令和订阅原生聊天投影，不创建麦克风、播放器或模型。DSH 与后续 Rabi 可使用同一组件，眼镜不依赖该 GUI。

旧 `./voice` 的显式 suspend/hide 控制仍保留原合同；常驻宿主不把页面隐藏事件绑定到这些停用方法。132 项 SDK 测试已通过，实际宿主安装与设备声学效果分别验收。

### 设置草稿与导航

设置分为对话、语音识别、语音播报、设备和外观。提供商、模型、识别模式与参数先进入草稿，点击“保存设置”后生效；关闭时可继续编辑、放弃或保存并关闭。模型列表刷新、试听及麦克风测试需要当前草稿时，按钮明确标为“保存并…”。DSH 宿主模型选择仍即时更新默认模型，并在控件旁说明。

宿主通过 `previewSettings(patches)` 与 `saveSettingsBatch(patches)` 提供同一套校验及模型配置归并逻辑。预览不持久化、不停止语音；批量保存最多 64 个补丁，在一次存储提交中应用，禁止直接写配置档案。连接密钥按实际提供商和地址另行保存。界面区分未保存状态、配置缺项与连接中断。

### 首次使用与预览边界

DSH 插件自动读取当前 DSH 的提供商和模型，无需在助手里重复填写对话密钥。先选模型，发送一句文字并确认收到真实回复，再配置识别、音色和音频设备；服务目录为空或仅配置了默认模型名，不代表模型已经可调用。隔离测试环境必须实际加载所需提供商插件和凭据，不能用示例模型证明可用。

界面预览明确标注不能对话；设置窗口、示例模型和保存反馈同样保留该标识。预览禁用密钥输入、发送、语音启动与音频测试。首次配置按对话、识别、播报、设备逐项引导；参数默认值可先保留。
