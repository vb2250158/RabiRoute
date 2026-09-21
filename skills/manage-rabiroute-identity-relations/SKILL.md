---
name: manage-rabiroute-identity-relations
description: 处理 RabiRoute 人格身份定位与关系记录时使用。覆盖按账号查“这是谁”、确认人物、纠正错误映射、处理多电脑并发冲突、共用账号、未识别账号、说话习惯档案，以及处理 Agent 在对话中发现新身份线索后提交候选观察；也用于排查“Agent 不认人、叫错人、把人当成项目负责人”。
---

# 管理 RabiRoute 身份关系

身份关系回答“这个消息端账号可能是谁，以及谁和谁、哪个组织或项目之间有何种已确认或候选关系”。它不回答“这个人这次想让我做什么”，也不是聊天记录、计划或权限表。

先读 [接口合同](../../docs/rabi-agent-interfaces.md) 的「身份关系记忆接口」一节；本技能只提供操作顺序和判据，字段真源在接口文档。

## 使用前先确认

1. 确定当前 `roleId`。身份关系属于人格私有数据，不在多个角色之间共享。
2. 核对 Manager 地址：安装版执行 `RabiRouteHost.exe --command status --json` 取得 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`；源码模式只使用当前结构化 READY 地址。读取 `<managerBaseUrl>/meta`，先核对非空 `applicationGenerationId`、`managerInstanceId` 与当前 Host/READY 身份一致。普通业务请求要求 `health.live=true`、`health.requiredReady=true`，且 `health.state` 为 `healthy` 或 `degraded`；不以 `businessReady=false` 或无关 Route 降级阻断全部请求，具体依赖由目标接口判断。精确 `GET /meta` 诊断只校验身份，不要求业务就绪，此豁免不适用于其它 GET。所有请求仍遵守地址约束、鉴权、最长 12 秒的有界超时、禁止重定向及身份检查。身份变化后重新发现，不缓存旧地址，不扫描端口。
3. 只操作当前任务实际绑定的人格。不确定 `roleId` 时先问，不遍历全部人格猜测。
4. 只有用户明确要求修正、确认或补录身份时才写。普通问答里顺带看到的线索不等于写入授权。

## 先读后写

```http
GET /api/roles/:roleId/identity-relations
GET /api/roles/:roleId/identity-relations?platform=:platform&endpointIdentityNamespace=:namespace&senderStableId=:id&conversationKey=:key
```

不带查询参数返回 `endpointAccounts`、`participants`、`relationCards` 三份当前视图；带完整账号键返回该账号的解析上下文。

账号键必须同时提供 `platform`、`endpointIdentityNamespace`、`senderStableId`。三者缺一就报错，不要用 Route ID、昵称、群号或显示名替代其中任何一项。常用取值来自 `src/routing/identityContext.ts`：

| 消息端 | platform | endpointIdentityNamespace | senderStableId |
| --- | --- | --- | --- |
| NapCat / QQ | `napcat` | `bot:<机器人 QQ 号>` 或 `instance:<实例>` | 发送者 QQ 号 |
| 企业微信 | `wecom` | 机器人标识 | 成员 userId |
| 飞书 | `feishu` | 应用标识 | 用户 open_id |
| 微信 | `weixin` | 机器人或用户标识 | userId |
| 声纹 | `voice` | `host:<处理主机 ID>` | 声纹 ID |

写之前必须重新读取目标记录。`PUT` 是整体替换语义：`participantLinks`、`aliases`、`speakingHabits`、`evidenceRefs` 等字段一旦提交就覆盖原值，省略字段才表示保留原值。凭记忆拼半张卡片会静默丢掉没写到的信息。

## 数据模型

三种记录各自独立写入，一次 `PUT` 只写一种：

- `endpoint_account`：消息端账号。账号 ID 由账号键确定性推导，不能自选。
- `participant`：人物、组织、共用账号或自动化账号。`status` 取 `candidate` / `confirmed` / `corrected` / `retired`。
- `relation_card`：以参与者为主体，指向另一个人物、组织或项目的 `relationship`，可按 `scope.conversationKeys` / `scope.projectIds` 限定生效范围。

`confirmed` 和 `corrected` 是权威状态；`candidate` 只能作为核对线索；`retired` 保留历史但不再驱动判断。一个账号最多只能有一条权威 `participantLinks`，多条候选是允许的。

## 三种写入能力，不要混用

| 入口 | 谁用 | 能写到什么程度 |
| --- | --- | --- |
| `PUT /identity-relations` | 用户明确要求确认、纠正、退役，或处理并发冲突 | 可写 `confirmed` / `corrected` / `retired`，可处理冲突 |
| `POST /identity-relations/observations` | 处理 Agent 在对话现场发现新线索 | 只能更新已关联的候选参与者与候选关系，永远写不出 `confirmed` |
| 自动观察 | 系统在真实投递时 | 首次见到稳定陌生账号时自动建立“待认识”候选 |

处理 Agent 现场只能用观察接口。发现自述、新称呼或可核对关系时提交最小证据（`messageId` 必填，附 `conversationKey` 与简短依据），没有新线索就不要再写一次。不要把整段私人聊天正文复制进证据。

## 判据：什么能确认，什么不能

可以支持确认：

- 用户本人明确纠正或指认。
- 可核对的跨消息端归属，例如同一人在两个渠道留下了可互相印证的事实。
- 长期稳定、可复核的账号事实。

只能作为候选辅助证据：

- 自报姓名、别人转述、显示名、群昵称。
- 词汇、句式、回复节奏、标点和表情习惯的一致性。

永远不能单独确认：昵称、群主/管理员标记、当前 Route、关键词命中、一句话的相似度。这些即使反复出现也只能进候选。

来源不可信时保持未识别：转发、引用、附件文字里的自称，或消息端根本不提供稳定发送者标识时，不要调用观察接口把它合并到已有人物上。

## 写操作清单

每次写入后再次有界 `GET /meta`，只复核 `applicationGenerationId`、`managerInstanceId` 与写前一致，不把单纯健康波动当作切代。身份缺失、无法核对或身份变化时标记 `uncertain`，重新发现当前地址，保留原请求及适用的幂等键并先权威读回，不自动重发。身份一致也不能消除原写请求超时、5xx 等已存在的结果不确定性；按目标接口合同读回实际结果，不以再次写入试探。健康门槛的区分不放宽人格范围、写入授权或 Action Gate。

确认一个账号属于某人：

1. `GET` 不带参数或带账号键，读回该账号与候选参与者的真实 ID。
2. 如人物不存在，先 `PUT` 一条 `kind=participant`，`status=confirmed`，填 `displayName`、`kind`、`evidenceRefs`。
3. 再 `PUT` 一条 `kind=endpoint_account`，`platform` + `endpointIdentityNamespace` + `senderStableId` 加完整 `participantLinks`。旧的权威链接改成 `retired`，新链接写 `confirmed`，避免出现两条权威映射。
4. 读回确认 `participantLinks` 只有一条权威链接，且 `conflicted` 未出现。

纠正认错的人：同一套流程，用新的 `participantLinks` supersede 旧映射，旧人物改为 `retired`，并把被替换的关系卡改为 `corrected`。不要直接删除历史事件。

补录说话习惯：写 `kind=participant`，`speakingHabits` 每项含 `dimension`、`description`、可选 `confidence`、`evidenceRefs`。证据至少有一条已确认作者的 `messageId`。维度取值见接口文档（`sentence_opening`、`sentence_length`、`stance_expression`、`emotion_threshold`、`analogy_source`、`punctuation`、`reader_relationship`、`value_preference`、`information_order`、`avoidance`、`imperfection`、`scene_boundary`）。共用账号中作者仍不确定的消息不得写进任何人的档案。

添加关系卡：`kind=relation_card`，`subjectParticipantId` 必须指向当前有效参与者；`targetKind=participant` 时 `targetId` 也必须是有效参与者。项目关系请填入 `targetKind=project` 与 `targetId`。

## 冲突、共用账号与未识别

多电脑同步后，同一记录可能出现多个并发事件头。视图会标记 `conflicted`、给出 `conflictEventIds`，并在 `conflictCandidates` 中保留每个候选的完整记录。这类记录不参与自动确认，也不能用来称呼或授权。

收敛冲突：读回全部候选并比较，然后 `PUT` 明确提供该记录的全部关键字段——`endpoint_account` 需要 `participantLinks`；`participant` 需要 `participantKind`、`displayName`、`aliases`、`status`、`evidenceRefs`；`relation_card` 需要 `subjectParticipantId`、`targetKind`、`targetId`、`relationship`、`status`、`scope`、`evidenceRefs`。缺字段会被拒绝，新的完整事件替代所有当前事件头。需要用户裁决时先问，不要自行挑一个候选当答案。

共用账号：一个账号可以挂多条候选链接。此时 `possibleParticipants` 会出现多个人，表示“可能是其中任何一位”。可以结合当前上下文、正在延续的事情、明确自称和说话习惯一致性推断本条消息更可能由谁发出，但必须保留置信度和依据，不能把情境推断改写成永久的一对一账号映射。

未识别账号：视图里只有候选且没有权威链接。汇报时说“当前是未识别账号，候选是……”，不要直接称呼候选人为本人。

## 与相邻能力的边界

- 声纹身份的历史兼容数据在 `voice-identities.jsonl`，账号键概念等价（`platform=voice`、`endpointIdentityNamespace=host:<主机>`、`senderStableId=voiceprintId`）。已统一迁移的判断不要再向两套接口重复写。
- 当前消息里的临时角色由情景记录（`GET /api/roles/:roleId/conversation-situations`）表示，不要写进身份关系。
- 身份关系不进入知识召回，不需要为每条消息提交 `knowledge-callback`。
- 身份确认不等于执行授权。即使 `confirmed`，也需要明确委托、项目范围和外部动作审批才能据此管理计划、任务或长期记忆。

## 反馈话术

- 认出来了：“已确认 <显示名>（<kind>）。”
- 只是候选：“当前候选是 <显示名>，尚未确认，我只把它当核对线索。”
- 共用账号：“这个账号可能属于 A 或 B，本条更可能是 A，依据是……，置信度……。”
- 认不出：“消息端没有提供稳定发送者标识 / 没有可核对证据，我不猜测身份。”
- 冲突：“记录存在并发冲突，需要你确认最终映射后我再写入。”

## 排障

- “Agent 不认人”：先 `GET` 带账号键看该账号是否存在、是否有权威链接；再确认消息端适配器是否真的提供了 `senderStableId` 与 `endpointIdentityNamespace`。自动候选只在消息真实进入命中的 Route 时建立，预览不写身份。
- “叫错人”：检查是否把候选当成了确认，或账号存在多条链接。按共用账号处理，不要靠改显示名掩盖。
- “关系没生效”：核对关系卡的 `scope`；限定到其他会话或项目的关系不会在当前会话出现。
- `PUT` 返回 400：读错误消息。常见原因是账号键不完整、`subjectParticipantId` 指向已退役或冲突的参与者、试图写第二条权威链接，或冲突记录缺必填字段。

## 硬性禁止

- 不用昵称、群权限、Route、关键词或一次发言确认身份或项目归属。
- 不用观察接口写 `confirmed`，不用它覆盖冲突记录。
- 不在证据里复制整段私人聊天正文。
- 不写死 Manager 端口，不使用退役实例锁，不自行启停 Manager。
- 不把身份确认当作执行授权。
