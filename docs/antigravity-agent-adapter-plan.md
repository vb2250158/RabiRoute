<!-- docs-language-switch -->
<div align="center">
<a href="./antigravity-agent-adapter-plan_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Antigravity 作为 Agent 端的接入方案

本文记录把 Antigravity 接入 RabiRoute，使其具备与 Codex 端同等能力的设计与实现。文中所有事实均来自本机只读探测与既有实现，不含推测。

## 1. 目标与范围

让 RabiRoute 能把消息投递到本机 Antigravity 会话，并复用与 Codex 端一致的托管能力：

- 消息投递（唯一真实路径）
- 投递回执恢复
- 会话发现与工作区枚举
- 计划助手会话（Plan assistant session）绑定
- 生命周期的 Hook 注入与事件上报

不在范围内：Antigravity 的模型选择策略、桌面 UI 改动、以及任何需要修改宿主二进制的做法。

## 2. 零号关卡：用户可观察合同

从用户角度看，接入完成后应当满足：

1. 在路由设置里选择 Antigravity 作为主 Agent，能列出本机已有会话并选中；
2. 发一条消息，它真实出现在该 Antigravity 会话里，并由该会话的模型与工具执行；
3. 会话侧栏显示的名字与路由里绑定的一致；
4. 重启 RabiRoute 后，绑定关系仍然有效，续投不新建会话；
5. Antigravity 会话里的轮次结束时，RabiRoute 能收到事件。

## 3. Owner 与生命周期

**Antigravity 桌面应用是会话的 owner。** RabiRoute 不是执行者，也不启动备用运行时。消息进入会话后，由该会话以其自带的模型、工具、权限与工作区状态执行。

这一点决定了三件事：

- 投递只是「把文本交给 owner」，RabiRoute 不代为推理；
- 绑定必须保存会话 ID 与 owner 类型，重启后按同一 ID 续投；
- Hook 采集到的状态用于汇报，不用于替代 owner 的执行。

## 4. 产品形态判定

Antigravity 是**桌面应用**，不是命令行会话。它同时提供一个 `agy` CLI，但该 CLI 的作用是访问正在运行的桌面实例，而不是启动独立会话。因此：

- 传输协议是「桌面实例的官方程序化接口」，不是进程管道；
- 宿主必须在运行，投递才有目标；
- 清单里声明 `host.required: true`。

## 5. 已核实事实

以下均为本机实测结论。

### 5.1 官方程序化接口 `agy agentapi`

`agy` 提供三个文档化的子命令，是唯一受支持的程序化投递入口：

| 子命令 | 作用 | 写入会话时的身份 |
|---|---|---|
| `new-conversation` | 新建会话并投递首条消息 | `source: USER_EXPLICIT` / `type: USER_INPUT` |
| `send-message <conversationId> <prompt>` | 向指定会话追加消息 | `source: SYSTEM` / `type: SYSTEM_MESSAGE` |
| `get-conversation-metadata` | 读取会话元数据 | — |

关键性质：**投递目标由参数显式指定**。这消除了「投到哪里取决于 UI 当前打开哪个会话」的类别风险，也是本方案选择它而非驱动渲染层的原因。

### 5.2 agentapi 需要的环境变量

三个值都属于**正在运行的实例**，因此都在调用时动态发现，不需要用户配置：

| 变量 | 来源 | 发现方式 |
|---|---|---|
| `ANTIGRAVITY_LS_ADDRESS` | language server 的 gRPC 端口 | `tasklist` 找到 `language_server.exe` 的 PID，再按 PID 在 `netstat -ano` 中定位 `127.0.0.1:<port>` 且状态为 `LISTENING` 的条目 |
| `ANTIGRAVITY_CSRF_TOKEN` | 每次启动重新生成 | 读取 `%APPDATA%/Antigravity/logs/main.log` 中**最后一条** `--csrf_token <uuid>` |
| `ANTIGRAVITY_PROJECT_ID` | 固定值 | 默认 `outside-of-project` |

两个必须注意的陷阱：

- **端口区分协议。** language server 同时监听 UI 端口（7299，HTTPS）与 gRPC 端口。连错端口会得到 `http2: frame too large ... HTTP/1.1 header` 这类误导性报错。发现逻辑显式排除 7299。
- **失败也走 stdout。** `agy agentapi` 出错时把 JSON 放在 stdout 并返回非零退出码，所以调用方在捕获异常后仍需解析 stdout，否则会把可读的错误信息丢掉。

