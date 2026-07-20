<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-codex-context-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context 插件

> 状态：0.3 统一触发与上下文管理版本。源码位于 `plugins/rabi-codex-context/`。

## 唯一边界

Rabi PC / RabiRoute Manager 是以下事实的唯一管理者：

- 人格目录与配置；
- Codex `session_id → RoleId` 绑定；
- 计划、近期记忆、沉淀记忆和角色技能；
- 关键词召回、`viewedAt`、计划归档、记忆编辑窗口与整理流程。

Codex 插件只做两件事：把 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse` 原样提交给 Manager；把 Manager 返回的 `additionalContext` 原样注入 Codex。插件不扫描角色目录、不解析计划记忆、不评分关键词、不保存绑定，也没有离线知识缓存。

```text
Codex Hook 事件
  -> POST /api/codex-hook/context
  -> Rabi PC Manager 会话绑定
  -> RabiContextManager 统一触发策略、召回与副作用
  -> roleKnowledgeSnapshot() 唯一调用入口
  -> 共享 RoleKnowledgeContextView
  -> additionalContext
  -> Codex Hook 注入

RabiRoute 消息投递
  -> message_delivery 标准触发
  -> 同一个 RabiContextManager
  -> AgentPacket
```

## 统一触发策略

| 标准触发 | 来源 | 上下文形式 | 生命周期 |
|---|---|---|---|
| `session_start` | Codex `SessionStart` | 完整入口上下文 | 正常归档；按需重发人格 |
| `user_prompt` | Codex `UserPromptSubmit` | 完整入口上下文 | 正常召回并刷新命中记忆 |
| `reasoning_pre_tool` | Codex `PreToolUse` | 本轮新命中的增量 | 不重复归档；新命中才刷新 `viewedAt` |
| `reasoning_post_tool` | Codex `PostToolUse` | 本轮新命中的增量 | 同上，可发现工具结果产生的新计划或记忆 |
| `message_delivery` | RabiRoute 正常消息投递 | 完整入口上下文 | 服从现有计划、记忆和整理机制 |
| `preview` | Manager / UI 预览调用方 | 完整预览 | 不归档、不刷新 `viewedAt`、不创建整理 run |

推理期 Hook 不会把每个工具输入和输出复制进 prompt。Manager 只用有界文本对同一套 ID、标题和 `keywords` 元信息评分；没有知识命中或明确 Rabi 知识路径时返回空上下文。相同 `turn_id` 下按“条目类型 + ID + 修订时间”去重，避免 Pre/Post 重复注入和重复刷新 `viewedAt`。

## Codex-only 模式

只使用 Codex 的用户仍需安装并运行 Rabi 的 Manager 上下文服务，但不需要启动消息网关、Relay 或发现服务：

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

该模式不启动 Route 配置轮询；人格、计划、记忆和技能仍在每次 Hook 请求时从 Manager 当前 `rolesDir` 读取，显式修改 Manager 配置后也会立即使用新的目录。这样知识服务可以在 NAS 工作区长期运行，而不会为了未启动的 Gateway 反复扫描和迁移 Route 配置。

人格目录通过 Rabi PC / Manager 的 `rolesDir` 配置管理。插件不再提供 `source add`，也不再使用用户目录下的插件私有 `roles/`。

### 从 0.1 插件迁移

0.1 版插件保存在插件用户目录里的角色根注册和 session 绑定不会自动迁移到 Manager。升级到 0.3 后，先启动 Rabi PC Manager，再按准确的完整 `session_id` 重新绑定人格；不要根据任务标题、工作区或最近时间猜测 ID。旧实现只保留在 `archive/plugins/rabi-codex-context-v0.1.0-local-context/` 作为只读迁移参考，不能重新接回活动调用链。

新的绑定写入 Manager 私有运行数据 `data/codex-hook/sessions.json`。该文件、旧插件用户目录和任何真实人格数据都不得提交。

## 会话控制

任务内严格控制标记：

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

标记由 Manager 解释。普通自然语言不会修改绑定。Rabi PC 也可以通过准确的完整 session ID 主动管理绑定：

```text
PUT    /api/codex-hook/sessions/{sessionId}  { "roleId": "YeYu" }
GET    /api/codex-hook/sessions/{sessionId}
DELETE /api/codex-hook/sessions/{sessionId}
```

不要用任务标题、工作目录或最近时间猜测 session ID。

## Manager API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/codex-hook/context` | 接收原始 Hook 事件并生成统一上下文 |
| GET | `/api/codex-hook/roles` | 列出 Manager 当前人格 |
| GET | `/api/codex-hook/sessions` | 列出 Manager 持有的 Codex 绑定 |
| GET/PUT/DELETE | `/api/codex-hook/sessions/{sessionId}` | 查询、主动绑定或解除 |
| GET | `/api/codex-hook/doctor` | 检查 rolesRoot、角色和绑定状态 |

绑定状态保存于 RabiRoute 私有运行目录 `data/codex-hook/sessions.json`，不属于插件数据，也不得提交。

## 召回与整理

Manager 让所有标准触发通过 `RabiContextManager` 调用现有 `roleKnowledgeSnapshot()`：

- 使用同一套 ID、标题、`keywords` 评分；
- 使用同一套进行中计划与活跃近期记忆加成；
- 生成同一套 `[处理前上下文确认]` 和 GET 路径；
- 命中近期/沉淀记忆时刷新 `viewedAt`；
- 继续服从现有计划归档、记忆编辑窗口、校验和 consolidation API。

Hook 不直接注入命中条目的全文。Codex 必须按 Manager 返回的 GET 路径阅读全文，再通过既有计划/记忆 API 更新；不能直接改 JSON 冒充生命周期成功。

## 安装与验收

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

安装或更新后新建 Codex 任务，并在 `/hooks` 审阅信任命令。验收要求：

1. Manager 离线时插件不使用本地知识回退。
2. 未绑定会话收到空上下文。
3. `[rabi:use <RoleId>]` 同一轮由 Manager 完成绑定和注入。
4. 关键词命中走 `roleKnowledgeSnapshot()` 并刷新对应记忆 `viewedAt`。
5. 两个 session 可绑定不同人格，互不串线。
6. Rabi PC 可以按完整 session ID 主动绑定和解除。
7. `SessionStart` 在启动、恢复、清空和压缩时向 Manager 请求重新注入。
8. `PreToolUse` / `PostToolUse` 只在命中相关知识或明确 Rabi 知识路径时注入推理期增量。
9. 同一 turn 的重复命中不会重复注入或重复刷新 `viewedAt`；条目更新后允许重新注入。
10. 正常 RabiRoute 消息投递与 Codex Hook 共用 `RabiContextManager`，代码中没有第二个 snapshot 调用入口。
