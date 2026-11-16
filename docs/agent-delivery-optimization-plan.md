> 历史任务材料，2026-11-14 标记。当前 C 盘源码与实装 Host 为 0.15.2（`dcfb8a42`）。本文保留原任务阶段内容，版本、行号及完成标记沿用原时点。当前行为结合[代码架构](code-architecture.md)、[Agent 接入规范](agent-adapter-standard-requirements.md)与正式验收证据核对。

# 投递与组装优化方案

本文是 [消息组装架构](message-assembly-architecture.md) 与 [Agent 投递信封审计](agent-delivery-envelope-audit.md) 两份审计的执行方案。只列可落地的改动项、边界与验收，不重复背景。

## 一、前提与基线（先读这一节）

| 事实 | 影响 |
| --- | --- |
| 仓库在 `main`，`package.json` 为 0.6.0 | 本方案的源码真源是当前工作树，不是运行中的 0.14.2 产物 |
| 工作区有 **215 处未提交改动**，其中 `src/` 120 处 | 禁止整文件格式化、禁止重排 import、禁止回滚已有改动 |
| `src/agentThreads.ts`、`src/shared/rabiMessage.ts` 干净 | O1、O3 可直接改 |
| `src/routing/agentPacket.ts` 有 3 行未提交改动（远端角色提示词） | O2 只允许局部插入，不得覆盖该段 |
| `src/forwarding.ts` 有 21 行未提交改动 | 本方案不修改该文件 |

执行前先跑一次 `git status --short` 记录基线；交付时对比，确认只多出本方案的文件。

## 二、优化项

按「收益 ÷ 风险」排序，O1 与 O2 是第一批。

### O1 信封降级补「未知」，两条链路同构

**问题**：`standaloneWorkspacePolicyPrompt` 在 `!messageSource` 时只拼正文，连 `## 消息内容` 头都没有（详见审计 D2）。

**改动点**

1. `src/shared/rabiMessage.ts`
   - 新增常量 `RABI_MESSAGE_UNKNOWN = "未知"`。
   - `agentSourceLines`（约 L76-84）中 `会话：${source.sessionName}`、`会话 ID：${source.sessionId}` 改为 `optionalLine(...) ?? "会话：" + RABI_MESSAGE_UNKNOWN` 形式，保证不出现 `undefined`。
   - 不改 `normalizeRabiMessageSource` 的必填校验，继续拒绝非法来源；兜底只发生在渲染层。

2. `src/agentThreads.ts`
   - `standaloneWorkspacePolicyPrompt`（约 L390-406）的 `!messageSource` 分支改为始终输出：
     ```
     ## 消息源
     - 处理端：未知
     - 会话：未知
     - 会话 ID：未知
     - 投递 ID：<deliveryId>（有则输出）
     - 投递时间：<当前时间>

     ## 消息内容
     <正文>
     ```
   - `renderRabiDeliveryContent` 仍然只返回正文，`## 消息内容` 头由 `standaloneWorkspacePolicyPrompt` 补。

**风险**：低。只影响无来源路径，有来源路径输出不变。

**验收**
- 不带 `messageSource` 调 `create`，Codex rollout 首行是 `## 消息源`。
- 带完整来源调 `create`，输出与改动前逐字节一致（用现有快照测试守住）。
- `src/shared/rabiMessage.test.ts` 全绿。

### O2 精简包补消息身份

**问题**：`buildAgentMessage` 的「当前情况」只有事件标题，无 `messageId`、无引用链（详见架构文档 P2）。

**改动点**：`src/routing/agentPacket.ts` 的 `buildAgentMessage`（约 L1164-1173），在「当前情况」段落内新增：

- `消息 ID：${record.messageId}`（无值走 `optionalLine` 跳过）
- `引用消息：<被引用消息 ID 列表>`（来源 `record.replyContext`，无值跳过）
- `消息组：<messageGroupMessageIds 去重后拼接>`（无值跳过）

**约束**：只在该段数组内追加元素，不动 `routes` 之外的提示词行，不重排。

**风险**：中低。段落变长，但均为单行短值。

**验收**
- 投递正文的「当前情况」段出现 `消息 ID：`。
- 引用消息的群聊场景出现 `引用消息：`。
- `src/routing/agentPacket.test.ts` 通过；若有快照断言，按新增字段更新并在变更说明中列出。

### O3 来源缺失可见化

**问题**：`describeAgentThreadMessageSource` 缺字段即整体返回 `undefined`，静默（详见审计 D1）。

**改动点**：不改该函数签名（避免扩散），在 `agentThreads.ts` 的 `create` / `send` 响应 `data` 里增加 `warnings: string[]`：

- 传了 `messageSource` 但解析结果为 `undefined` → `["messageSource 缺少 agentAdapter 或 sessionId，本次投递使用「未知」来源"]`
- 完全没传 `messageSource` → `["未提供 messageSource，本次投递使用「未知」来源"]`

**风险**：低。纯增量字段。

**验收**
- 只传 `agentAdapter` 不传 `sessionId`，响应含上述 warning。
- 不传来源，响应含 warning，且投递仍成功。

### O4 组装器收敛（本批只出设计，不改代码）

三套组装器（`buildAgentMessage` / `buildDetailedAgentMessage` / `messageGroupPrompt`）收敛为一份段落清单定义，段落按需启用。同时明确 `contextDetail` 的产品含义：要么路由可配置，要么删除分支。

**本批交付**：一份设计说明，含段落清单表、启用规则、迁移步骤。不改运行代码。

## 三、执行顺序

```
O1 → O3（同文件，一次改完）
O2（独立文件，可与 O1 并行）
O4（只出设计文档）
```

三批都完成后跑一次完整验收，不要中途提交。

## 四、验收清单

- [ ] `npm run build` 通过
- [ ] `npm run webgui:build` 不需要（本次不碰前端）
- [ ] 相关单测通过：`rabiMessage.test.ts`、`agentThreads.test.ts`、`agentPacket.test.ts`
- [ ] 真机核对：无来源 `create` 的 rollout 首行为 `## 消息源`
- [ ] 真机核对：带来源 `create` 的信封字段与改动前一致
- [ ] `git status` 对比基线，只多出本方案涉及的文件

## 五、明确不做

- 不改任何 wire 值：`agentThreads` 能力值、`threadId` / `sessionId` / `agentAdapter` 字段名、`/api/agent/threads` 路由
- 不重命名 `src/` 下的类型与函数
- 不重排、不格式化整文件
- 不回滚工作区已有的 215 处未提交改动
- 不打安装包、不执行发布
- 不改 `.workbuddy/memory/` 下的文件

## 相关文档

- [消息组装架构](message-assembly-architecture.md)
- [Agent 投递信封审计](agent-delivery-envelope-audit.md)
- [Agent 会话控制接口合同](agent-thread-api-contracts.md)

> 英文版待补：本文件当前仅中文。
