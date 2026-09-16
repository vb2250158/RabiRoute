<!-- docs-language-switch -->
<div align="center">简体中文 | <a href="./lan-rabi-agent-bootstrap_en.md">English</a></div>
<!-- /docs-language-switch -->

# 远端 Agent 接入与更新

> 状态：experimental（实验集成）。独立节点凭据、Manager 授权、受限 API、资源读取及上传后群文件发送已完成本机测试、完整构建和部署；`0.3.4-4b5d30118b40` 的 Host/Manager 健康与运行产物已核对。上传闭环通过真实 HTTP 与模拟 NapCat 验证，不代表真实双机、真实群文件或旧节点迁移已验收。后续发现指引与更新机制的审计修复须另行核对最终部署版本。

## 用户只需三步

1. 打开 **远端 Agent** 页面（`#/lan-agents`），点击 **复制接入提示词**。一次点击即签发并复制包含完整接入指令与一次性票据的提示词（签发后 30 分钟有效，只能成功兑换一次，成功后立即失效），无需手填 WebGUI 密钥；提示词使用当前 Manager 的局域网地址和发布公钥指纹；本机回环地址会替换为当前局域网地址。Manager 须先启用局域网访问。票据过期或 Manager 重启后重新复制，不复用旧提示词。
2. 启动目标电脑上的 Codex 或 DSH，把提示词粘贴到想接收消息的任务里。该 Agent 检查 Node.js 22.13+、发现当前任务与工作目录，下载并验证接入程序，保存私有配置，注册登录启动项并启动后台连接。不需要安装完整 RabiRoute，也不需要手填任务 ID。
3. 回到当前路由的 **消息适配器 → 添加 AGENT**，选择 **远端Agent(<IP地址>)** 并保存。没有节点时，菜单引导进入接入页面；已接入节点使用 Manager 观察到的连接 IP 展示，保存的稳定身份是 instanceId + agentId。

本机与远端电脑统一为实例，页面采用 **实例 → Agent** 两层折叠。本机默认出现，无需接入安装。远端实例显示 **远端Agent(<IP地址>)**，内部可管理多个 Agent；Codex/DSH 是执行能力，不再是两种远端实例。IP 改变不会修改路由身份。

实例内共用配置界面包含名称、开关、工作目录、任务名称与 ID、模型、推理强度、环境扫描、打开任务和 Hook 安装。扫描由用户显式刷新触发。人格自动化中的 Hook 策略仍由当前 Manager 管理。

提示词含短期接入票据，不再携带共享 WebGUI 管理 Token。只能粘贴到目标电脑的私密任务中，不要写入仓库、群聊、日志、截图或命令历史。复制使用安全剪贴板或页面回退，支持局域网 HTTP；HTTP 不提供传输加密，只在可信网络中使用。

接入成功后，用节点凭据访问 `GET /api/lan-agent/self`，确认自身 `nodeId` 与 `connected`。节点在线不等于获准使用 API。在总控 WebGUI 为准确的实例与 Agent 勾选 **允许使用 Manager API 与 skills**；此授权默认 `false`，由 Manager 保存，勾选后立即 PUT 生效，不依赖执行配置的保存或远端在线。关闭后，后续受限 API 与资源请求被拒绝；离线节点也可关闭授权。Agent 的执行开关、工作目录、任务与模型是另一组配置，不会因此自动改变。

### 旧节点必须重新接入

缺少 `nodeCredential` 的旧配置不能把 `lanLinkToken` 当作新节点凭据。使用新票据重新接入，保留原 `nodeId`、Agent、任务绑定与允许的工作目录；已有独立凭据的重连不重复兑换票据。新源码已加入监听 HTTP/WS 前的安全迁移：发现旧 `lan-agent-tasks.json` 且没有完成标记时，即使旧注册表为空也轮换 WebGUI Token，成功后才写完成标记；迁移失败则中止启动。旧浏览器远程链接会失效，须在本机获取新链接，并更新受信管理客户端。对于检测范围外曾暴露的共享密钥，仍须确认撤销或轮换。**未轮换的旧共享密钥仍可能以管理权限绕过节点授权，关闭 Agent 授权不能撤销它。** 整体部署与 Host 健康不等于旧节点迁移验收；仍须逐节点核对重新接入和旧密钥失效，不能说所有现有安装已自动安全迁移。兑换超时或回执不确定时先核对 Manager 节点状态与本机私有配置，不自动重放兑换。

