<!-- docs-language-switch -->
<div align="center">
<a href="./routing-and-personas_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 路由与人格

> 状态：现行指南。说明 route、role/persona 和处理端的真实边界。

路由入口参数见 [路由配置](routing-configuration.md)。这里专门讲人格包，以及跟随人格的消息模板规则。

## 路由人格

RabiRoute 现在把路由配置和路由人格分开：

- `data/route/<配置名>/`：路由配置包。放 `adapterConfig.json`，决定消息端、端口、Agent 端和指向哪个人格。
- `data/roles/<RoleId>/`：人格配置包。放 `persona.md`、`personaConfig.json`、成长记录、提示词和角色知识。

一个角色目录通常包含：

```text
<RoleId>/
├── persona.md
├── personaConfig.json
├── avatar.png              # 可选，也可以是 .jpg / .webp / .gif
├── voice/
│   └── voice-profile.json
├── conversation/
│   ├── current.jsonl
│   └── archive/
├── growth.md
├── skills.md
├── skills/
└── prompts/
```

公开示例：

- `examples/data/roles/Rabi/persona.md`
- `examples/data/roles/Rabi/personaConfig.json`
- `examples/data/roles/Rabi/`
- `examples/data/route/main/adapterConfig.json`
- `examples/data/roles/RabiActive/`
- `examples/data/route/RabiLink/adapterConfig.json`

Rabi 示例是 RabiRoute 默认的兔娘看板娘与陪伴型成长人格样例，主要演示 `persona.md`、`personaConfig.json`、`growth.md`、`skills.md`、`skills/`、`prompts/` 和独立路由配置如何配合。其中 `skills/one-plan-one-task-tracking.md` 是不绑定消息平台或具体项目的通用范例：一旦建立任何计划，无论是旅游、调研、设计、实施还是排障，都为它绑定一个正式会话任务并持续追踪到终态。RabiActive 是 RabiLink AIUI 的主动智能样例，配套演示 record-first 会话账本、空闲/周期审阅和任务外主动下行。

一个项目可以同时拥有多个路由配置。每个 `data/route/<配置名>/adapterConfig.json` 会被 manager 组装成一个运行入口；多个路由配置可以通过 `agentRoleId` 使用同一个 `data/roles/<RoleId>/` 人格配置。

```text
data/route/main/adapterConfig.json
data/route/voice/adapterConfig.json
data/route/dev-review/adapterConfig.json
```

上面三套路由可以分别配置消息端、端口、热投递模式和 Agent 投递方式，也可以指向同一个人格。不要为了多个 Route 复制人格；同一个人格复用根级 `personaConfig.json` 中的消息模板规则、语音唤醒关键词和分消息端上下文额度。

## 语音、声线与消息上下文归属

| 业务事实 | 唯一真源 | 原因 |
| --- | --- | --- |
| 人格头像 | 人格 `personaConfig.json.avatar` 指向的角色目录内图片 | 头像跟随人格复用，不应在每条 Route 重复配置。 |
| 语音热投递或关键词模式 | Route `adapterConfig.json.speechPushMode` | 决定这条语音入口是否每段立即投递。 |
| 人格名/称呼/唤醒词 | 人格 `personaConfig.json.speechTriggerKeywords` | 同一人格被多条 Route 复用时应共用同一组称呼。 |
| 11 个消息端的自动上下文条数 | 人格 `personaConfig.json.recentMessageLimits` | 同一人格的不同消息端需要不同上下文长度；`0` 只关闭自动注入，不停止记录。 |
| TTS 模型、声线、语言、语速和发声说明 | 人格 `voice/voice-profile.json` | 声音是人格的长期属性，不应在 Route 复制。 |
| 当前双向消息证据 | 人格 `conversation/current.jsonl` | 入站/出站、ASR/TTS、QQ 自身回复和其他端统一记录。 |
| 说话人资料 | RabiSpeech 主机共用 `output/speaker-profiles.json` | 人物资料设置一次后可为后续人格/Route/会议复用；标签仍按 `sessionId + speakerLabel` 手工绑定。 |

热投递开启时，每段 ASR 完成即投递；关闭时所有 ASR 仍记录，仅命中当前人格关键词才唤醒。关键词为空时不回退热投递。普通消息端一旦命中规则则直接 `steer/start`；Heartbeat 的忙碌跳过由独立开关控制。

## 人格头像

在 RibiWebGUI 的“人格配置”页选择人格后，可以上传 PNG、JPEG、WebP 或 GIF，单文件上限 5 MB。Manager 会把图片保存为人格目录内的内容寻址文件，例如 `avatar-a1b2c3d4e5f6.webp`，再原子更新 `personaConfig.json.avatar`。新文件与配置均写入成功后才清理旧的托管头像，因此更换失败时旧头像仍然有效。删除头像不影响 `persona.md`、消息规则、计划、记忆或声线。