### 5.3 会话索引真源

会话列表的真源是 SQLite 库：

```
~/.gemini/antigravity/conversation_summaries.db
```

桌面侧栏读的就是它。要点：

- `title` 是**唯一**的显示名字段，不存在独立的用户命名字段；
- `last_user_input_step_index = -1` 是「该会话从未收到用户轮次」的可靠信号，用于过滤空会话；
- `app_data_dir` 区分会话归属（桌面应用为 `antigravity`，CLI 为 `agy`）。不按此过滤会把无关会话列出来。

读取在子进程中用 Node 内置的 `node:sqlite` 完成，因此不引入第三方 SQLite 依赖。

### 5.4 会话记录

每个会话的逐条记录位于：

```
~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript_full.jsonl
```

Hook 会直接把该路径交给插件，所以回执恢复与「上一条用户输入是什么」都能直接读，不需要扫描目录。

### 5.5 会话 ID 的形状（重要约束）

**Antigravity 的会话 ID 是标准 UUID**（例如 `a1e8f5ce-7e09-47d2-833f-ea27f532810b`），而 **Codex 的 task ID 也是标准 UUID**。两者格式完全相同。

由此产生一条硬性设计约束：

> 任何需要知道会话归属的代码，都必须读取持久化的 `agentType`，**不得**从 ID 形状推断。

早期实现中若干处使用 `agentType === "dsh" ? "dsh" : "codex"` 的写法，会把 Antigravity 会话静默改写成 Codex，进而投递到错误的会话。本次一并修正。

### 5.6 Hook 事件与注册

Antigravity 提供五个生命周期事件：

| 事件 | 时机 |
|---|---|
| `PreToolUse` | 工具调用前 |
| `PostToolUse` | 工具调用后 |
| `PreInvocation` | 轮次开始前 |
| `PostInvocation` | 轮次结束后 |
| `Stop` | 会话停止 |

三个必须遵守的宿主行为：

1. **注册需要双写。** 插件目录 `~/.gemini/config/plugins/<name>/` 必须存在，**并且**插件名要出现在 `~/.gemini/config/config.json` 的 `plugins.<name>.enabled`。只做前者时宿主静默忽略，完全没有 hook 调用。配置是热加载的，不需要重启。
2. **`PreToolUse` 返回 `{}` 表示拒绝。** 放行必须显式返回一个对象；返回空值会被当作 deny。
3. **Hook 命令的工作目录是插件根目录。** 因此命令写相对路径 `node scripts/xxx.mjs`；宿主不经过 shell，所以也没有 shell 展开。

Hook 输入中包含的字段：`conversationId`、`transcriptPath`、`artifactDirectoryPath`、`initialNumSteps`、`modelName`、`workspacePaths`，以及恒为 0、不可用于计数的 `invocationNum`。

Hook 输出的注入形状是 `injectSteps[].userMessage`，**没有** `additionalContext`。注入的步骤在会话记录里标记为 `source: SYSTEM_SDK`，因此能与真实用户轮次区分。

## 6. 唯一真实消息路径

```
RabiRoute 路由
  → antigravityRuntime.deliver（队列串行 + 状态机）
    → antigravityBridge.deliverAntigravityPrompt
      → 解析运行环境（gRPC 地址 / CSRF / projectId）
        → agy agentapi send-message | new-conversation
          → Antigravity 桌面实例
```

选型规则：

- 配置了会话 ID → `send-message`，投递到该会话；
- 未配置会话 ID → `new-conversation`，新建会话并把返回的会话 ID 记下来。

两条路径都会写入 adapter 日志（`delivery_accepted` / `delivery_delivered` / `delivery_failed`），且失败时先记账再抛出，保证「投递失败」这件事本身不会丢失。

## 7. 身份与 resolver 合同

| 入口 | 写入记录的身份 |
|---|---|
| `agentapi send-message` | `source: SYSTEM` / `type: SYSTEM_MESSAGE` |
| `agentapi new-conversation` | `source: USER_EXPLICIT` / `type: USER_INPUT` |
| Hook `injectSteps` | `source: SYSTEM_SDK` / `type: USER_INPUT` |

RabiRoute 侧的身份映射：

