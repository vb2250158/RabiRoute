<!-- docs-language-switch -->
<div align="center">
<a href="./persona-data-sync_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 多电脑人格数据同步

> 状态：实验支持。当前代码已经具备同应用设备发现、局域网直连、Relay 受限中转、文件清单、双向合并、冲突留证、人格页操作面板和事件驱动自动对账；仍需真实多电脑、断线和大数据量长期验收。

## 边界

人格目录继续是各 Rabi PC 的本地文件真源。RabiLink 服务端只负责发现和中转，不拥有一份服务器侧“主人格”，也不会用最后上传者覆盖所有电脑。

使用同一个 RabiLink 应用 token 的 PC 被视为同一可信同步组。远程人格同步 API 必须提供该 token；本机 Agent 从回环 Manager 调用时可直接使用接口。

## 传输顺序

1. PC 在 Relay 已启用时启动一个独立的局域网人格同步 listener，并向 RabiLink Relay 登记稳定设备 ID、GUID、能力和该 listener 地址。
2. `GET /api/persona-sync/peers` 查询同一应用下的其它 PC。
3. 同步器优先尝试对方公布的局域网地址。这个 listener 默认使用系统分配端口，只开放 `manifest`、`files`、`merge` 三类数据面接口；不会把完整 Manager/WebGUI 控制面暴露到局域网。
4. 局域网不可达时，改用 Relay 的受限 `/api/rabilink/persona-sync/proxy`，由目标 PC 已存在的全局 worker 转回本机 Manager。
5. 两种传输都只允许访问人格同步的 manifest、file 和 merge 路径，不能借此访问任意本机 URL。

PC 与 Relay 的活跃 `/api/rabilink/events` SSE 连接是在线状态的直接证据，不依赖周期心跳查询；即使 `lastSeenAt` 很旧，只要事件连接仍存在，peer 仍保持在线。同一 PC 因重连短暂并存多条连接时，只有最后一条连接关闭才立即撤销在线状态。没有 SSE 的旧客户端才使用最近真实请求时间作为有界兼容判断。

Relay `ready`、同应用 PC 上线/离线和本机人格文件事件只负责唤醒 `PersonaSyncAutoReconciler`。它随后通过 Coordinator 执行一次 manifest 对账，优先 LAN、失败后 Relay；不会把 SSE 事件本身当成文件事实。本机尚未完成的对账范围持久化在 `data/persona-sync/auto-sync-state.json`，因此断网、Relay 重连或 Manager 重启不会丢失“仍需补账”的事实。目标在线但请求暂时失败时只做最多三次、1–30 秒的一次性退避；目标离线时停止重试并等待下一次 peer/Relay 事件，不运行固定周期业务轮询。

Manager 停止会使当前自动对账生命周期立即失效。已经发出的文件请求可以安全结束，但其旧结果不得在停止后清除持久待办、覆盖 `stopped` 状态或安排新重试；下次启动仍以一次完整 manifest 对账恢复。自动化集成回归还会让目标人格节点离线、本机写入文件，再只通过 peer 重连事件驱动真实 `PersonaSyncService + PersonaSyncCoordinator + LAN listener` 收敛，测试代码不显式调用同步接口。

Relay fallback 是请求中转，不是服务器人格仓库。文件内容只在同步请求期间经过 Relay；当前没有额外端到端加密层，因此应用 token 必须只发给同一可信设备组。

## 合并规则

| 文件 | 行为 |
| --- | --- |
| `*.jsonl` | 按稳定记录身份或内容哈希做集合合并，再按记录时间排序；同一稳定 ID 出现不同正文时转为冲突。 |
| 普通文件 | 双方相同则不处理；只有一方相对共同版本变化时快进；双方都变化时保留本地并生成冲突文件。共同基线按应用 token 哈希作用域和对方稳定设备 GUID 分域，不会跨 RabiLink 应用复用。 |
| 仅一侧存在 | 首次同步没有共同基线时视为新增并创建到另一侧；已经共同存在过且内容仍等于基线时，缺失侧视为删除并双向传播。 |
| 删除与编辑并发 | 不静默删除或复活文件；保留当前本地内容并生成带 `remoteDeleted`、peer 与共同基线哈希的冲突证据。 |
| 锁、临时文件、符号链接 | 不同步。 |
| `voice/cache/tts-audio/` | 可再生语音缓存，不同步。 |
| 超过 16 MiB 的单文件 | 当前拒绝同步。 |

