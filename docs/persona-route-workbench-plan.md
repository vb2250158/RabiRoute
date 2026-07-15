# 人格路由工作台设计计划

本文设计 RibiWebGUI 的人格配置页改造。它不是竞品 Agent 编辑器复刻，也不是“智能选择人格”的产品方案；它是给当前 RabiRoute 模型补一个可解释、可预览、可排障的工作台。

当前 RabiRoute 的事实模型是：

```text
route 配置固定指向 agentRoleId
  -> 消息端收到事件并归一为 route kind
  -> gateway 子进程遍历 active routeProfiles
  -> 每个 route profile 下的 notificationRules 判断是否命中
  -> 命中的 rule + 已绑定人格路径生成 AgentPacket
  -> Agent adapter 投递给 Codex / Copilot / AstrBot / Marvis
```

也就是说，当前系统没有“人格智能命中”。人格不是由消息内容动态选择的；人格由 `data/route/<configName>/adapterConfig.json` 里的 `agentRoleId` 预先绑定。预览要回答的是：

```text
在这个已绑定人格的 route 里，这条模拟消息会不会命中某条消息模板规则？
如果命中，Agent 实际会收到什么？
```

严格说，生产链路会遍历当前 gateway 进程里的所有 active routeProfiles。人格页第一版预览建议先做“单 route profile dry-run”，因为用户正在编辑的是某个 route 指向人格后的规则；后续可以再加“整条 gateway 投递试算”，展示同一条模拟事件在所有 active routeProfiles 上的命中结果。

## 现有链路依据

关键代码边界：

| 链路 | 当前实现 | 结论 |
| --- | --- | --- |
| route 读取 | `src/manager/configRepository.ts` 读取 `adapterConfig.json`，再按 `agentRoleId` 读取对应 `personaConfig.json` | route 固定指向一个人格 |
| route profile | `src/shared/gatewayConfigModel.ts` 归一化 `agentRoleId`、`notificationRules`、`recentMessageLimit` | 规则跟随已绑定人格进入 route profile |
| 规则命中 | `src/routing/routeDecision.ts#createRouteDecision` 在给定 route profile 内过滤 rules | 不做跨人格选择 |
| AgentPacket | `src/routing/agentPacket.ts#buildAgentPacket` 使用 `rolePathsForRoute(route)` 解析已绑定角色路径 | 命中 rule 后才注入人格路径、记忆、计划、技能 |
| 真实投递 | `src/forwarding.ts#forwardMessageAndWait` 遍历当前进程 active routeProfiles，写事件日志、写投递日志、记录 replay ledger 并投递 Agent | 预览不能直接调用真实投递 |
| QQ route kind | `src/adapters/napcatAdapter.ts` 把 QQ 事件归为 `direct_at`、`direct_reply`、`indirect_reply`、`group_message`、`private` | QQ 不是只选“渠道”，还要模拟事件形态 |
| RabiLink route kind | `src/adapters/webhookAdapter.ts#createRabiLinkAdapter` 使用 `rabilink` route kind | RabiLink 是专用 route kind |
| WeCom route kind | `src/adapters/wecomAdapter.ts` 使用 `wecom_message` | 企业微信是专用 route kind |
| heartbeat | `src/adapters/heartbeatAdapter.ts` 按 rule schedule 触发 `heartbeat` | 计划触发也仍然命中同一套 rules |

## 背景

当前 WebGUI 已经有两块能力：

- 路由配置页：配置消息端、Agent 端、模型覆盖、工作目录、会话绑定、心跳、RabiLink 等 route 事实。
- 人格配置页：选择当前 route 指向的人格、预览 `persona.md`、编辑 `personaConfig.json` 里的消息模板规则。

真实使用中，用户更需要回答这些问题：

- 当前 route 到底绑定了哪个人格？
- 某条模拟 QQ / RabiLink / WeCom / heartbeat 消息会不会命中这个 route 已绑定人格下的规则？
- 命中哪条规则，为什么？
- 没命中是 route kind 不对、regex 不对、目标群不对，还是对应消息端没启用？
- Agent 实际会收到什么完整 AgentPacket？
- 当前消息会召回哪些记忆、计划和技能？
- 如果真实投递失败，是入口没开、规则没中、Agent adapter 投递失败，还是模板要求 Agent 保持安静？
- 应该改人格模板，还是去路由配置页改消息端 / Agent 端？