## 数据与执行边界

| 对象 | 唯一拥有者 | 行为与验收 |
| --- | --- | --- |
| 节点、IP、连接和任务状态 | Manager 的节点注册表 | HTTP 管理操作与 WebSocket 连接都显式鉴权；离线投递失败。 |
| 路由绑定 | 路由配置的 `agentInstanceBindings[provider]` | 界面保存 `instanceId + agentId` 引用，不保存第二套连接凭据；Gateway 从本代 Manager 获得地址与凭据。 |
| 任务、模型、工具和权限 | 远端现有 Codex/DSH 宿主 | 实例保存各 Agent 的任务绑定，不新建备用 Runtime，不改变宿主启动配置；Manager 缺席时宿主仍独立运行。 |
| 后台连接进程 | 当前用户的 Rabi Agent | 主动连接 Manager；管理下载、校验、登录启动和更新。 |
| 真实消息路径 | 路由 → Agent adapter → Manager 节点注册表 → 远端进程 → 已绑定任务 | Codex 走 Desktop IPC；DSH 走本机 `session.prompt`，`mode=queue`。两者分别只有一条执行路径。 |

Codex owner 不可用时失败，不使用 `codex app-server`。DSH API 或绑定不可用时失败，不回退到 Codex。Codex 当前任务忙时明确拒绝新投递，避免覆盖任务关联；已接受的重复任务不重复执行。

节点在线只表示远端进程已连接。任务记录分别显示传送、领取、处理中、完成或失败。DSH 当前只回传队列接受状态，实际回复在其绑定会话查看；Codex 完成状态来自 Desktop 广播，回复在对应任务查看。本机图片路径不会直接发送到另一台电脑。完整计划助手、消息处理池与远端人格文件同步的能力对齐仍需继续验证；不能据此宣称所有本地高级功能已完整迁移。

## 安装与发布