人格自己的声纹关系真源 `voice/voice-identities.jsonl` 也使用追加事件和 tombstone，因此可按 JSONL 并集合并。每个身份由 `sourceHostId + voiceprintId` 定位；RabiSpeech/Manager 的主机诊断人名不会进入这个文件。新关系事件自动记录所收敛的父事件头；两台 PC 并发修改同一身份时会保留多个头并通过 `conflicted/conflictFields/conflictCandidates` 暴露，不做最后写入者覆盖。人格再次提交最终解释会 supersede 全部当前头，使后续同步收敛。

自动覆盖或删除前会把旧文件归档到运行期 `data/persona-sync/archive/`。不能安全合并的远端内容或删除意图写入 `data/persona-sync/conflicts/`，不会污染正式人格文件；本机 Agent 或用户确认后可选择保留本地、采用远端（删除冲突时表示确认删除），或提交明确的合并内容。处理时会校验本地文件哈希，避免基于过期版本覆盖；原冲突证据与元数据移入 `data/persona-sync/resolved-conflicts/`，并留下 `.resolution.json` 解决记录。

同一进程对同一个 peer/人格的并发 `sync` 会复用一条 single-flight；跨进程文件合并和 peer 基线状态使用锁与原子写。合并 `conversation/` 时会复用消息上下文自己的 `.message-context.lock`，合并 `voice-transcripts.jsonl`、`voice/voice-identities.jsonl` 等文件时复用对应文件锁，因此同步替换不会和正在发生的 Agent 会话或声纹关系追加交错。读取和合并都会检查人格目录的完整父路径链，遇到符号链接或 Windows junction 直接拒绝，避免同步 API 穿出人格目录。

## 事件维护的 Manifest 索引

人格目录仍是唯一真源；`data/persona-sync/manifest-index.json` 只是可删除、可重建的派生索引。Manager 启动后异步执行一次全目录元数据校准：文件的大小、mtime、ctime 和文件标识与旧索引一致时直接复用 SHA-256，只有新增或变化的文件读取正文重新哈希。校准完成后使用递归文件系统事件维护索引；一个明确文件事件只重新哈希该路径，目录或缺少文件名的模糊事件才进行对应人格或全目录的一次性校准。

`GET /api/persona-sync/manifest` 等待启动校准完成后，先经过一次 50 ms 文件事件交付屏障，把“刚写完就立刻同步”的操作系统事件排入待处理队列，再直接读取内存索引；这个一次性 settle 不读取业务状态，也不重新遍历并哈希整个人格目录。索引变更通过 Manager `/api/events` 发布 `persona_sync_manifest_changed`，同时只把对应人格标记为待对账；短时间内的多个文件事件会合并成一次同步。若当前文件系统、网络盘或宿主无法提供可靠递归事件，功能优先保留：每次 manifest/sync 查询前做一次校准，但不启动固定周期轮询。`GET /api/persona-sync/index-status` 只允许回环访问，用于查看 `ready/fallback`、事件模式、文件数和重算计数；`GET /api/persona-sync/auto-status` 只返回自动对账状态、待处理数量和脱敏结果计数。专用 LAN listener 与 Relay proxy 都不暴露这两个诊断接口。

## Manager API

```text
GET  /api/persona-sync/peers
GET  /api/persona-sync/manifest?roleId=Rabi
GET  /api/persona-sync/index-status
GET  /api/persona-sync/auto-status
GET  /api/persona-sync/files/<roleId>/<relativePath>
POST /api/persona-sync/merge
POST /api/persona-sync/sync
GET  /api/persona-sync/conflicts?roleId=Rabi
GET  /api/persona-sync/conflicts/content?conflictId=<id>
POST /api/persona-sync/conflicts/resolve
```

主动同步指定 PC：