- 路由绑定 → `antigravityConversationId`（路由键）、`antigravityConversationName`（显示名）、`antigravityCwd`（工作区）；
- 投递时以 `conversationId` 作为会话路由键，同一会话续投不会新建；
- 计划绑定 → `PlanTaskBinding.agentType = "antigravity"`，与 `sessionId` 一同持久化。

## 8. 能力等级

清单中声明为 `experimental`，五项托管能力全部给出：

| 能力 | 状态 |
|---|---|
| `messageProcessingAgent` | 支持 |
| `planAssistantSessions` | 支持 |
| `memoryConsolidationAgent` | 支持 |
| `hooks` | 支持 |
| `deliveryReceiptRecovery` | 支持 |

成熟度定为 `experimental` 而非 `verified`，理由只有一个：投递依赖宿主 CLI 的子命令契约，宿主版本升级可能改动它。这与传输本身是否可靠无关。

## 9. 代码落点

| # | 落点 | 文件 |
|---|---|---|
| 1 | 能力声明 | `src/shared/agentAdapterCapabilities.ts` |
| 2 | 配置模型 | `src/shared/gatewayConfigModel.ts`、`src/config.ts` |
| 3 | 会话发现 | `src/antigravitySessionStore.ts` |
| 4 | 投递通道 | `src/antigravityBridge.ts` |
| 5 | 运行时 | `src/antigravityRuntime.ts` |
| 6 | 回执恢复 | `src/antigravityReceipt.ts` |
| 7 | 适配器注册与扫描 | `src/agentAdapters/builtinAgentAdapters.ts`、`src/agentAdapters/antigravityManagerApi.ts`、`src/agentAdapters/managerApi.ts` |
| 8 | Hook 包与安装器 | `plugins/rabi-antigravity-context/`、`src/agentAdapters/hookInstallation.ts` |
| 9 | 绑定校验 | `src/shared/agentInstance.ts` |
| 10 | 计划与线程链路泛化 | `src/roleKnowledge.ts`、`src/manager/planAgentStatus.ts`、`src/manager/planTaskBindingDelivery.ts`、`src/manager/controlPlaneRoutes.ts`、`src/agentThreads.ts`、`src/forwarding.ts` |
| 11 | 能力消费点去字面量 | `src/shared/codexPlanAssistantSessions.ts`、`src/shared/agentHookAutomation.ts`、`src/shared/codexSessionInitialization.ts` 等 |
| 12 | WebGUI | `ribiwebgui/src/pages/RouteConfigPage.vue`、`ribiwebgui/src/components/QuickSetupDialog.vue`、`ribiwebgui/src/stores/gatewayStore.ts`、`ribiwebgui/src/i18n/catalog.ts` |
| 13 | 文档 | 本文件及其英文版 |

### 9.1 关于「能力消费点去字面量」

把 Antigravity 接进来时暴露出一个结构性缺陷：`src/` 下曾有 21 处把 `"codex" | "dsh"` 写成联合类型。后果分两类：

- **直接造成错误行为**：`binding?.agentType === "dsh" ? "dsh" : "codex"` 会把 Antigravity 改写成 Codex；`raw.agentType !== "codex" && raw.agentType !== "dsh"` 会直接拒绝它。这两处涉及投递目标，属于必须修的缺陷。
- **纯类型标注过窄**：新增适配器时类型系统不会报错，只是静默缺席。

修法不是把这些地方逐个加 `|| "antigravity"`，而是**让类型从能力清单派生**：

```ts
export const planAssistantAgentTypes = agentAdapterTypes.filter(
  (type) => manifestsByAgentType[type].capabilities.managedTasks?.planAssistantSessions === true
);
export type PlanAssistantAgentType = typeof agentAdapterTypes[number];
```

这样下一个适配器只需在清单里声明能力，消费点自动生效，不需要再改一遍 21 处。

同时新增 `normalizePlanBindingAgentType()`，把「字段缺失」与「字段存在但不可识别」分开处理：前者回退到历史默认值，后者直接报错。原来的写法会把后者也悄悄回退，那正是投递到错误会话的成因。

## 10. 验收测试矩阵

自动化测试（`src/antigravity*.test.ts` 共 53 项 + hook 包 17 项，全部通过）：