头像会显示在 WebGUI 的人格选择、Route 总览、语音人格选择和本地角色面板中。未配置、文件缺失或图片加载失败时，各界面统一回退到人格 ID 首字。Manager 只接受角色目录内的简单文件名，不允许通过 `avatar` 读取目录外路径；`personaConfig.json` 损坏时上传和删除都会失败关闭，不会用空配置覆盖原文件。

## 人格路由模板设计

`personaConfig.json` 里的模板不是单纯通知文案，它是把消息交给人格时的“判断框架”。同一个 `routeKind` 对不同角色、不同场景的意义可能完全不同：同一个 Rabi，在私聊里可以更像陪伴角色；在群里则更像看板娘和路由助手。PM 或工作型角色看到“嗯嗯”“收到”“谢谢”，可能只需要记录，不应该打断正在写作或执行任务的 Agent。

因此不要在网关层替 Agent 判断“这句话值不值得回”。网关只负责识别结构，例如私聊、直接 @、直接回复、回复链、普通群消息关键词；是否回应、如何回应、是否只记录，应该写进对应人格的模板和 `persona.md`。

### 陪伴型模板

陪伴型能力要分场景写。私聊里可以鼓励自然延续关系、回应情绪、轻轻找话题；群聊里即使是偏人格化角色，也通常要先看群聊节奏，不要主动把公共频道变成陪聊场。

群聊回复链模板可以写成：

```text
QQ 回复链提醒：群聊里有人继续回复了 Rabi 参与过的对话。
时间：{time}
发送者：{sender}
被回复消息：{repliedMessage}
当前消息：{message}

请读取 {groupLogPath} 查看回复链上下文，并遵循 {agentRolePath}。
在群里，本角色只轻轻接住和分诊，不主动展开陪聊。
先判断当前消息是否需要继续回应：明确追问、有用补充、提醒记录、配置/路由/状态问题可以回应；普通确认、礼貌回复、多人协作里的过程性回复，通常只记录并保持安静，避免制造回复链嵌套。
```

私聊模板可以更柔软：

```text
QQ 私聊提醒：有人私下找 Rabi。
时间：{time}
发送者：{sender}
消息：{message}

请读取 {privateLogPath} 查看私聊上下文，并遵循 {agentRolePath}。
私聊里可以更偏陪伴：接住情绪、自然聊天、轻轻找话题，也可以帮助理解配置、提醒、记录或整理下一步。
注意保护私聊语境，不要把私聊内容带到群聊。
```

### PM / 工作型模板

PM、审校、开发助手这类角色也可以订阅回复链，但模板应该强调“先判断是否形成行动”：

```text
群聊回复链提醒：有人继续回复了本角色参与过的任务讨论。
时间：{time}
发送者：{sender}
被回复消息：{repliedMessage}
当前消息：{message}

请读取 {groupLogPath} 查看上下文，并遵循 {agentRolePath}。
先判断当前消息是否带来新增事实、决策、风险、阻塞、验收结论、责任人变化或待办变化。
如果只是确认、附和、礼貌回应或对其他 Agent 写作过程的普通回复，不要继续嵌套打扰；只记录或保持安静。
如果确实影响任务推进，请输出最小必要的下一步：状态、证据、负责人、截止点或需要追问的信息。
```

### 规则选择建议

- 陪伴型角色：私聊可以更主动；群聊订阅 `direct_reply`、`indirect_reply` 时，模板要提醒它先看公共频道节奏。
- PM / 工作型角色：可以订阅 `direct_reply`；`indirect_reply` 建议配合模板降噪，或加 `regex` 只接任务关键词。
- 多 Agent 写作场景：避免让所有角色都无条件订阅 `indirect_reply`，否则容易形成回复链嵌套和重复打扰。
- 普通群消息：优先用 `group_message + regex`，不要空 regex 全量转发。

本地使用时，推荐直接复制示例 data 包：

```powershell
xcopy examples\data data /E /I
```

```bash
cp -R examples/data/. data/
```

也可以只复制单个人格到 gateway 的角色目录：

```powershell
xcopy examples\data data /E /I
```

然后在 WebUI 的路由配置中把 `指向人格` 选择为 `Rabi`。选择人格后，转发给处理端的提示末尾会追加角色文件路径，消息模板规则从该角色的 `personaConfig.json` 读取。

项目内还提供了一个开源 skill，用来指导创建新人格：

- `skills/create-rabiroute-persona/SKILL.md`

它说明了如何一起设计 `persona.md` 和 `personaConfig.json`，让角色既有稳定气质，也有对应的消息模板规则。

RabiPC 语音输入、人格回复与 RabiSpeech TTS 工作站可参考：

- `skills/rabiroute-voice-workstation/SKILL.md`
- `skills/character-tts-dialogue/SKILL.md`
- [RabiSpeech 本机 TTS / ASR 服务](rabispeech-plugin.md)

语音转录事件使用 `voice_transcript`，但不等于自动 QQ/NapCat 外发。如果用户在语音里明确要求“发到群里 / 发 QQ / 你直接发”，且目标、内容和授权足够清楚，就应进入现有外发流程。角色回复的可见文本和 TTS 文本都必须保留角色语气。