```json
{
  "peerId": "office-pc",
  "roleId": "Rabi"
}
```

省略 `roleId` 时同步全部人格。返回结果会逐文件标明 `pull`、`push`、`converged` 和 `conflict`；`fileConflicts` 统计文件级冲突，`semanticConflicts` 同步返回已合并 JSONL 中仍存在的人格声纹关系分支，`conflicts` 是两者总数。语义冲突项包含人格、处理主机、声纹 ID、冲突字段和候选事件 ID，因此发起同步的 Agent 可在同一次响应里处理，不需要事后轮询。`conflicts > 0` 时 HTTP 返回 `409`，Agent 不应宣称同步完成。

冲突查询与解决接口只允许回环地址调用，不会暴露给专用 LAN listener，也不在 Relay proxy allowlist 中。读取列表后，先保存返回的 `localHash`，查看对应远端证据，再提交其中一种动作：

```json
{
  "conflictId": "Rabi/persona.md/2026-07-23T01-02-03-000Z-office-pc-abc123",
  "action": "use_remote",
  "expectedLocalHash": "<sha256>"
}
```

`action` 可为 `keep_local`、`use_remote` 或 `use_merged`。`use_merged` 还必须提供 `contentBase64`；目标为 JSONL 时，Manager 会在提交前验证每行 JSON 和稳定记录 ID 是否仍然一致。若当前本地哈希已经变化，接口拒绝解决请求，Agent 必须重新读取冲突，而不能覆盖新写入内容。

本机解决成功后，Manager 会立即使用冲突证据里的 peer 和远端哈希，把明确选择的本地/远端/合并/删除结果发布回来源 PC；LAN 仍优先，失败才走 Relay。响应中的 `publish.status` 为 `published` 或 `not_published`。只有远端仍等于冲突证据且本地仍等于刚解决的结果时才允许发布；peer 离线或任一侧已变化时，本机解决记录仍保留，但不会冒充已收敛。文件变化会保留新的待对账标记，下一次连接/peer 事件或人工同步再比较当前版本并在需要时生成新证据；不会用固定轮询反复覆盖冲突。

## WebGUI 与自动恢复

人格页的“多电脑人格同步”面板可以：

- 查看同应用 PC、在线状态、LAN/Relay 能力和本机 manifest 索引模式。
- 读取自动对账当前是等待 Relay、等待 peer、已排队、同步中、已收敛、需要确认还是暂时失败。
- 手动立即同步当前人格，并查看拉取、推送、一致、传输类型与冲突数量。
- 预览本机/远端文件证据，选择保留本机、采用远端或确认远端删除；高级 `use_merged` 正文仍由本机 Agent/API 提交。
- 将人格声纹关系的语义分支引导回“人格声纹归类”，由人格明确收敛，不在同步面板自动判断谁是用户。

页面打开、SSE 重连和同步状态事件只各补查一次展示状态。真正的自动对账由后端持久补偿器拥有，即使 WebGUI 没有打开也会运行；Vue 不保存 peer、manifest、冲突或待同步事实。

## 已构建 Manager 只读烟测

在做两台实体 PC 同步前，先验证当前 TypeScript 构建产物真的公开了人格同步、声纹关系和通用语音读取边界：

```powershell
npm run build:backend
npm run check:built-manager
```

烟测使用临时回环端口和 `RABIROUTE_MANAGER_READ_ONLY=1`，不会重启现有 8790，也不会启动 Gateway、Relay、局域网发现、Route watcher、人格文件 watcher 或麦克风协调。Manager 就绪由子进程 stdout 事件触发，不进行状态轮询。它还读取回环 `index-status`，证明构建产物已完成 manifest 索引校准；只读模式不写索引缓存。默认把脱敏证据原子写入 Git 忽略的 `data/acceptance/built-manager-readonly-<timestamp>.json`；只记录构建哈希、HTTP 状态、索引模式和数量，不记录人格名/ID、文件路径/正文、转写、人物、token、Relay URL 或端口。

## 本机双节点构建产物验收

实体机验收前可先运行：

```powershell
npm run build:backend
npm run check:persona-sync:dual-node
```

