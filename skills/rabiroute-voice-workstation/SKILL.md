---
name: rabiroute-voice-workstation
description: 设计、编写、实现或审查一套公开安全的语音交互工作站，把 FenneNote 语音转写、RabiRoute 路由、角色化对话和 OumuQ TTS 连接起来，同时避免泄露私聊日志、账号、路径、webhook 密钥、NapCat 配置或角色私有数据。
---

# RabiRoute 语音交互工作站

当你需要设计、记录、实现或审查下面这条工作流时，使用这个 skill：

```text
语音转写 -> RabiRoute 路由决策 -> 角色对话 -> 屏幕回复和/或 TTS 回复
```

RabiRoute 是消息和事件路由层。它接收 QQ/NapCat 事件、FenneNote webhook 事件、语音转写事件、定时事件和本地工具事件，然后把规范化后的事件交给 Codex 或其他 Agent runtime。它不替代 FenneNote、OumuQ、NapCat，也不替代下游负责角色扮演的 Agent。

## 公开安全优先

不要提交或粘贴：

- 私聊日志、语音转写、录音、角色私有记忆或用户画像。
- 真实 QQ 号、群号、发送者 ID、webhook 密钥、NapCat 管理地址、cookie、token、API key 或个人绝对路径。
- 真实运行期的 `data/`、`logs/`、`tmp/`、`recordings/`、`transcripts/` 或 `voice-cache/` 内容。

使用占位符，例如 `<placeholder-user-id>`、`<webhook-secret>`、`<gateway-id>`、`/path/to/project` 和 `C:/Path/To/Project`。

提交前先检查 `git status --short`，只暂存当前任务负责的文件。

## 核心边界

保持各层职责分离：

```text
FenneNote
  -> transcript webhook
  -> RabiRoute normalize / store / route
  -> Codex or Agent runtime
  -> role-faithful visibleText / ttsText
  -> OumuQ TTS or QQ/NapCat action draft
```

FenneNote 负责语音转文字。RabiRoute 负责路由策略和安全交接。Agent 负责推理、角色扮演和回复文本。OumuQ 负责语音生成。QQ/NapCat 负责聊天发送。

## 事件契约

语音转写事件应该结构化。最小字段示例：

```json
{
  "platform": "fenne-note",
  "eventType": "voice_transcript",
  "eventId": "<stable-event-id>",
  "createdAt": "2026-06-05T10:00:00+08:00",
  "source": {
    "channel": "codex",
    "chatType": "local",
    "chatId": "<placeholder-chat-id>",
    "senderId": "<placeholder-user-id>",
    "senderName": "<display-name>"
  },
  "transcript": {
    "text": "<recognized text>",
    "language": "zh-CN",
    "confidence": 0.92
  },
  "actionInstruction": {
    "replySurface": "codex",
    "allowExternalSend": false,
    "allowTts": true
  }
}
```

`actionInstruction.replySurface` 控制答案应该落在哪个回复面：

- `codex`：在当前 Codex 或 Agent 会话里回答。
- `qq`：生成 QQ/NapCat 草稿；除非本地策略明确允许，否则只在显式批准后发送。
- `tts`：生成适合交给 OumuQ 的朗读文本；不要从 TTS 自动推断需要 QQ 外发。
- `none`：只记录或内部路由，不生成面向用户的回复。

对于 Codex/FenneNote 语音输入，始终遵循事件里的行动说明。不要把 Codex 语音回复和 QQ/NapCat 回复混在一起。

## 路由设计

在 `data/roles/<role>/roleMessageConfig.json` 中使用或新增角色消息规则路由类型 `voice_transcript`。一个好的路由模板应该包含：

- 路由类型和事件时间。
- 转写文本。
- 来源频道和来源类型。
- 回复面。
- 外发权限。
- TTS 权限。
- 角色路径或角色 ID。
- 需要读取的近期日志或缓存路径。

下游 prompt 必须要求 Agent 先读取回复面再行动。RabiRoute 应该在空闲时启动固定线程，在目标线程已经运行时把当前回合导入已有线程。

## 角色对话规则

屏幕可见文本和 TTS 文本都必须保留角色口吻。

不要把屏幕文本写成中性助手腔，再只让音频“扮演”角色。跨语言翻译或回答时，先保留角色身份、语气、关系感和说话习惯，再适配目标语言的自然表达。

推荐的 Agent 输出：

```json
{
  "visibleText": "<role-faithful reply>",
  "ttsText": "<role-faithful speech text>",
  "replySurface": "codex",
  "ttsProvider": "oumuq",
  "requiresApproval": false,
  "notes": "<internal routing notes>"
}
```

不要把 `notes` 发到外部聊天。

## 低延迟语音调用

实时语音回复优先使用常驻 HTTP 调用 OumuQ：

```http
POST http://127.0.0.1:8780/api/speak
```

Agent 应该通过已经运行的 runtime 或 HTTP client 发送请求，例如持久的 JS/Node `fetch` 上下文。不要为每一句普通语音都启动 PowerShell、`curl` 或其他 shell 进程；进程启动会在发送同一个 HTTP 请求前增加可避免的延迟。

直接 HTTP 不是零延迟。它仍然要等待本地请求处理、OumuQ 路由、worker 排队、音频生成和播放。重点是去掉 shell 启动开销，让语音链路尽量接近当前 TTS worker 能达到的即时响应。

shell 命令只用于诊断、配置、文件检查，或常驻 HTTP 路径不可用时的 fallback。低延迟 QQ/NapCat 测试发送也遵循同样原则：动作已经获得授权时，优先从常驻 runtime 直接调用 OneBot HTTP。

## 动作安全

默认允许：

- 记录原始事件和规范化事件。
- 记录路由决策。
- 启动或导入内部 Agent 线程。
- 生成屏幕可见回复草稿。
- 在 `allowTts` 为 true 时生成 TTS 草稿。

默认需要批准：

- QQ/NapCat 群聊或私聊发送。
- 写入外部文档、issue、表格、数据库或工单。
- 修改私有角色记忆或生产网关配置。
- 回放或上传录音、转写文本。

如果路由要求 QQ/NapCat 投递，但 `allowExternalSend` 为 false，只创建草稿，并说明需要批准。

## 交付检查

完成公开工作流或 skill 时：

- 确认仓库只包含公开安全的文档、示例或代码。
- 确认 `.gitignore` 排除了运行期音频、转写、日志、临时文件和私有配置目录。
- 确认路由示例使用占位符，没有真实账号标识。
- 确认 Codex/FenneNote 语音输入明确区分 Codex 回复和 QQ/NapCat 回复。
- 确认角色对话说明会在可见文本和跨语言输出中保留角色口吻。
- 确认 OumuQ 只接收已经批准的 `ttsText`。
- 如果改了代码，运行可用验证，例如 `npm run build`；如果只是文档改动，至少检查 Markdown 链接和格式。
