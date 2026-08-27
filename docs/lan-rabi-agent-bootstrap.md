<!-- docs-language-switch -->
<div align="center">
简体中文 | <a href="./lan-rabi-agent-bootstrap_en.md">English</a>
</div>
<!-- /docs-language-switch -->

# 局域网 Rabi Agent 接入与更新

> 状态：**实验集成**。Manager、Rabi Web、资源签名、节点连接和更新请求已实现；当前只支持投递到已配置的 Codex Desktop 任务 owner，尚未完成真实多电脑验收。
>
> 读者：维护者、局域网部署人员和接入 Rabi Agent 的现有 Agent。

## 它解决什么问题

RabiRoute 仍在 Manager 电脑运行。其他电脑不安装完整 RabiRoute、不运行 Gateway，也不需要配对码或设备密码。执行电脑只保留无界面的 Rabi Agent：它主动连回 Manager，接收任务、把任务投给那台电脑上已经打开的 Codex Desktop 任务，并回传领取、完成或失败状态。

Rabi Web 的“局域网 Agent”页面显示节点、最近任务和发布版本；在线节点可由该页面请求更新。Manager 不会直接改远端文件，Rabi Agent 自己下载、校验、切换；新版本在 30 秒内没有连回 Manager 时，旧版本继续运行。

## 已实现范围

| 项目 | 当前行为 |
| --- | --- |
| 身份验证 | 复用 `webguiLan.accessToken`。节点清单、任务下发和更新请求即使来自 loopback 也必须显式携带 Token；不使用配对码、UDP 扫描、设备密码或第二套 Token。 |
| 资源发布 | `GET /api/lan-agent/releases/manifest` 返回 Node 资源清单、Ed25519 公钥、签名和公钥 SHA-256 指纹；每个文件单独提供 SHA-256。 |
| 发布信任 | 首次接入从 Rabi Web 复制发布公钥指纹并保存到私有配置。每次更新先比较该固定指纹，再验证清单签名；清单同时替换公钥和签名也会被拒绝。 |
| 资源下载 | Agent 通过 `Authorization: Bearer <LAN connection Token>` 下载清单和文件。 |
| 长连接 | Agent 连接 `/api/lan-agent/connect` 后先发送 `authenticate`，收到 `authenticated` 才发送 `hello`。浏览器 WebSocket 无法稳定附带自定义 Authorization Header，因此连接认证放在第一条消息；HTTP 下载仍使用 Bearer Header。 |
| 节点与任务 | Manager 持久保存最近 500 个节点状态和任务；重连不会重复执行同一个 `taskId`。 |
| 本机处理端 | 仅 `codex-desktop`。任务只通过 Codex Desktop IPC 投给已配置的任务 owner；Desktop 未就绪或 owner 未加载时失败关闭，不启动 `codex app-server` 或其他备用 Runtime。 |
| 启动恢复 | `--bootstrap` 为当前用户创建启动项，用户登录后恢复这个无界面进程；启动项不保存 Token。 |

Rabi Agent 需要 Node.js 22 或更高版本。它不请求管理员权限，不写系统级环境变量。

## Rabi Web 操作

1. 在 Manager 中启用局域网 Web 访问并生成局域网连接 Token。
2. 用包含 Token 的完整 Rabi Web 访问链接打开控制台。
3. 打开 **局域网 Agent**，复制页面显示的“发布公钥 SHA-256”。节点首次连上后会显示版本、平台、Codex Desktop 能力和最后在线时间。
4. 首次接入时把该指纹作为 `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256` 交给新电脑。
5. 点击在线节点的 **更新到当前版本**。节点收到 `updateAvailable` 后自行下载并校验资源；页面显示 `requested`、`updated` 或 `failed`。

节点离线时不能请求更新。重新上线后再次请求即可。

## 首次接入

新电脑必须已有：Node.js 22+、Codex/ChatGPT Desktop，以及一个已经打开的目标任务 owner。现有 Agent 接到下面的提示词后，负责下载、校验、安装并启动 Rabi Agent；普通用户不需要手工安装 RabiRoute 或输入配对码。

Rabi Agent 的当前用户私有目录：