因此人格页应该成为“人格路由工作台”，而不是另一个路由配置页。

## 不做什么

- 不新增“开场白”。QQ / RabiLink 主场景里用户已经先发消息，开场白没有实际消费点。
- 不做人格智能匹配。当前产品没有这个模型；如果未来要做，应另立“多人格分流”设计。
- 不在人格页重复编辑消息端、Agent 端、模型、pipeline。这些仍属于 `adapterConfig.json` 和路由配置页。
- 不把聊天记录自动变成记忆。记忆仍由 Agent 通过现有接口主动创建或更新。
- 不在预览时投递 Agent、外发 QQ、写 outbox、写 `agent-packets.jsonl` 或刷新记忆 `viewedAt`。
- 不增加没有消费点的字段。任何新增 UI 都必须有真源、消费点、生效时机和验收方式。

## 配置归口

| 业务事实 | 唯一真源 | 页面归口 | 说明 |
| --- | --- | --- | --- |
| 消息端、端口、RabiLink、NapCat、WeCom | `data/route/<configName>/adapterConfig.json` | 路由配置页 | 人格页只读摘要和跳转 |
| Agent 端、模型覆盖、工作目录、会话 | `adapterConfig.json` | 路由配置页 | 人格页不重复编辑 |
| pipeline / 输出意图 | `adapterConfig.json` | 路由配置页 | 只作为模板变量和摘要展示 |
| route 指向的人格 | `adapterConfig.json.agentRoleId` | 路由配置页为真源，人格页可显示和跳转 | 不是消息内容动态选择 |
| 人格正文 | `data/roles/<RoleId>/persona.md` | 人格配置页 | 可预览、打开文件 |
| 消息模板规则 | `data/roles/<RoleId>/personaConfig.json` | 人格配置页 | 编辑 route kind、regex、模板、定时计划 |
| 最近消息注入数量 | `personaConfig.json.recentMessageLimit` | 人格配置页 | 已有字段，可补 GUI 编辑 |
| 计划 | `data/roles/<RoleId>/plans/` | 人格工作台 | 展示、召回预览、后续可接读写 |
| 近期记忆 / 沉淀记忆 | `data/roles/<RoleId>/memory/` | 人格工作台 | 展示、召回预览、后续可接读写 |
| 角色技能 | `data/roles/<RoleId>/skills/` | 人格工作台 | 展示、召回预览 |
| 运行状态 / 日志 | runtime status + route / role 日志 | 路由页为主，人格页摘要 | 人格页用于解释当前人格关联链路 |

## 页面模型

人格配置页拆为四个区：

1. 人格本体
2. 关联路由
3. 规则与模板
4. 预览与诊断

### 人格本体

展示人格文件和人格配置。需要注意：`agentRoleId` 和 `agentRoleFile` 是 route 指向人格的事实，不是人格自身事实。

闭环：

| 项 | 真源 | 消费点 | 生效时机 | 验收 |
| --- | --- | --- | --- | --- |
| 当前 route 指向人格 | `adapterConfig.json.agentRoleId` | manager 组装 route profile | 保存路由配置后生效 | 切换后 route 使用新人格的 `personaConfig.json` |
| 人格文件名 | `adapterConfig.json.agentRoleFile` | `rolePathsForRoute` 和 AgentPacket | 保存路由配置后生效 | AgentPacket 中 `agentRolePath` 指向新文件 |
| `persona.md` 预览 | 角色目录 markdown | WebGUI 展示 | 加载 manager status 时 | 文件缺失时展示错误，不影响 route 保存 |
| `recentMessageLimit` | `personaConfig.json` | AgentPacket 最近消息段 | 下一次消息投递时 | 预览和真实 AgentPacket 最近消息条数一致 |

第一版可以继续允许在人格页选择当前 route 指向的人格，但 UI 文案必须说明这是“当前路由指向人格”，不是“系统会按消息智能选择人格”。

### 关联路由

用人格视角展示哪些 route 配置正在使用当前人格。

闭环：