| 平台 | 私有目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/RabiAgent/` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

提示词由 WebGUI 的统一模板生成，不再手工拼接文档里的第二份模板。它携带完整 Manager URL、一次性票据和固定发布公钥 SHA-256。票据可下载发布文件，成功兑换后即失效；兑换得到的独立 `nodeCredential` 只写入节点私有配置，Manager 只保存密钥 hash 与授权。登录启动项不含凭据。资源清单使用 Ed25519 签名；逐个文件验证 SHA-256 和大小，拒绝越界路径和跨源下载。签名密钥位于 Manager 私有数据中，升级须保留；轮换须重新分发可信指纹。

接入进程变量：`RABI_MANAGER_URL`、`RABI_AGENT_BOOTSTRAP_TICKET`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS`、`RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。Codex 使用 `RABI_AGENT_TYPE=codex-desktop` 和 `RABI_AGENT_CODEX_THREAD_ID`；DSH 使用 `RABI_AGENT_TYPE=dsh`、`RABI_AGENT_DSH_URL`、`RABI_AGENT_DSH_SESSION_ID`。这些值由远端 Agent 发现并写入私有配置，不要求用户输入。

`node rabi-agent.mjs --bootstrap` 是常驻进程，应隐藏并脱离安装终端运行。首次接入后刷新节点页面。在线节点可请求更新；程序自行下载、校验并切换，30 秒内未连回则保留原版本。Manager 地址变更后应重新复制当前提示词更新连接，不猜端口。

更新以已签名清单 `manifestPayload` 的 JSON SHA-256 内容摘要识别发布，不只比较 package semver；因此同版本号的不同内容也能更新。下载放入摘要命名的不可变目录，复用已有目录前重新核对发布身份及逐文件 hash。候选进程 READY 前不改共享启动器或 Hook；READY 后先安装读取指针的稳定启动器与 Hook shim，再原子切换 `current-release` 指针，失败保留原版本。shim 每次调用读取当前指针，再动态加载对应发布的 Hook helper。

仍按 semver 判断的旧连接器不能仅靠新清单自行安装此修复。首次迁移须复制新接入提示词、执行一次新 bootstrap，保留现有 `nodeCredential`，不要删除节点；此后才按内容摘要更新。旧 DSH 进程可能已缓存旧 helper，首次迁移须重新加载插件或宿主；覆盖磁盘文件不等于该进程已热更新。此更新合同不代表所有现有远端已完成迁移，应逐节点核对实际发布摘要和 Hook 行为。

## 实例身份与管理

本机 instanceId 持久保存在 Manager 私有目录的 `agent-instance-id.json`；远端 instanceId 沿用连接程序私有 `nodeId`。远端原有单任务配置读取时映射为 `agentId=default`，新增 Agent 使用 UUID。Agent 配置由执行电脑持有，Manager 保存目录投影；本机 Agent 继续以原有路由配置为事实源，保存经过原有并发版本检查。

本机与远端共用 `instanceManagement.ts` 的扫描、任务与 Hook 安装逻辑。远端通过有请求 ID 和连接所有权校验的 WebSocket RPC 调用；断线立即失败，超时后必须先刷新再决定是否重试。Hook 通过已注册 Agent 的会话 ID 校验，使用隔离的实例身份关联当前 Manager 人格。

实例中的“路由与完整 Agent 设置”进入同一消息适配器页面，包含消息处理、独立记忆整理与计划协助设置。消息处理池和记忆整理按 `instanceId + agentId + 主任务 ID` 隔离持久状态；切换电脑或重绑主任务后不会复用旧电脑的工作任务。创建或解析出的协助任务登记到所属 Agent，Manager 后续按归属分派；离线和身份歧义会失败，不降级到本机。

安装版从当前不可变版本包读取接入程序、共用管理运行库和 Hook 包，签名密钥仍保存在私有数据目录。再次粘贴接入提示词更新连接时保留原实例 ID、Agent 目录和已允许的工作目录。已绑定的本机任务关闭后仍保留在实例中，可以重新开启；远端绑定占用同一路由处理端时，应先在路由设置中切回本机。

## 从远端任务调用 API 与 skills

远端优先使用接入时安装、由 Hook 提供的连接器命令及 `--api` 入口；以下命令展示参数，不要求另找源码目录。文档中的本机 `RabiRouteHost.exe` 发现规则只适用于 Manager 所在电脑；远端缺少 Host 不代表 Manager 离线。远端由连接器使用已配置地址并核对 `/meta`，不启动第二个 Runtime，也不把凭据放进命令参数：

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

`agentId` 必须来自私有配置中的准确 Agent，不猜身份。通用语法为 `--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`。写请求通过标准输入提供 JSON；先读现行合同与对象版本，再按合同传强 ETag 和稳定幂等键。CLI 读取私有 `nodeCredential`，发送 Bearer 与 `x-rabiroute-agent-id`，前后核对 `/meta` 的健康、generation 和实例身份。超时、503、`uncertain` 或写后切代时保留原键与正文，先权威读回，不自动重试；412 刷新版本后重新确认原意。地址变化须重新发现并核对，不扫描或猜测端口。

- `capabilities` 返回当前受控操作目录，包含受控业务入口及别名，不是全部 Manager API，也不是全部远端可执行功能。以运行实例返回的目录与各项 `limitations` 为准；处理器的对象权限、Action Gate、来源身份、文件根、幂等与版本检查仍有效。
- `resources` 只列公开技能和显式发布的文档；`resources/read?id=...` 只接受目录内文档、`SKILL.md` 及同一技能直接引用的受控文本。不支持任意 `file`、路径穿越、链接逃逸、私有数据或宿主文件读取。读取脚本不等于授权执行。
- 资源目录只广告已发布且可实际读取的文件及 references，不把 Markdown 中任意链接自动授予读取权。公共文档为接口、计划与记忆、上下文注入、远端接入四份合同及对应英文版，共八份；仍以实际 `resources` 返回的 ID 为准。发现入口是 `/api/lan-agent/capabilities` 和 `/api/lan-agent/resources`，不是 `/api/agent/capabilities` 或 `/api/agent/resources`。
- 按需取 Manager 当前发布的最新技能和合同，随后读取目录中可用的 references；不要把整套技能长期复制为另一份权威来源。计划、记忆与消息处理状态仍由 Manager 持有，不复制到远端维护第二套业务状态。
- 管理员设置、授权修改、任意文件和宿主控制不向节点 API 开放。已有 loopback-only 处理器仍拒绝远端调用，不通过本机代理绕过限制。
- 向消息渠道正式发送沿用 Manager 的消息合同，必须取得 Manager 与渠道回执；任务最终文本不代表已发送。远端调用仍遵守 Route 发送权限：`onlyPrimary` 要求可信 `provider`、Route 的 `instanceId`/`nodeId` 与 `agentId`、已批准的会话及 `primary_persona` 身份全部匹配；仅裸会话 ID 同名不会继承本机权限。
- 跨 Agent 投递时，远端主会话来源按实例命名空间记录。目前只支持 `responsePolicy: "none"` 的单向投递；因缺少可信回传路由，`responsePolicy: "required"`、`inReplyToRequestId` 正式回复及远端到远端投递均明确拒绝，不能视为完整支持正式回复。远端上下文只走自身专用 `context` 入口，不开放通用 `codex-hook` 接口。

Windows 发布流程将公共 `skills/` 按受控的 Git tracked 文件复制进版本包，不复制工作区中的私有或未跟踪内容。该打包链尚未运行 ZIP 验收；不能据此宣称安装包已经包含可用的完整技能目录。

## 上传文件并发送到 QQ 群

> 上传链路已完成本机集成测试、完整构建及 `0.3.4-4b5d30118b40` 部署验证。测试使用真实 HTTP 与模拟 NapCat，未向真实群发送文件；真实双机群文件链路仍待验收。

独立节点凭据及总控批准的 primary Agent 是前提。上传仅把文件交给 Manager，不自动发送到群。最短操作与完整发送 JSON 见 [接口说明中的上传示例](./rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)：

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` 为必填、预先保存的稳定 UUID，不自动生成。上传 HTTP 使用 `PUT /api/agent/uploads/<UUID>`、`application/octet-stream`、同 UUID 的 `Idempotency-Key`、URI 编码 basename 的 `x-rabiroute-file-name` 和内容摘要 `x-rabiroute-content-sha256`。同路径 GET 返回 `{code:0,data:{id,fileName,size,sha256,expiresAt}}`，到期时间为 ISO，不返回本地 path。默认单文件 2 GiB（2048 MiB，硬上限）、总量 4 GiB、最多 100 个、TTL 24 小时；HTTP 上传总并发上限为 4，跨 owner 合计。超时、503、切代或不确定回执后先重新发现并核对 Manager，再 GET 原 UUID；不自动重试或换 ID。

