> 历史任务材料，2026-11-14 标记。当前 C 盘源码与实装 Host 为 0.15.2（`dcfb8a42`）。本文保留原任务阶段内容，版本、行号及完成标记沿用原时点。当前行为结合[代码架构](code-architecture.md)、[Agent 接入规范](agent-adapter-standard-requirements.md)与正式验收证据核对。

# 消息组装架构

本文梳理 RabiRoute 从一条原始消息到 Agent 可读 prompt 的完整组装链路，包括入口、路由、上下文组装、投递信封、投递与回传五层，以及三套并存的组装器。结论来自源码阅读，标注了精确位置。

## 一、五层链路

```
消息入口 → RouteDecision → 上下文组装 → 投递信封 → Agent 投递
                                                      ↓
                                                  回复与会话
```

| 层 | 主要位置 | 职责 |
| --- | --- | --- |
| 消息入口 | `src/adapters/*` | QQ / 微信 / 企微 / 飞书 / Webhook / RapLink / 语音 / 健康 / 心跳，产出 `ForwardRecord` |
| 路由决策 | `src/routing/routeDecision.ts` | 按 `personaConfig.json` 规则匹配，产出 `RouteDecision` |
| 上下文组装 | `src/routing/agentPacket.ts` | 把记录、角色、计划、记忆、技能索引拼成段落 |
| 投递信封 | `src/shared/rabiMessage.ts` | `## 消息源` + `## 消息内容` |
| Agent 投递 | `src/forwarding.ts`、`src/agentThreads.ts` | `deliver()`、`/api/agent/threads`、endpoint |
| 回复与会话 | `src/agentSend.ts` | Outbox、`/api/agent/send`、投递账本 |

## 二、三套组装器

### 2.1 主 Agent 包（精简版，生产）

位置：`buildAgentMessage`，`src/routing/agentPacket.ts:1146-1218`。

段落（`contextBlocks`）：

| 段落 | 内容 |
| --- | --- |
| 当前情况 | 事件**标题**、角色、路由类型、来源设备、事件时间、触发、处理主机、声纹 |
| 近期情况 | 最近 3 条，每条截断 300 字 |
| 附件 | 由 `attachmentLines` 生成 |
| 角色入口 | 仅远端角色：所属电脑、查询地址 |
| 待整理记忆 | 仅 `manual_trigger` + `memory-consolidation` |

正文（`messageContent`）：原始消息 + 「补充」段。
控制块（`controlBlocks`）：`查询入口`（`GET /api/agent/help`、回传定位）。

调用点：`src/forwarding.ts:1124` —— 全仓唯一生产调用，未传 `contextDetail`。

### 2.2 主 Agent 包（详细版，仅测试）

位置：`buildDetailedAgentMessage`，`src/routing/agentPacket.ts:1220-1521`。

二十个段落：事件信息、最近消息、聊天已读索引、消息附件、当前讨论片段、紧邻对话、消息代码解析、身份定位（语音账号）、身份定位、情景记录、移动端配置助手、远端角色、角色和路径、无角色直通模式、远端角色正文、远端记忆与计划、记忆与计划、计划协助会话、处理前上下文确认、全天语音与声纹归类、日志、远端电脑、远端 Agent 设备。

调用条件：`options.contextDetail === "full"`。全仓只有 `src/routing/agentPacket.test.ts`、`remotePersonaClient.test.ts`、`routeDecision.test.ts` 传入该值。

### 2.3 消息处理 Agent 组包

位置：`messageGroupPrompt`，`src/forwarding.ts:311`，经 `deliverPacketToMessageAgent`（`:333`）投递。

用于启用「消息处理 Agent」后的消息组调度，不经过上面两个版本。具体段落在该函数内联拼接。

## 三、两版差异的关键

| 信息 | 精简版 | 详细版 |
| --- | --- | --- |
| 事件标题 | 有 | 有 |
| 消息 ID | **无** | 有 |
| 引用链 / 被 @ 原貌 | **无** | 有 |
| 消息代码解析（CQ 码） | **无** | 有 |
| 身份定位与说话习惯 | **无** | 有 |
| 情景记录 | **无** | 有 |
| 计划协助会话 | **无** | 有 |
| 日志路径 | **无** | 有 |
| 远端电脑 / 设备入口 | **无** | 有 |

结论：生产主 Agent 拿不到「消息 ID、引用链、被 @ 的原始代码」这三类强证据。回复时若需要精确引用原消息，只能依赖 `sendRequestJson` 里的发送定位（`routeId` / `channel` / `params`），而不是消息身份。

## 四、发现的问题

**P1 两版并存且生产只用精简版。** `contextDetail` 没有生产调用方，二十段详细组装在运行时不可达。文档（`docs/current-capabilities.md` 第 85 行）描述的能力与实际启用版本不一致。

**P2 精简版缺消息身份。** 「事件」段只有标题，没有 `messageId`；近期情况最多 3 条且每条截断 300 字。对需要按消息 ID 回执、去重、引用核对的流程，证据不足。

**P3 信封完整性依赖来源存在。** 详见 [Agent 投递信封审计](agent-delivery-envelope-audit.md)：无 `messageSource` 时信封整段消失。

**P4 三套组装器没有共同契约。** 段落结构、信封处理、来源构造分别实现，没有共享的段落清单或字段完备性检查。

## 五、建议

1. 明确 `contextDetail` 的产品含义：要么让路由配置可选择详细版，要么删除该分支并把需要的段合并进精简版。不建议保留"仅测试可达"的第二种实现。
2. 精简版补两项低成本、高价值的证据：`messageId` 与引用链 ID。它们已在 `record` 上，不需要额外查询。
3. 三套组装器收敛到同一份「段落清单」定义，段落按需启用，而不是按函数分叉。
4. `docs/current-capabilities.md` 的 AgentPacket 描述与启用版本对齐，注明哪些段只在详细版。

## 相关文档

- [Agent 投递信封审计](agent-delivery-envelope-audit.md)
- [代码架构](code-architecture.md)
- [标准 Agent 端接入需求](agent-adapter-standard-requirements.md)

> 英文版待补：本文件当前仅中文。