| 平台 | 目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%\RabiAgent\` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

首次接入后的配置只保存 Manager 地址、局域网连接 Token、稳定 `nodeId`、发布公钥 SHA-256 指纹、允许工作目录和 Codex Desktop 任务 ID。配置文件权限只给当前用户；不要把 Token 写进仓库、日志、命令历史、任务正文或截图。

## 接入提示词

把尖括号中的值替换为本次连接信息后发送给新电脑上已有的 Agent。Token 只放在该次私密提示中，不要转发到群聊或提交到仓库。

```text
Connect this computer to the LAN Rabi Manager by installing and starting the current headless Rabi Agent. Do not install full RabiRoute, do not use a pairing code, and do not start a fallback Codex runtime.

Rabi Manager URL: <RABI_MANAGER_URL>
LAN connection Token: <RABI_LAN_LINK_TOKEN>
Stable node ID: <RABI_NODE_ID>
Allowed workspace: <RABI_AGENT_DEFAULT_CWD>
Existing Codex Desktop task owner ID: <RABI_AGENT_CODEX_THREAD_ID>
Release public key SHA-256: <RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256>

1. Require Node.js 22 or newer and an already-open Codex/ChatGPT Desktop task owner with the ID above. Stop with the failed prerequisite if either is unavailable.
2. Request GET <RABI_MANAGER_URL>/api/lan-agent/releases/manifest with Authorization: Bearer <RABI_LAN_LINK_TOKEN>.
3. Derive SHA-256 from the manifest Ed25519 public key in canonical SPKI DER form and require it to equal <RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256> and manifest.publicKeySha256. Then verify the signature over exactly { version, platform, minNodeVersion, files }; verify every downloaded file's SHA-256 and byte size. Reject paths containing ., .., empty segments, or absolute paths.
4. Download every file in the manifest into the current user's RabiAgent releases/<version> directory. Do not put the Token in the package, logs, repository, screenshots, command history, or task text.
5. Set only this process environment for bootstrap: RABI_MANAGER_URL, RABI_LAN_LINK_TOKEN, RABI_NODE_ID, RABI_AGENT_DEFAULT_CWD, RABI_AGENT_ALLOWED_CWDS, RABI_AGENT_CODEX_THREAD_ID, and RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256.
6. From the verified release directory, run: node rabi-agent.mjs --bootstrap. This writes current-user-only configuration, registers the current-user startup entry, and starts the Rabi Agent.
7. Wait for Manager to return connected. Report only: Rabi Agent connected: <RABI_NODE_ID>, version: <version>.
8. On failure, report only the failed step and error. Do not retry indefinitely, skip verification, create another token, use UDP discovery, use a device password, or launch codex app-server.
```

签名密钥保存在 Manager 的私有运行数据中。密钥丢失或替换会改变公钥指纹，既有节点会拒绝后续更新；轮换必须通过可信渠道重新分发指纹，并更新每个节点私有配置中的 `releasePublicKeySha256`。真实双机验收前还需要完成显式密钥 provision、权限核验与受控轮换流程。

## 连接、任务和更新合同

```text
GET  /api/lan-agent/releases/manifest
GET  /api/lan-agent/releases/<version>/node/<assetPath>
GET  /api/lan-agent/nodes
POST /api/lan-agent/nodes/<nodeId>/update
POST /api/lan-agent/nodes/<nodeId>/tasks
WS   /api/lan-agent/connect
```

WebSocket 消息顺序：

```text
authenticate -> authenticated -> hello -> connected -> heartbeat
assignTask  -> ackTask -> progress -> taskResult
updateAvailable -> updateResult
```

任务具有 `taskId` 与 `idempotencyKey`。Manager 按节点保存去重记录；Agent 只接受 `codex-desktop`，并验证任务工作目录位于接入时声明的允许目录中。任务被 Codex Desktop 接收后，Rabi Agent 等待 Desktop 的任务状态广播；完成结果表示 owner 已完成，具体回复仍在该 Desktop 任务中查看。

## 仍需验收

- 两台真实电脑上的首次接入、Token 撤销、网络中断和登录启动恢复。
- Codex Desktop owner 完成状态广播与实际任务回复的对应关系。
- Windows、macOS、Linux 启动项的真实运行验证。
- Remote Agent v3 仍保留为独立实验链路；未迁移或未验收前不删除它。