| 项 | 真源 | 消费点 | 生效时机 | 验收 |
| --- | --- | --- | --- | --- |
| 使用该人格的 route 列表 | 所有 `adapterConfig.json` | WebGUI 只读 | 加载 gateway 配置时 | 同一人格被多个 route 使用时全部列出 |
| 消息端摘要 | route definition + runtime status | WebGUI 只读 | manager status 刷新时 | QQ / RabiLink / WeCom / heartbeat 状态可见 |
| Agent 端摘要 | route definition + agent state | WebGUI 只读 | manager status 刷新时 | Codex / Copilot / AstrBot / Marvis 状态可见 |
| 跳转编辑 | route id / configName | router 导航 | 用户点击 | 跳到路由配置页对应 route |

这个区只解释关联关系，不编辑路由字段。

### 规则与模板

保留现有消息模板规则编辑，并加上诊断提示。

闭环：

| 项 | 真源 | 消费点 | 生效时机 | 验收 |
| --- | --- | --- | --- | --- |
| route kind | `personaConfig.json.notificationRules[].routeKinds` | `createRouteDecision` | 下一次消息路由时 | 预览和真实命中一致 |
| regex | `notificationRules[].regex` | `createRouteDecision` | 下一次消息路由时 | 不匹配时 dry-run 给出原因 |
| targetGroupId | `notificationRules[].targetGroupId` | QQ / WeCom 群规则匹配 | 下一次群消息路由时 | 模拟不同 groupId 可看到命中变化 |
| allowedSpeakerNames | `notificationRules[].allowedSpeakerNames` | 语音转写类记录匹配 | 下一次语音 / RabiLink 类消息路由时 | 模拟 speakerName 可看到命中变化 |
| schedules | `notificationRules[].schedules` | heartbeat adapter 收集任务并触发 | 下一次 heartbeat 调度时 | 有 heartbeat 规则但入口未启用时给 warning |
| template | `notificationRules[].template` | AgentPacket 的用户模板补充 | 下一次命中规则时 | 预览和真实 AgentPacket 中用户模板补充一致 |

规则健康检查不改变配置，只输出 warning。

首批检查：

- 群消息规则 `group_message` 空 regex 且未限制群号。
- 规则选择了 `heartbeat`，但关联 route 未启用 heartbeat 消息端。
- 规则选择了 `rabilink`，但关联 route 未启用 RabiLink 消息端。
- 规则选择了 QQ route kind，但关联 route 没有 NapCat / OneBot 消息端。
- 规则选择了 `wecom_message`，但关联 route 没有 WeCom 消息端。
- 多条规则 route kind、targetGroupId、allowedSpeakerNames 和 regex 完全相同，可能重复投递。
- 当前 route 指向人格，但该人格没有可用规则。

### 预览与诊断

这是本次改造的核心。预览必须走后端 dry-run，不能让前端复刻路由逻辑。

预览不是“选择人格是否命中”。预览输入应该是：

- 当前已绑定人格的 route profile。
- 消息端场景，例如 QQ 群普通消息、QQ 直接 @、QQ 直接回复、QQ 间接回复、QQ 私聊、RabiLink、WeCom、heartbeat、manual trigger。
- 由消息端场景映射出来的 route kind。
- 消息文本和必要事件字段。

建议 UI 用“消息端场景”而不是裸 “channel”：

| 场景 | route kind | 关键字段 |
| --- | --- | --- |
| QQ 群普通消息 | `group_message` | groupId、userId、sender、message |
| QQ 直接 @ | `direct_at` | groupId、userId、sender、message、selfId |
| QQ 直接回复 | `direct_reply` | groupId、userId、sender、message、repliedMessage |
| QQ 间接回复 | `indirect_reply` | groupId、userId、sender、message、repliedMessage |
| QQ 私聊 | `private` | userId、sender、message |
| RabiLink | `rabilink` | sourceDeviceId / taskId 可选、message |
| WeCom | `wecom_message` | chatId / conversationId、senderId、message |
| heartbeat | `heartbeat` | scheduleId、scheduleName、message |
| manual trigger | `manual_trigger` | triggerId、triggerName、message |

### 预览交互闭环

预览区的操作不应该叫“发送消息”。建议文案是“生成预览”或“试算消息”，因为它只构造一条模拟事件，验证这条事件在当前 route 里的规则命中和上下文注入结果。

交互流程：

