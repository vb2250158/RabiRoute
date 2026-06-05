# 路由与人格

路由入口参数见 [路由配置](routing-configuration.md)。这里专门讲人格包，以及跟随人格的消息模板规则。

## 路由人格

RabiRoute 现在把路由配置和路由人格分开：

- `data/route/<配置名>/`：路由配置包。放 `routeConfig.json`，决定消息端、端口、Agent 端和指向哪个人格。
- `data/roles/<RoleId>/`：人格配置包。放 `persona.md`、`roleMessageConfig.json`、成长记录、提示词和角色知识。

一个角色目录通常包含：

```text
<RoleId>/
├── persona.md
├── roleMessageConfig.json
├── growth.md
├── skills.md
└── prompts/
```

公开示例：

- `examples/data/roles/Rabi/persona.md`
- `examples/data/roles/Rabi/roleMessageConfig.json`
- `examples/data/roles/Rabi/`
- `examples/data/route/main/routeConfig.json`

Rabi 示例是 RabiRoute 默认的兔娘看板娘与陪伴型成长人格样例，主要演示 `persona.md`、`roleMessageConfig.json`、`growth.md`、`skills.md`、`prompts/` 和独立路由配置如何配合。

一个项目可以同时拥有多个路由配置。每个 `data/route/<配置名>/routeConfig.json` 会被 manager 组装成一个运行入口；多个路由配置可以通过 `agentRoleId` 使用同一个 `data/roles/<RoleId>/` 人格配置。

```text
data/route/main/routeConfig.json
data/route/voice/routeConfig.json
data/route/dev-review/routeConfig.json
```

上面三套路由可以分别配置消息端、端口和 Agent 投递方式，也可以指向同一个人格。不要为了多个消息模板复制人格；同一个人格可以通过 `roleMessageConfig.json` 里的多个 `configName` 规则服务多个路由。

## 人格路由模板设计

`roleMessageConfig.json` 里的模板不是单纯通知文案，它是把消息交给人格时的“判断框架”。同一个 `routeKind` 对不同角色、不同场景的意义可能完全不同：同一个 Rabi，在私聊里可以更像陪伴角色；在群里则更像看板娘和路由助手。PM 或工作型角色看到“嗯嗯”“收到”“谢谢”，可能只需要记录，不应该打断正在写作或执行任务的 Agent。

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

然后在 WebUI 的路由配置中把 `指向人格` 选择为 `Rabi`。选择人格后，转发给处理端的提示末尾会追加角色文件路径，消息模板规则从该角色的 `roleMessageConfig.json` 读取。

项目内还提供了一个开源 skill，用来指导创建新人格：

- `skills/create-rabiroute-persona/SKILL.md`

它说明了如何一起设计 `persona.md` 和 `roleMessageConfig.json`，让角色既有稳定气质，也有对应的消息模板规则。

如果要把语音输入、FenneNote 转录、角色回复和 OumuQ TTS 接成一个工作站，可参考：

- `skills/rabiroute-voice-workstation/SKILL.md`
- [语音交互工作站](voice-interaction-workstation.md)

这套工作流的关键是：语音转录事件使用 `voice_transcript`，并由事件里的行动说明决定回复面。来自 Codex/FenneNote 的语音输入不等于 QQ/NapCat 外发；角色回复的可见文本和 TTS 文本都必须保留角色语气。
