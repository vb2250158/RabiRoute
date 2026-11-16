> 历史任务材料，2026-11-14 标记。当前 C 盘源码与实装 Host 为 0.15.2（`dcfb8a42`）。本文保留原任务阶段内容，版本、行号及完成标记沿用原时点。当前行为结合[代码架构](code-architecture.md)、[Agent 接入规范](agent-adapter-standard-requirements.md)与正式验收证据核对。

# Agent 投递信封审计：markdown 格式与来源缺失

本文记录 RabiRoute 向 Agent 端投递正文时，投递信封（消息源 + 消息内容）的实际格式、全部投递路径，以及来源缺失时的降级缺陷。结论来自源码阅读与真机投递核对，不含推测。

## 背景与范围

投递信封是 Agent 收到消息时看到的前缀，包含「谁发的、哪个会话、什么时候发的」。它是 Agent 判断是否需要回复的唯一依据：正文可以自行理解，来源不能推断。

本次审计覆盖：

- `src/shared/rabiMessage.ts` 的信封渲染
- `src/agentThreads.ts` 的会话任务接口（create / send）
- 各 Agent adapter 的 `deliver(message)` 路径
- 真机投递结果（Codex rollout、DSH 会话）

不在范围内：消息渠道（QQ / 微信 / 飞书）的出站格式，计划与记忆的正文模板。

## 一、信封格式现状

结论：**已改为 markdown，但只覆盖了带来源的路径。**

`src/shared/rabiMessage.ts` 的头部常量（L55-56）：

```ts
export const RABI_MESSAGE_SOURCE_HEADER = "## 消息源";
export const RABI_MESSAGE_CONTENT_HEADER = "## 消息内容";
```

`stripLeadingRabiEnvelope`（L133-164）同时兼容旧的 `[消息源]` / `[投递源]` 方括号格式，说明历史上做过一次 `[...]` → `##` 的迁移。

`renderRabiDelivery`（L183-192）拼出的完整信封：

```markdown
## 消息源
- 类型：Agent｜处理端：codex
- 会话：术语统一｜Agent 端统一为示例任务
- 会话 ID：01a1d39d-0000-0000-0000-000000000000
- 工作目录：C:\Projects\Example
- 投递 ID：<uuid>
- 投递时间：2026/11/13 14:34:25

## 消息内容
<正文>
```

要点：

- 首行 `## 消息源`，其余每行由 `rabiMessageSourceLines`（L130）加 `- ` 前缀，形成 markdown 列表。
- 投递时间由 `deliverySentAt`（L86-89）生成，**有兜底**：取不到 `sentAt` 时用 `new Date().toLocaleString("zh-CN")`，因此只要进入 `renderRabiDelivery` 就一定有值。
- `## 消息内容` 头**只在** `renderRabiDelivery` 里加（L189）；`renderRabiDeliveryContent`（L195-213）只返回正文，不加头。

## 二、全部投递路径清单

按「是否经过 `renderRabiDelivery`」分三类。

### A 类：完整信封（`renderRabiDelivery`）

| 入口 | 位置 |
| --- | --- |
| 消息路由投递 | `src/forwarding.ts:44` |
| AgentPacket 正文 | `src/routing/agentPacket.ts:1217`、`:1518` |
| Endpoint 投递 | `src/agentRequests/endpointDelivery.ts:218` |
| RabiLink 会话复核 | `src/rabilinkConversationReviewer.ts:472` |
| 投递重放 | `src/deliveryReplay.ts:22` |
| 局域网 / 远端实例 | `src/agentAdapters/lanAgentAdapter.ts:25`、`:34`；`instanceClient.ts:43` |
| 设备 Agent | `src/agentAdapters/deviceAgentAdapter.ts:22`；`deviceAgentOwner.ts:136` |
| Grok Bot | `src/agentAdapters/grokBotAdapter.ts:213` |
| 各端 `deliver(message)` | `pluginImplementations/{codex,dsh,workbuddy,antigravity,astrbot,copilot-cli,marvis}.ts` 均为 `notify*(renderRabiDelivery(envelope))` |

### B 类：条件信封（`src/agentThreads.ts`）

| 路径 | 条件 | 结果 |
| --- | --- | --- |
| `createThread` (L730-738) | 有 `messageSource` | 完整 markdown 信封 |
| `createThread` (L730-738) | 无 `messageSource` | 只有正文，无 `## 消息源`、无 `## 消息内容`、无投递时间 |
| `send` (L1583-1603) | 有 `sendSource`（Agent 间投递） | 完整 markdown 信封 |
| `send` (L1583-1603) | 无 `sendSource` | 走 `standaloneWorkspacePolicyPrompt`，无来源则同样降级 |
| DSH `create`（create 分支内） | 有 `messageSource` | 完整 markdown 信封 |