| 文件 | 项数 | 覆盖 |
|---|---|---|
| `src/antigravityBridge.test.ts` | 19 | CLI 路径优先级、CSRF 取最后一条、端口发现排除 UI 端口与非本进程端口、非 Windows 拒绝、环境三件套、两条投递路径的参数与 env、空 prompt 与缺会话 ID 拒绝、**非零退出仍解析 stdout** |
| `src/antigravityReceipt.test.ts` | 15 | 路径推导、字段解析、畸形行跳过、回执命中、**`initialNumSteps` 阻止匹配到同文本的历史投递**、回复早于 prompt 不算回答 |
| `src/antigravityRuntime.test.ts` | 8 | accepted→delivered、未配置走 new-conversation、失败先记账再抛、**回执读失败不影响已完成的投递**、并发串行化、日志上限 |
| `src/antigravitySessionStore.test.ts` | 11 | 索引路径、排序、空会话过滤、归属过滤、搜索与分页、Window 路径大小写、工作区去重与 URI 解码、老格式兼容 |
| `plugins/rabi-antigravity-context/hooks.test.mjs` | 17 | 事件映射、conversationId→sessionId、workspacePaths→cwd、从 transcript 读 prompt、注入形状是 `injectSteps`、**PreToolUse 放行返回 `{}`**、**Manager 故障时不阻断工具**、Stop 合成跟进原因、无会话 ID 时 fail closed |

真机验收（需要在 Antigravity 运行时执行）：

1. 列出会话：路由设置中能选择已有会话，空会话不出现在列表里；
2. 投递：发一条消息，确认它出现在目标会话中，且身份为 `SYSTEM`；
3. 新会话：清空会话 ID 投递，确认新建会话并在返回中拿到会话 ID；
4. 续投：在同一会话连续投递两次，确认没有新建会话；
5. Hook：安装插件包后触发一次轮次，确认 `PreInvocation`、`PostToolUse`、`Stop` 都被调用；
6. 回执恢复：人为中断一次投递，确认能从 transcript 恢复出回执。

## 11. 安全与隐私

- 投递目标由参数显式指定，不依赖 UI 状态，因此不存在「打到当前打开会话」的风险；
- Hook 在没有 `conversationId` 时 fail closed，避免把上下文写进别人的会话；
- `PreToolUse` 遇到 Manager 故障时**不**阻断工具调用——否则 Manager 重启会表现为宿主故障；
- CSRF 令牌按次读取，不落盘、不进日志；
- 会话索引只读打开（`file:...?mode=ro`）。

## 12. 性能注意事项

`tasklist` 单次调用实测约 **580 ms**（它要启动一个进程）。宿主存活探测原本每次调用都执行它，而 manager 扫描会频繁调用，因此改为两级策略：

1. 用 `%APPDATA%/Antigravity/logs/main.log` 的 mtime 做初筛（实测 **2 ms**）；
2. 仅当该信号不可用时才落到进程表检查；
3. 结果缓存 10 秒。

实测从 **580 ms 降到 0.7 ms**。这同时解决了一个回归：某测试要求整个扫描在 1000 ms 内完成，而单次探测就占掉 600 ms。

## 13. 风险与停止条件

| 风险 | 说明 | 缓解 |
|---|---|---|
| 子命令契约变更 | 宿主升级可能改动 `agentapi` 参数 | 成熟度标为 `experimental`；投递失败会明确报错而非静默降级 |
| 日志格式变更 | CSRF 依赖 `main.log` 中 `--csrf_token` 的写法 | 找不到时明确提示「请先启动 Antigravity 桌面」，不返回空值 |
| 索引 schema 变更 | 依赖 `conversation_summaries.db` 的列名 | 读取失败会记录 warning 并返回空列表，不影响其他适配器 |
| ID 无法区分 owner | Antigravity 与 Codex 都用 UUID | 所有链路强制持久化 `agentType`，不作形状推断 |

停止条件：若宿主升级后 `agentapi` 不再接受显式会话 ID，则投递安全性前提消失，应停止使用并回到能力声明层面撤回，而不是退回驱动渲染层。

## 14. 与现有文档的关系

- `docs/agent-adapter-standard-requirements.md`：适配器接入的标准要求，本文是其一个实例；
- `docs/agent-adapter-integration-lessons.md`：接入过程中的跨适配器经验，本文的教训已并入其中；
- `docs/workbuddy-agent-adapter-plan.md`：同类文档，可对照阅读不同传输形态下的差异。