大包上传使用流式二进制传输、流式落盘及增量 SHA-256 校验，期限 30 分钟，不把整包装进 JSON 或内存。可在「设置 → Rabi 身份」保存 `agentUploads.maxFileMiB`（整数 `1..2048`，默认 `2048`），持久化到 `data/Config.json`，重启 Manager 后生效；本机管理员也可使用原权限保护的 `PATCH /api/rabi/identity`，远端 Agent 无权增大配置。

已用 734 MiB（769654784 字节）的受控文件完成真实客户端到 loopback Manager、受管磁盘及模拟 NapCat 的 size/SHA-256 集成验收；生成和接收均按 64 KiB 小块，大于 8 MiB 的 Buffer 分配/拼接被测试防线拒绝。大测试由 `RABI_TEST_LARGE_UPLOAD=1` 显式启用，临时文件自动清理。**尚未验证真实 QQ 平台接收这一大小的文件**，仍须核对 NapCat/QQ 限制及群权限。旧连接器需要新版 bootstrap（保留已有节点凭据），旧 Hook 缓存需要重载宿主；仅更新 Manager 不会让旧客户端支持大包。

发送仍用原 `/api/agent/send`，保留稳定 `deliveryId`、`sender`、准确 `routeId`、`channel=napcat`，以及 `params.target=group/groupId/instanceId/replyToMessageId`；引用 ID 必须是具体消息 ID 或空字符串。标准输入 JSON 的文件部分为 `payload:{type:'file',fileId:<upload-data.id>,fileSha256:<upload-data.sha256>,text?}`。`fileId` 与 `path`、`url`、`fileName` 互斥，显示名从上传元数据取得，只用于群文件，不用于图片、语音或其它 channel。原引用核对和 tracking 合同仍生效。

`fileSha256` 为使用 `fileId` 时的必填项，必须取上传 `data.sha256`（64 位小写十六进制），防止 24 小时过期后 UUID 复用使旧引用换成其它内容。发送 callback 在 lease 内核对实际 hash，不匹配拒发。