### C 类：共享的降级函数

`standaloneWorkspacePolicyPrompt`（`src/agentThreads.ts:390-406`）：

```ts
if (!messageSource)
  return [
    ...(deliveryId ? ['[投递编号]\ndeliveryId: ' + deliveryId] : []),
    renderRabiDeliveryContent({ messageContent: rawPrompt, contextBlocks, controlBlocks })
  ].join('\n\n');
return renderRabiDelivery({ messageSource, ... });
```

无来源时的输出只有正文本身，或「`[投递编号]` + 正文」。**这是所有降级表现的唯一根因。**

## 三、缺陷清单

### D1：来源缺一个字段就整体丢弃（静默）

位置：`src/agentThreads.ts` 的 `describeAgentThreadMessageSource`。

```ts
const provider  = input.agentAdapter ?? context?.provider;
const sessionId = input.sessionId    ?? context?.sessionId;
if (!provider || !sessionId) return undefined;
```

实际表现：调用方传了 `agentAdapter` 但漏 `sessionId`（或反之）时，整个来源对象变成 `undefined`，**不报错、不告警、响应里也没有任何提示**。

影响：调用方以为自己传了来源，实际投出去的消息没有来源段，且没有任何反馈渠道能发现这件事。

### D2：无来源时不渲染信封，连内容头都没有

位置：`standaloneWorkspacePolicyPrompt` 的 `!messageSource` 分支。

实际表现：正文直接以内容第一行开头。真机核对确认，Codex 会话的 rollout 中，首条 user 消息的第一行就是调用方正文，前面没有任何 header。

影响：

- Agent 无法判断消息来源，也无法按信封格式解析。
- 与「已统一为 markdown」的产品预期不一致：同一套接口，有来源时是 markdown 信封，无来源时退化为纯文本。
- 由于没有 `## 消息内容` 头，「正文是否已带信封」无法用统一规则判断，重放与回执恢复都受影响。

### D3：来源字段无兜底，直接传空对象会渲染出 undefined

位置：`agentSourceLines`（`src/shared/rabiMessage.ts:76-84`）。

```ts
`会话：${source.sessionName}`,
`会话 ID：${source.sessionId}`,
```

这两行没有经过 `optionalLine` 包裹，而 `normalizeAgentIdentity`（L251-265）对 `sessionName` / `sessionId` 用的是 `requiredSourceText`，空值直接抛错。

影响：不能简单地「传空对象让它兜底」。修复必须落在渲染层，而不是在上游塞空值，否则会渲染出 `会话：undefined` 或触发 `Missing messageSource.sessionId.`。

### D4（关联项）：`agentThreads` 的 create 与 send 对信封的处理不对称

`createThread` 与 `send` 各自调用 `standaloneWorkspacePolicyPrompt`，条件判断分散在两处；同时 DSH 的 create 分支又在自己的路径里重复了一次组装。三条路径共享同一函数，但都没有统一「必须有信封」的约束。

## 四、影响面

| 场景 | 是否受影响 |
| --- | --- |
| 消息路由投递（QQ / 微信 / 飞书等触发） | 否，A 类始终有信封 |
| 计划、记忆、Heartbeat 投递 | 否，走 A 类 |
| 会话任务 create（带来源） | 否 |
| 会话任务 create（不带来源） | **是** |
| 会话任务 send（Agent 间，带 `sendSource`） | 否 |
| 会话任务 send（无 `sendSource`） | **是** |
| 外部调用方用 HTTP 直接调 `/api/agent/threads` | **是**（裸 HTTP 没有宿主上下文，来源只能手填） |

## 五、修复建议

按层修正，不建议在调用方逐个补字段。