```text
选择当前 route
  -> 选择消息端场景
  -> 填写模拟消息和必要事件字段
  -> 点击生成预览
  -> 后端 dry-run 返回命中规则、未命中原因、AgentPacket、记忆 / 计划 / 技能召回
```

闭环：

| 项 | 真源 | 消费点 | 生效时机 | 副作用 | 验收 |
| --- | --- | --- | --- | --- | --- |
| 当前 route | `adapterConfig.json` | dry-run API 读取 route profile | 点击生成预览时 | 无 | 返回 route 绑定人格和启用的消息端摘要 |
| 消息端场景 | 前端枚举，后端映射到 route kind | `createRouteDecision` | 点击生成预览时 | 无 | QQ 直接 @ 映射为 `direct_at`，QQ 私聊映射为 `private` |
| 模拟消息字段 | 本次 preview request | route variables / AgentPacket preview | 点击生成预览时 | 无 | 修改 groupId / sender / message 会改变命中解释 |
| 规则命中预览 | `personaConfig.json.notificationRules` | dry-run decision preview | 点击生成预览时 | 无 | 和真实 `createRouteDecision` 结果一致 |
| AgentPacket 预览 | route + matched rule + role context | dry-run packet preview | 点击生成预览时 | 无 | 展示 Agent 将会看到的文本，但不投递 Agent |
| 记忆 / 计划 / 技能召回预览 | `data/roles/<RoleId>/` | dry-run role context preview | 点击生成预览时 | 无 | 不刷新 `viewedAt`，不创建 consolidation run |

第一版默认是单 route profile 试算。若 UI 后续增加“整条 gateway 试算”，输出必须按 route profile 分组，避免把其它 route 的命中误解释成当前人格规则命中。

输出：

- 当前 route 绑定的人格。
- 会命中的消息模板规则。
- 不命中的原因。
- 最终 AgentPacket 预览。
- 记忆 / 计划 / 技能召回。
- 诊断 warning。

明确禁止：

- 不向 QQ / RabiLink / WeCom 外发消息。
- 不调用 Agent adapter。
- 不写 `group-messages.jsonl`、`private-messages.jsonl`、`voice-transcripts.jsonl`、`wecom-messages.jsonl`、`heartbeat-events.jsonl` 或 `manual-trigger-events.jsonl`。
- 不写 `agent-packets.jsonl`。
- 不写 outbox / delivery replay ledger。
- 不更新 memory `viewedAt`。

## 后端 dry-run 能力

当前代码还没有这些预览接口；这是拟新增的后端 dry-run 能力。接口名字可以后续调整，但必须保持无副作用。

```text
POST /api/routes/:routeId/preview/decision
POST /api/routes/:routeId/preview/agent-packet
POST /api/routes/:routeId/preview/role-context
GET  /api/roles/:roleId/route-diagnostics
```

接口以 route 为入口比以 persona 为入口更符合当前模型：真实决策发生在 route profile 里，persona 只是 route 绑定的上下文。

如果要完全复刻生产投递的“遍历 active routeProfiles”行为，应单独新增 gateway 级试算接口，例如：

```text
POST /api/gateways/:gatewayId/preview/delivery
```

它返回多个 route profile 的命中结果，但仍然不能调用 `forwardMessageAndWait`。

### decision preview

作用：只判断当前 route profile 内的规则命中。

内部复用：

- route profile 解析
- `createRouteDecision(route, routeKind, record, extraValues)`
- 当前 route 的 `notificationRules`

禁止：

- 不调用 `forwardMessageAndWait`
- 不调用 Agent adapter
- 不写任何 JSONL 日志

返回建议：

```json
{
  "code": 0,
  "data": {
    "routeId": "main",
    "agentRoleId": "Rabi",
    "routeKind": "group_message",
    "matched": true,
    "matchedRules": [
      {
        "id": "rabi-group-keywords",
        "name": "Rabi 看板娘呼唤"
      }
    ],
    "missReasons": [],
    "warnings": []
  }
}
```

### agent-packet preview

作用：展示真实投递时 Agent 会看到的完整文本。

需要把当前 `buildAgentPacket` 路径拆出纯函数或提供 preview wrapper。真实链路现在会写通知日志并投递 Agent，预览不能直接走 `forwardMessageAndWait`。