归属按 `nodeId + agentId`，同 Agent 多 session 共享但每次仍要求可信批准 source。Manager 内部可信 resolver 按请求核对授权、归属、完整性与 TTL；活跃 inflight lease 期间不清理文件。不扩大 `allowedFileRoots`，原本地 path 发送照旧。渠道必须允许发送和 `file`，`onlyPrimary` 继续核对精确 Route 的远端绑定和获批会话。

只有 Manager 与渠道回执才能证明群发送。群文件已被 NapCat 接受但 caption 失败时保留 `sent`，只补文本，不重发文件。当前 NapCat 读取 Manager 路径，异机 NapCat 需要共享可读目录；这不解决任意跨机 NapCat 文件可读性。原 `responsePolicy: "none"` 限制不变。完整合同见 [Agent 接口](./rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)。

## API

以下区分管理入口与节点入口；列在这里不表示节点凭据可调用全部管理操作。

- `POST /api/lan-agent/enrollments`：受信管理端签发一次性票据。
- `POST /api/lan-agent/enroll`：以票据兑换独立节点凭据。
- `GET /api/lan-agent/self`：节点读取自身身份和连接状态，不列出其他节点。
- `GET /api/lan-agent/capabilities`、`GET /api/lan-agent/resources`、`GET /api/lan-agent/resources/read?id=<resourceId>`：已授权 Agent 发现操作和读取受限资源。
- `PUT /api/lan-agent/instances/<instanceId>/agents/<agentId>/authorization`：仅管理端可修改授权，启用正文为 `{ "enabled": true, "binding": { "provider": "<provider>", "sessionId": "<sessionId>", "managedSessionIds": [] } }`，其中 `managedSessionIds` 可省略，明确冻结 UI 当前显示的绑定；关闭正文仅为 `{ "enabled": false }`。先 GET instances，PUT 必须携带稳定 `Idempotency-Key` 与其强 ETag 作为 `If-Match`。授权回执持久保留 24 小时；同键同正文返回原回执，不重写授权，异正文返回 409。缺少版本返回 428，版本冲突返回 412。超时先 GET instances 核对当前授权，不自动重试；回执过期后重新读取并确认意图，再用新键与新 ETag。节点不能给自己授权。

- `GET /api/lan-agent/releases/manifest` 与 `GET /api/lan-agent/releases/<version>/node/<assetPath>`：发布清单与文件。
- `GET /api/lan-agent/nodes`：连接状态、发布信息与最近任务。
- `GET /api/lan-agent/instances`：本机和远端实例及其 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents`：添加 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents/<agentId>/<operation>`：`configure`、`scan`、`threads`、`hooks`、`context`、`tasks`。
- `POST /api/lan-agent/nodes/<nodeId>/tasks`：投递；省略 `targetAgent` 时采用节点声明的宿主。使用 `idempotencyKey` 去重。
- `POST /api/lan-agent/nodes/<nodeId>/update`：更新请求。
- `WS /api/lan-agent/connect`：`authenticate → authenticated → hello → connected → heartbeat`。

保留 `lan-agent` 连接和发布 API 路径供现有安装更新；未发布的 `lanAgent` 特殊处理端类型与 `lanAgentNodeId` 配置已移除，路由统一使用实例绑定，用户入口统一称为远端 Agent。旧 Remote Agent v3 是独立实验协议，不作为本次 Agent 端的投递路径或安装依赖；其迁移不在本次范围。

## 剩余实机验收

- 本轮发现指引与内容摘要更新机制的最终运行复验，以及 Windows ZIP 公共技能清单验收。
- 两台电脑首次安装、票据过期与重复兑换拒绝、授权启停与离线撤销、旧节点重新接入和旧 WebGUI 密钥轮换、断网恢复和登录启动。
- Codex/DSH 现有任务连续消息、宿主缺席和真实回复可见性。
- Windows、macOS、Linux 启动项和更新失败恢复。
## 能力范围

当前实现统一了实例身份、目录、Agent 管理界面与远端操作传输；实例内可以进入其绑定路由的共用完整设置。高级任务的实例分派、状态隔离与 Hook 归属已有代码和本机契约测试，真实远端宿主中的计划回传、消息处理看板和完整工作流仍须逐项验收。节点在线和本机协议夹具通过不代表真实双机或所有高级能力对等验收完成。