1. **渲染层兜底**：`agentSourceLines` 的 `会话` 与 `会话 ID` 改走 `optionalLine`，缺值渲染为「未知」，不再依赖上游必填。
2. **降级不丢信封**：`standaloneWorkspacePolicyPrompt` 的 `!messageSource` 分支也要输出 `## 消息源` 段，字段填「未知」，并保留投递时间与投递 ID。这样无论有没有来源，格式始终一致。
3. **输入层可见**：`describeAgentThreadMessageSource` 缺字段时不要静默返回 `undefined`；返回 `{ messageSource, missing: [...] }` 或至少在响应里带 `warnings`（与 `/api/scan/agents` 的 warnings 同形状）。
4. **路径收敛**：`createThread` / DSH create / `send` 三处统一走一个组装函数，避免条件判断分散。
5. **文档同步**：`docs/agent-thread-api-contracts.md` 的 `list`/`read` 描述需与实现对齐（当前写「返回原生会话内容」，实际只返回会话元数据）。

不采纳的做法：缺字段时返回 400 强制补全。原因是外部调用方在很多场景下确实拿不到来源，拒绝会让投递不可用；写「未知」比拒绝更符合实际使用。

## 六、字段完备性

原则：**不强制要求来源，但已有信息必须尽可能写进信封**。信封的目的是让 Agent 判断「谁发的、什么时候、要不要回」，不是审计日志；字段要齐，但不能长到淹没正文。

### 现有字段

| 字段 | 来源 | 是否必现 |
| --- | --- | --- |
| 类型 | `messageSource.type` | 有来源时必现 |
| 处理端 | `messageSource.agentAdapter` | 有来源时必现 |
| 角色 | `messageSource.agentType` | 可选，值为 `agent` 时省略 |
| 会话名称 | `messageSource.sessionName` | 有来源时必现（无兜底，见 D3） |
| 会话 ID | `messageSource.sessionId` | 有来源时必现（无兜底，见 D3） |
| 工作目录 | `messageSource.workspace` | 可选 |
| 投递 ID | `envelope.deliveryId` | 可选 |
| 投递时间 | `envelope.sentAt` | 必现（有当前时间兜底） |
| 上下文块 | `contextBlocks` | 可选，放在正文之后 |
| 控制块 | `controlBlocks` | 可选，含回传参数 |

### 已知但未进信封的信息

以下信息在投递请求里已经存在，却没有写进信封，属于「可以补齐全」的候选：

| 信息 | 所在位置 | 建议 |
| --- | --- | --- |
| 目标端 | `agentAdapter` + `threadId` | 建议进信封，Agent 才能确认「这条是投给我的」而不是被转发的 |
| 模型 / 推理强度 | `request.model`、`request.reasoningEffort` | 建议进信封，便于 Agent 判断自身能力与输出预期 |
| 沙箱 | `request.sandbox` | 建议进信封，权限预期应与执行边界一致 |
| 回复策略 | `responsePolicy`、`responseInstruction` | 已在控制块的回传参数内，保持现状即可 |
| 关联请求 | `inReplyToRequestId` | 建议进信封，回复链才可追溯 |
| 消息路线 | `routeName`、`routeId` | 仅 `message_adapter` 源有；agent 源建议补 Route 归属 |
| 角色目录 | `agentRolePath` | 不进信封，正文已带相对路径 |

### 边界

- 凭据、token、私聊全文、绝对敏感路径不进信封。
- 信封字段固定为单行短值，超长截断，避免正文被挤到视野外。
- 新字段一律走 `optionalLine`，缺值不渲染或渲染为「未知」，不允许出现 `undefined`。

## 七、验收要点

- 不带 `messageSource` 调 `create`，正文仍以 `## 消息源` 开头，字段为「未知」，含投递时间。
- 只传 `agentAdapter` 不传 `sessionId`，响应带可见的 warning 或 `missing` 字段。
- 带完整来源调 `create`，输出与 A 类信封逐字段一致。
- 同一任务连续投递两次，信封格式不变，不产生新任务。
- `renderRabiDelivery` 的现有快照测试（`src/shared/rabiMessage.test.ts`）保持通过。

## 附：核对命令

```bash
# 信封常量与渲染
grep -n "RABI_MESSAGE_SOURCE_HEADER\|RABI_MESSAGE_CONTENT_HEADER" src/shared/rabiMessage.ts

# 降级分支
sed -n '390,406p' src/agentThreads.ts

# 真机核对：投递正文是否带信封
grep -c "^## 消息源" ~/.codex/sessions/<年>/<月>/<日>/rollout-*-<threadId>.jsonl
```

## 相关文档

- [Agent 会话控制接口合同](agent-thread-api-contracts.md)
- [Agent 需要关注的 Rabi 接口](rabi-agent-interfaces.md)
- [标准 Agent 端接入需求](agent-adapter-standard-requirements.md)

> 英文版待补：本文件当前仅中文。补译时保持章节结构一致。