`src/acceptance/personaSyncDualNode.ts` 会创建两个隔离人格根，启动真实 RabiLink Relay 子进程、目标 PC worker/Manager 数据面和专用 LAN listener，并由当前构建的 `PersonaSyncCoordinator` 执行完整链路。第一阶段要求 LAN-first，验证 JSONL 并集、单边文件复制、人格声纹关系并发分支、人格显式解释后的语义收敛、基于共同版本的双向删除、普通文件冲突留证和解决结果经 LAN 发布。第二阶段只把目标 peer 广播地址改成不可达地址，目标 worker 仍保持在线，从而强制同一 Coordinator 通过真实 Relay `/api/rabilink/persona-sync/proxy` 拉取文件、生成冲突并把解决结果发布回目标节点。

Relay 与 worker 就绪都由 stdout/SSE 状态事件触发；同步本身是一次性请求，工具不运行状态轮询、后台同步或自动冲突决策。全部 token、端口、人格 ID、文件正文和临时路径只存在于隔离目录，完成后删除；脱敏报告默认写入 `data/persona-sync/acceptance/dual-node-<timestamp>.json`。这项验收证明当前构建与真实 Relay 协议能在单机双节点环境收敛，但不能替代两块网卡、真实防火墙、真实断网和两台实体 PC 的最终验收。

## 两台实体 PC 验收工具

先在两台 PC 上确认运行中的 Manager 已包含当前 persona-sync API，并使用同一 RabiLink 应用 token。只读发现与准备检查：

```powershell
node scripts/test-rabi-persona-sync.mjs --inspect
```

当同应用下恰好只有一台可用 peer 时可省略 `--peer`；否则显式指定 peer ID 或 GUID。执行一次指定人格同步、要求真实 LAN 数据面，并明确确认本次链路确实跨越两台不同实体 PC：

```powershell
node scripts/test-rabi-persona-sync.mjs --peer <PEER_ID> --role Rabi --require-lan --confirm-distinct-physical-hosts
```

省略 `--require-lan` 时 LAN 不可达可以由 Relay fallback 完成。工具只发起这一次显式同步，不启动后台计划、不轮询，也不自动解决冲突。证据默认原子写入 Git 忽略的 `data/persona-sync/acceptance/`，只记录 peer 数量/是否选中、人格与文件数量、同步范围、传输类型、文件方向/终态计数和冲突类型计数；不记录主机名、Manager URL、peer ID/GUID/name、人格 ID、token、Relay/LAN 地址、文件路径、正文或冲突内容。

退出码：`0` 只表示本次功能同步无冲突，或 `--inspect` 已找到唯一/点名的可用 peer；`1` 表示 Manager/API 请求失败；`2` 表示 peer 不可用或需要显式选择；`3` 表示仍有文件/声纹语义冲突；`4` 表示要求 LAN 但实际使用了 Relay。报告把 `syncPassed` 与 `formalAcceptanceEligible` 分开：只有同步终态通过且命令显式包含 `--confirm-distinct-physical-hosts`，才可作为实体双 PC 汇总的候选证据；它仍不能替代断线、冲突、Relay fallback 和长期运行的逐项人工观察。

## 当前限制

- 自动对账和 WebGUI 面板已实现，但仍属于实验能力；两台实体 PC 的真实断网、LAN 防火墙、Relay fallback 与长期高频会话同步仍需验收。
- 专用 LAN listener 默认使用临时端口；需要固定防火墙规则时可设置 `RABILINK_PERSONA_SYNC_LAN_PORT`。没有可发布的私有 IPv4、端口绑定失败或局域网不可达时，仍会自动使用 Relay fallback。
- 只有已经建立共同基线的文件才会传播单边删除；首次同步时一侧缺失仍按新增处理。删除与编辑并发必须显式解决，不做最后写入者覆盖。
- 普通文件首次遇到两个不同版本时没有共同基线，会保守地产生冲突。
- 对话 JSONL 可以合并，但每台电脑的运行期锁、可重建 manifest 索引和 TTS 缓存不参与同步。
- 当前属于实验能力，不应替代独立备份、Git 或 SVN 的项目源码版本管理。