禁止：

- 不写 `agent-packets.jsonl`
- 不 append role record
- 不发 Agent
- 不写 delivery replay ledger

返回建议：

```json
{
  "code": 0,
  "data": {
    "routeId": "main",
    "agentRoleId": "Rabi",
    "packets": [
      {
        "ruleId": "rabi-group-keywords",
        "message": "[RabiRoute 事件]\\n..."
      }
    ]
  }
}
```

### role-context preview

作用：展示这条消息会召回哪些计划、记忆和技能。

当前 `roleKnowledgeSnapshot` 会在命中记忆时刷新 `viewedAt`，预览需要新增无副作用选项，例如：

```ts
roleKnowledgeSnapshot(roleDir, messageText, {
  roleId,
  touchViewedAt: false,
  includePendingConsolidation: false
})
```

返回：

- 进行中计划。
- 近期记忆。
- 命中计划。
- 命中近期记忆。
- 命中沉淀记忆。
- 命中技能。
- 处理前必读项。

禁止：

- 不刷新 `viewedAt`。
- 不创建 memory consolidation run。
- 不写任何 memory 文件。

### route diagnostics

作用：做静态配置健康检查。

输入来自：

- 当前人格 `personaConfig.json`。
- 使用该人格的 route definitions。
- runtime status。

返回 warning，前端显示并提供定位按钮。

## 真实测试触发

真实测试和预览必须分开。

真实测试按钮只在用户明确点击后调用现有链路：

- `manual_trigger`
- 或 `role_panel_message`

不伪造 QQ 外发，也不假装有真实 QQ 消息。真实 QQ / RabiLink 的端到端测试仍通过对应消息端触发。

闭环：

| 项 | 真源 | 消费点 | 生效时机 | 验收 |
| --- | --- | --- | --- | --- |
| 手动触发测试 | 现有 manual trigger API | `triggerManualRule` -> `appendManualTriggerEvent` -> `forwardMessageAndWait` | 用户点击后 | 写 `manual-trigger-events.jsonl`、写 router / replay 日志、可能投递 Agent；返回 matched / delivered / failed |
| 角色面板测试 | role panel API | `POST /api/role-panel/messages` -> role panel 子进程触发 `role_panel_message` | 用户点击发送后 | 写 `role-panel/messages.jsonl`、可能投递 Agent |

## 实施步骤

1. 拆出 dry-run 纯逻辑
   - route decision preview。
   - AgentPacket preview。
   - role knowledge snapshot 无副作用模式。

2. 增加后端预览 API
   - 写单元测试验证无副作用。
   - 验证预览命中和真实 route decision 一致。

3. 改造人格配置页
   - 增加关联 route 摘要。
   - 增加预览与诊断区。
   - 保持 route 字段只读跳转。

4. 增加规则健康检查
   - 先做静态 warning。
   - 后续再根据真实 runtime status 增强。

5. 接入真实测试按钮
   - 明确和 dry-run 区分。
   - UI 上必须提示会写日志和投递 Agent。

## 验收标准

- 选择一个已绑定人格的 route，能看到当前 route 指向的人格 ID。
- 输入一条模拟 QQ 群消息，能看到是否命中该 route 下的人格规则。
- 文档和 UI 不出现“智能命中人格”“消息命中人格”这类错误口径。
- 文档和 UI 必须区分“单 route profile 预览”和“真实 gateway 投递会遍历 active routeProfiles”。
- 命中结果与真实 `createRouteDecision` 一致。
- AgentPacket 预览与真实投递内容一致。
- 预览不会新增 `agent-packets.jsonl`、不会投递 Agent、不会外发 QQ、不会更新 memory `viewedAt`。
- 人格页能列出所有使用该人格的 route。
- route 未启用对应消息端时，规则健康检查能提示。
- 真实测试只有用户明确点击才发生，并返回 delivered / failed / missed。

## 后续可选能力

这些不进入第一版：

- 多人格智能分流。
- 在人格页直接创建或编辑计划。
- 在人格页直接创建或编辑近期记忆。
- 技能 markdown 内嵌编辑。
- 真实 QQ / RabiLink 端到端自动测试。
- 基于历史日志的规则推荐。

这些能力都需要单独设计闭环后再加入。
