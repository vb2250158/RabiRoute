<!-- docs-language-switch -->
<div align="center">简体中文 | <a href="./lan-rabi-agent-bootstrap_en.md">English</a></div>
<!-- /docs-language-switch -->

# 远端智能体接入与更新

已有 v2 电脑连接凭据保持原格式，不回退为逐 Agent 授权，也不要求重建节点。连接凭据和现有显式禁用项继续生效；Agent 类型与会话由每次调用指定。HTTP 调用可仅使用原节点 Bearer 凭据；需要标识 Agent 来源时，同时提供 `x-rabiroute-agent-type` 与 `x-rabiroute-session-id`，正文中的来源会话必须与之相符。此兼容不改变原业务投递回执或跨机验收要求。旧 v1 存储继续按其原合同读取。

连接器 0.2.5 中，复制接入提示词即包含本次接入和凭据修复授权，无需额外审批或主控 Agent 确认。已有有效凭据直接复用；凭据缺失或被拒绝时，用新票据修复原节点，保留 Agent 绑定、工作目录及用户明确设置的禁用项。客户端在兑换前保存当前用户私有的 `config.json.enrollment.json` 恢复记录，只含节点身份与随机恢复凭据，不保存票据。响应丢失时自动用同一凭据查询自身状态；中断后重新运行同一个 `--bootstrap`，即使 Manager 已重启也可核对已完成的同次兑换。已删除节点或已被替换的旧凭据不能用失效票据恢复。恢复文件保持私有，成功后自动删除；只有票据失效或缺失时才需要重新复制提示词。

> 状态：experimental（实验集成）。独立节点凭据、Manager 授权、受限 API、资源读取及上传后群文件发送已完成本机测试、完整构建和部署；`0.3.4-4b5d30118b40` 的 Host/Manager 健康与运行产物已核对。上传闭环通过真实 HTTP 与模拟 NapCat 验证，不代表真实双机、真实群文件或旧节点迁移已验收。后续发现指引与更新机制的审计修复须另行核对最终部署版本。

远端 Agent 只作为执行端接入：在 Agent 区域选择已接入实例及 Agent。消息端菜单、快速配置和设备密码扫描面板中的旧入口已移除。旧 `remoteAgent` 消息端键仅为存量配置兼容保留；完成实例／Agent 绑定迁移和旧任务回执归档后删除，不再用于新增接入。

## 远端 CMD 与 PowerShell

电脑能力直接由客户端执行，关联 Codex/DSH 无需启动。主机电脑上的 Rabi 服务承担常驻管理，不依赖单独的主控 Agent；普通已鉴权 Agent 可查询计划、近期与沉淀记忆、Skill。数据由对应 Rabi 服务统一保存。平台能力及使用步骤见[远端电脑客户端](remote-computer-client.md)。

Mac/Linux 的连接器 0.2.4 新增 POSIX 交互终端，按远端实际 shell 返回 Zsh/Bash/sh；依赖 node-pty，安装时保留 optional dependencies。Mac 使用当前用户 LaunchAgent；原生编译可能需要 Xcode Command Line Tools。Windows 的窗口查询与截图尚未迁移到 Mac。Mac 真机终端与 Desktop IPC 验收仍待节点在线。

连接器 0.2.2 在 Windows 默认提供两种终端。主机页面 **RabiLink → 远端智能体 → 在线电脑 → 远端终端** 可新增、查询、切换和退出会话。关闭窗口保留会话，退出终端结束其子程序；断线和主程序退出结束所有终端。操作使用原连接鉴权，命令在远端连接器用户身份下执行。使用与容量边界见 [远端终端](../apps/rabi-agent/README.md#远端终端022实验实现)。


## 用户只需三步

Windows 连接器 `0.2.1` 提供本地托盘：双击查看状态与日志，菜单控制连接器、打开主机管理页和设置开机启动。一个主程序拥有连接器及托盘子程序，退出时统一释放；Codex/DSH 保持独立。旧节点升级后正常退出原主程序，再用既有启动器启动一次；身份和任务绑定保留。托盘已通过本机隔离验证，真实双机升级和登录启动待验收。详见 [Windows 托盘](../apps/rabi-agent/README.md#windows-托盘021实验实现)。

1. 打开 **RabiLink → 远端智能体**（`#/rabilink?tab=agents`；旧 `#/lan-agents` 自动跳转至此），点击 **复制接入提示词**。一次点击即签发并复制包含完整接入指令与一次性票据的提示词（签发后 30 分钟有效，只能成功兑换一次，成功后立即失效），无需手填 WebGUI 密钥；提示词使用当前 Manager 的局域网地址和发布公钥指纹；本机回环地址会替换为当前局域网地址。Manager 须先启用局域网访问。票据过期或 Manager 重启后重新复制，不复用旧提示词。
2. 先选择目标系统 Windows、Mac（macOS）或 Linux，再复制对应提示词。只安装电脑客户端：检查 Node.js 22.13+ 与 CPU 架构、验证下载、保存空 Agent 列表的私有配置并注册当前用户登录启动。安装时不关联智能体，不设置默认任务，不要求 Codex/DSH 已启动。原“同时关联安装时使用的智能体”选项已移除。
3. 电脑上线后可使用电脑接口；需要远端 Agent 执行消息时再添加关联智能体，并从当前路由的 **消息适配器 → 添加 AGENT** 选择 **远端Agent(<IP地址>)**。没有节点时菜单引导接入；电脑使用稳定 instanceId，消息执行另绑定 agentId。

本机与远端电脑统一为实例，页面采用 **实例 → Agent** 两层折叠。本机默认出现，无需接入安装。远端卡片默认显示 **远端智能体（IP 地址）**，点击标题旁的铅笔 **修改名称** 可保存最多 80 个字符的单行名称，离线也可修改。名称保存在本机 Manager 的节点注册表中；刷新、Manager 重启和连接器重连后保留，留空恢复默认名称。卡片保留 IP，路由选择和最近任务也显示名称。名称只用于显示，不改变 `instanceId + agentId`、任务绑定或授权。每台 Manager 独立保存别名，远端连接器无需升级。

开发接口：`PUT /api/lan-agent/instances/:instanceId/name`，使用显式 WebGUI 管理认证，提交 `{ "name": "Build computer", "expectedName": "" }`。`expectedName` 取自最新 `GET /api/lan-agent/instances`（未命名为 `""`），冲突返回 `409`；成功后读取同一目录核对 `name`。这项修改立即保存，不依赖页面顶部的保存按钮。

实例内共用配置界面包含名称、开关、工作目录、任务名称与 ID、模型、推理强度、环境扫描、打开任务和 Hook 安装。扫描由用户显式刷新触发。角色自动化中的 Hook 策略仍由当前 Manager 管理。

提示词含短期接入票据，不再携带共享 WebGUI 管理 Token。只能粘贴到目标电脑的私密任务中，不要写入仓库、群聊、日志、截图或命令历史。复制使用安全剪贴板或页面回退，支持局域网 HTTP；HTTP 不提供传输加密，只在可信网络中使用。

接入成功后，连接器自动使用原节点凭据核对当前 Manager，不需要另申请接口或技能许可。`GET /api/lan-agent/self` 返回真实 `guid`、generation、instance、`nodeId` 与 WebSocket `connected`；WebSocket 离线不使节点凭据失效。新接入的 Agent 默认启用，页面的 **是否启用Agent** 是唯一的远端启用开关，由 Manager 保存，修改后立即 PUT 生效，离线也可停用。已接入连接器的 CLI、Hook 和任务入口不再用旧本地 `enabled` 二次拒绝；停用仍由 Manager 的当前身份与撤销检查执行。首次目录登记只在没有 Manager 决定时迁入旧显式停用；已有启用或停用决定优先，重连不会覆盖。保存工作目录、任务和模型不修改开关，并清除远端配置中的旧 `enabled` 字段；直接写该字段会提示使用总控开关接口。未接入的独立本地 Agent 保留自己的启用设置。界面读取失败时显示错误，不假定已启用。

仅携带有效节点凭据、未指定 Agent 的精确 `GET /meta` 可用于连接诊断，不授予业务或管理权限。普通业务必须满足存活与必需依赖就绪条件；精确元数据诊断只检查身份。

Manager 与连接器分别验收运行状态。双机验收需要远端在线并使用对应连接器版本；下文历史部署记录不能证明后续改动已经上线。

### 已连接但资源目录为空

`GET /api/lan-agent/resources` 返回 `200` 且 `data: []` 不等于未授权；权限拒绝返回 `401/403`。公开资源由 Manager 从当前安装包的 `packageRoot/skills` 和白名单 `packageRoot/docs` 读取，不能从可写的 `stateRoot` 扫描。安装版两根分离时，旧接线会错误返回空目录。修复或升级主机 Manager 后，用原节点凭据重新读取目录及 `docs/rabi-agent-interfaces.md`；不需要重新注册节点或反复授权，也不要把文档复制到状态目录绕过问题。连接状态、资源可读状态和 macOS 登录启动状态须分别验证。

### 已连接但资源目录为空

`GET /api/lan-agent/resources` 返回 `200` 且 `data: []` 不等于未授权；权限拒绝返回 `401/403`。公开资源由 Manager 从当前安装包的 `packageRoot/skills` 和白名单 `packageRoot/docs` 读取，不能从可写的 `stateRoot` 扫描。安装版两根分离时，旧接线会错误返回空目录。修复或升级主机 Manager 后，用原节点凭据重新读取目录及 `docs/rabi-agent-interfaces.md`；不需要重新注册节点或反复授权，也不要把文档复制到状态目录绕过问题。连接状态、资源可读状态和 macOS 登录启动状态须分别验证。

### 旧节点必须重新接入

缺少 `nodeCredential` 的旧配置不能把 `lanLinkToken` 当作新节点凭据。使用新票据重新接入，保留原 `nodeId`、Agent、任务绑定与允许的工作目录；已有独立凭据的重连不重复兑换票据。新源码已加入监听 HTTP/WS 前的安全迁移：发现旧 `lan-agent-tasks.json` 且没有完成标记时，即使旧注册表为空也轮换 WebGUI Token，成功后才写完成标记；迁移失败则中止启动。旧浏览器远程链接会失效，须在本机获取新链接，并更新受信管理客户端。对于检测范围外曾暴露的共享密钥，仍须确认撤销或轮换。**未轮换的旧共享密钥仍可能以管理权限绕过节点授权，关闭 Agent 授权不能撤销它。** 整体部署与 Host 健康不等于旧节点迁移验收；仍须逐节点核对重新接入和旧密钥失效，不能说所有现有安装已自动安全迁移。兑换超时或回执不确定时由 0.2.5 客户端保存并自动核对同次接入恢复信息，重跑 bootstrap 即可恢复，无需到 Manager 追加授权。

回滚警示：新授权状态在 `schemaVersion: 1` 中增加 `disabledAgentIds`，旧程序严格拒绝未知字段，并非直接向后兼容。回滚须使用与升级前版本匹配的 authority 恢复点，并核对升级后停用变更，防止恢复旧状态重新启用已停用 Agent；不得删除字段来绕过旧程序校验。

## 数据与执行边界

| 对象 | 唯一拥有者 | 行为与验收 |
| --- | --- | --- |
| 节点、IP、连接和任务状态 | Manager 的节点注册表 | HTTP 管理操作与 WebSocket 连接都显式鉴权；离线投递失败。 |
| 路由绑定 | 路由配置的 `agentAdapters`、`remoteAgentTargets` 与 `primaryAgentTarget` | 本机处理端和远端目标分别保存；远端引用 `instanceId + agentId`，不复制连接凭据或任务配置。主控选择具体目标，而不是仅选择 Codex/DSH 类型；Gateway 从本代 Manager 获得地址与凭据。 |
| 任务、模型、工具和权限 | 远端现有 Codex/DSH 宿主 | 实例保存各 Agent 的任务绑定，不新建备用 Runtime，不改变宿主启动配置；Manager 缺席时宿主仍独立运行。 |
| 后台连接进程 | 当前用户的 Rabi Agent | 主动连接 Manager；管理下载、校验、登录启动和更新。 |
| 真实消息路径 | 路由 → Agent adapter → Manager 节点注册表 → 远端进程 → 已绑定任务 | Codex 走 Desktop IPC；DSH 走本机 `session.prompt`，`mode=queue`。两者分别只有一条执行路径。 |

Codex owner 不可用时失败，不使用 `codex app-server`。DSH API 或绑定不可用时失败，不回退到 Codex。Codex 当前任务忙时明确拒绝新投递，避免覆盖任务关联；已接受的重复任务不重复执行。

节点在线只表示远端进程已连接。任务记录分别显示传送、领取、处理中、完成或失败。DSH 当前只回传队列接受状态，实际回复在其绑定会话查看；Codex 完成状态来自 Desktop 广播，回复在对应任务查看。本机图片路径不会直接发送到另一台电脑。完整计划助手、消息处理池与远端角色文件同步的能力对齐仍需继续验证；不能据此宣称所有本地高级功能已完整迁移。

## 安装与发布

| 平台 | 私有目录 |
| --- | --- |
| Windows | `%LOCALAPPDATA%/RabiAgent/` |
| macOS | `~/Library/Application Support/RabiAgent/` |
| Linux | `~/.local/share/RabiAgent/` |

提示词由 WebGUI 的统一模板生成，不再手工拼接文档里的第二份模板。它携带完整 Manager URL、一次性票据和固定发布公钥 SHA-256。票据可下载发布文件，成功兑换后即失效；兑换得到的独立 `nodeCredential` 只写入节点私有配置，Manager 只保存密钥 hash 与授权。登录启动项不含凭据。资源清单使用 Ed25519 签名；逐个文件验证 SHA-256 和大小，拒绝越界路径和跨源下载。签名密钥位于 Manager 私有数据中，升级须保留；轮换须重新分发可信指纹。

接入进程变量：`RABI_MANAGER_URL`、`RABI_AGENT_BOOTSTRAP_TICKET`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS`、`RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。Codex 使用 `RABI_AGENT_TYPE=codex-desktop` 和 `RABI_AGENT_CODEX_THREAD_ID`；DSH 使用 `RABI_AGENT_TYPE=dsh`、`RABI_AGENT_DSH_URL`、`RABI_AGENT_DSH_SESSION_ID`。这些值由远端 Agent 发现并写入私有配置，不要求用户输入。

`node rabi-agent.mjs --bootstrap` 是常驻进程，应隐藏并脱离安装终端运行。首次接入后刷新节点页面。Manager 在已认证连接事件中发布当前内容摘要；新版连接器默认自动更新，只有私有配置显式 `autoUpdate=false` 时关闭。相同版本号但内容变化也会更新，下载仍验证原固定公钥、签名及全部文件哈希。Manager 地址变化由连接器按原稳定 `guid` 有界发现并自动核验，不要求 Agent 手动检查身份、重新绑定、兑换票据或索要新 token；不能扫描或猜端口。发现失败报告具体阶段，不解释成 Manager 离线。

更新以已签名清单 `manifestPayload` 的 JSON SHA-256 内容摘要识别发布。下载放入摘要命名的不可变目录，复用前重新核对发布身份及逐文件 hash。更新 single-flight；候选先通过 IPC 报告 prepared，不连接、不执行业务。旧端最多等待 30 秒排空已接收任务；未排空保留原版本，不取消或重发任务。旧连接关闭确认后候选才激活并重读最新绑定；连接成功后原子切换 `current-release`，提交完成才释放候选执行并报告 updated。失败先确认候选退出，再恢复旧指针、启动器及 Hook 字节并重连；未确认退出不启动竞争 owner。shim 每次读取当前指针。旧候选不支持 IPC 交接时安全失败，不退回抢占连接。以上为源码与隔离夹具合同，真实双机升级仍须单独验收。

旧连接器缺少内容摘要、IPC 交接或动态发现能力时，不能仅凭新清单宣称自动迁移完成。必要的首次安装只更新连接器及稳定启动器，保留原 `nodeCredential`、nodeId、Agent、会话和工作区绑定；已有有效凭据不兑换新票据、不删除或重绑节点。旧 DSH 进程可能缓存 helper，磁盘替换不等于该进程已热更新；按原宿主受管重载并核对实际摘要与 Hook 行为。

自启范围是**当前用户登录后**的连接器，不承诺 Codex/DSH Desktop 登录前可用。Windows 使用隐藏 VBS 登录入口；macOS 使用当前用户 launchd `RunAtLoad`、失败保活与 30 秒退避；Linux 优先用户级 systemd `Restart=on-failure`，不可用时明确报告 desktop 登录回退，不启用 linger 或系统服务。稳定启动器只持有一个 owner，异常退出有界指数退避并重读最新指针；正常退出或 `--stop` 不自动复活。更新候选通过 IPC 交给同一启动器监管，旧 worker 退出不启动第二个。以上有临时进程、Windows VBS 和三平台配置夹具覆盖，未据此宣称远端真实重启或 macOS/Linux 原生登录验收。

### 生命周期与历史入口收尾

- Manager 的节点注册表拥有远端启停及目录投影；远端私有配置拥有凭据、工作区与宿主绑定。目录、Skill 和 Route 不是额外接口许可。Host 独占本机 Manager 生命周期；远端稳定启动器独占连接器 worker 生命周期，两者不创建备用业务 Runtime。
- 启动器及 endpoint 配置写入分别由操作系统内核 listener 拥有互斥，崩溃释放。Windows 使用按 canonical 配置路径 hash 的 named pipe；Unix 使用单个 hash 派生回环 listener，冲突明确 busy、不扫描或抢占。仅用于本机互斥／控制，不是 Manager 发现地址。旧 `launcher-owner.json`、`.recovery`、pathname socket 和 `.endpoint-lock` 不再参与判断或写入，也不根据陈旧 PID 删除它们。迁移前须退出旧连接器，不能混跑旧 writer。
- endpoint 写入只合并已核验地址与身份，并对原节点、凭据及 endpoint 字段作 CAS；不会覆盖并发更新的 Agent、工作区或 `autoUpdate`。稳定启动器的控制诊断不作为锁真源，停止复用同一内核 owner。
- 技能 ZIP 下载与普通 HTTP 调用复用同一 `/meta` 解包和身份合同，不保留裸对象专属副本。更新后的共享 Hook 按已提交指针读取；重复运行旧 bootstrap 不回退已有有效发布指针。提交后再次核验失败的候选非零退出，由原启动器恢复，不能保持 IPC 假存活或报告 updated。
- 上述收尾按实际调用链检查；不代表所有远端历史启动项均已真机清理。Windows 临时进程与配置夹具、macOS/Linux 模拟命令和实机登录验收须分别报告。

## 实例身份与管理

本机 instanceId 持久保存在 Manager 私有目录的 `agent-instance-id.json`；远端 instanceId 沿用连接程序私有 `nodeId`。不再从单任务配置合成 `agentId=default`，已有目录身份保持不变，新增 Agent 使用 UUID。每次投递明确传递类型与完整会话 ID，不先改绑固定任务；目录与会话列表查询见[远端目标合同](rabi-agent-interfaces.md#远端-agent-的明确目标与列表查询)。Agent 配置由执行电脑持有，Manager 保存目录投影；本机 Agent 继续以原有路由配置为事实源，保存经过原有并发版本检查。

本机与远端共用 `instanceManagement.ts` 的扫描、任务与 Hook 安装逻辑。远端通过有请求 ID 和连接所有权校验的 WebSocket RPC 调用；断线立即失败，超时后必须先刷新再决定是否重试。Hook 通过已注册 Agent 的会话 ID 校验，使用隔离的实例身份关联当前 Manager 角色。

实例中的“路由与完整 Agent 设置”进入同一消息适配器页面，包含消息处理、独立记忆整理与计划协助设置。消息处理池和记忆整理按 `instanceId + agentId + 主任务 ID` 隔离持久状态；切换电脑或重绑主任务后不会复用旧电脑的工作任务。创建或解析出的协助任务登记到所属 Agent，Manager 后续按归属分派；离线和身份歧义会失败，不降级到本机。

安装版从当前不可变版本包读取接入程序、共用管理运行库和 Hook 包，签名密钥仍保存在私有数据目录。再次粘贴接入提示词更新连接时保留原实例 ID、Agent 目录和已允许的工作目录。已绑定的本机任务关闭后仍保留在实例中，可以重新开启。路由可以同时保留本机 Codex 和多个远端 Codex，各自独立显示、移除和选择；新增远端不会替换本机卡片，也不会自动切换主控。删除主控后须明确选择新的主控，离线时不自动改投本机。

旧版 `agentInstanceBindings[provider]` 只在配置读取边界迁移：保留本机配置字段，转换成独立远端目标；原主控如果指向远端，迁移后仍指向同一实例和 Agent。保存后移除旧字段，避免删除的远端目标再次出现。迁移不创建会话，不更改节点授权；没有本机会话的卡片仍需配置。

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
- 角色技能另走 `GET /api/roles/:roleId/skills`（摘要列表）与 `GET /api/roles/:roleId/skills/:skillId`（详情）；`/roles/...` 别名遵守相同边界。通过节点凭据与已启用 Agent 身份认证的请求，与本机 Agent 一样可以读取各角色有效技能目录，不额外要求该角色 Route 绑定或逐技能授权。Route 绑定不充当技能读取授权源；Agent 禁用、节点撤销、授权版本及原始会话绑定复验仍由统一请求认证执行。本机管理请求保留原认证。这里不合并宿主全局或私有技能目录，也不将私有技能、凭据和同步配置发布到公共 `resources`。
- 角色技能列表和详情均使用有界交互读取池，不排在目录批量任务之后；断连取消读取，队列忙、任务超时或工作进程终止未确认返回 `503`，而不是合法空列表。已授权角色的技能不存在返回 `404`，正常无技能为 `200` 加空列表。上述角色权限与队列修复需以实际部署版本验收，源码测试不代表所有运行节点已更新。
- 按需取 Manager 当前发布的最新技能和合同，随后读取目录中可用的 references；不要把整套技能长期复制为另一份权威来源。计划、记忆与消息处理状态仍由 Manager 持有，不复制到远端维护第二套业务状态。
- 经统一入口认证且仍启用的 Agent 对公共管理 API 与本机 Agent 同权，不以操作目录、Route 主控或额外 WebGUI Token 形成远端专属子集；操作目录用于发现，不是公共管理授权白名单。原始路径、编码、查询凭据检查，以及共同的对象权限、Action Gate、文件根、确认、版本与幂等条件仍有效。只读模式和 generation 约束对两端相同；Agent 启用不替代 Host 私有生命周期、设备资源密钥／所有者或 Peer 接收协议的认证。普通未认证浏览器保留原本机／WebGUI Token 边界。各二次处理器仍在开发复验中，本条是源码实施合同，不代表所有接口和运行节点已完成对等验收。
- JSON 请求体沿用本机 `readJsonBody` 默认值及各接口显式限额，不再叠加远端专属 1 MiB 上限，也没有新增共同限额。来源身份校验、上传限额及各业务处理器原有检查保持不变。QQ 消息读取与模型目录设置使用统一认证 principal，不以来源元数据或伪造 Agent 请求头授权；异步结果和设置写入前须复验原授权，撤销后不降级到 loopback。本轮尚未部署，完整队列与流式接口复验继续实施。
- 撤销检查保留请求最初的节点、Agent、授权版本与会话绑定，不因禁用后重新启用或重新注册恢复旧请求权限。存储变更在异步读取、入队和实际派发时复验，并在工作进程读取回执、恢复事务或访问业务数据前，通过仅在本次派发有效的 IPC 准入握手再次复验。允许准入后，该完整操作不可撤回；随后撤销不会回滚已经准入的提交或恢复，不能承诺撤销返回后绝无新发布。已派发请求的拒绝或中断保守标记为提交状态未知，可能已有同幂等键的历史提交；必须权威回读，不盲目重试。该准入机制处于源码开发验证阶段，尚未完成部署和双机验收。
- 向消息渠道正式发送沿用 Manager 的消息合同，必须取得 Manager 与渠道回执；任务最终文本不代表已发送。远端调用仍遵守 Route 发送权限：`onlyPrimary` 要求可信 `provider`、Route 的 `instanceId`/`nodeId` 与 `agentId`、已批准的会话及 `primary_persona` 身份全部匹配；仅裸会话 ID 同名不会继承本机权限。
- 跨 Agent 投递时，远端主会话来源按实例命名空间记录。目前只支持 `responsePolicy: "none"` 的单向投递；因缺少可信回传路由，`responsePolicy: "required"`、`inReplyToRequestId` 正式回复及远端到远端投递均明确拒绝，不能视为完整支持正式回复。远端上下文只走自身专用 `context` 入口，不开放通用 `codex-hook` 接口。

Windows 发布流程将公共 `skills/` 按受控的 Git tracked 文件复制进版本包，不复制工作区中的私有或未跟踪内容。该打包链尚未运行 ZIP 验收；不能据此宣称安装包已经包含可用的完整技能目录。

### 下载一个技能及其配套文件

读到技能正文但缺少 `scripts/` 或 `references/` 时，下载选中技能的完整目录，不要复制整个角色或让远端猜主机路径。已鉴权 Agent 沿用同一节点凭据；接口不会执行脚本。

安装 launcher 会以当前不可变 release 目录作为工作目录，`./` 不指向用户 shell 或项目目录。请明确选择本机 Rabi Agent 安装目录外、已存在的父目录，并为 `--output` 提供绝对文件路径；最终文件必须不存在。以下 Bash 示例仅在你已选择并确认 `$HOME/Downloads` 存在且位于安装目录外时使用；否则替换为你选择的已有目录，不自动创建目录。`$HOME` 由 shell 展开为绝对路径。

```bash
node rabi-agent.mjs --api GET "/api/roles/<roleId>/skills/<skillId>/download" --agent "<agentId>" --output "$HOME/Downloads/selected-skill.zip"
```

使用 Hook 给出的已安装连接程序路径。Manager 与远端连接程序分别验收：部署新 Manager 不证明 Mac 已有支持 `--output` 的 CLI；旧连接程序须沿上文安装/签名更新流程升级，再确认 Hook 与 CLI 提供此选项，不另装备用更新器。HTTP 下载接口本身可由符合鉴权合同的二进制客户端独立调用。目标父目录须存在，已有文件不会被覆盖；客户端验证 ZIP 长度、SHA-256 与 Manager 前后身份后才报告成功，不自动解压或执行。包顶层是 `<skillId>/`，包含该技能目录的全部普通配套文件；flat Markdown 只包含 `<skillId>/SKILL.md`。另一技能需单独下载，不自动追根外引用。链接、越界、不安全名称或超限使整包明确失败，不静默漏脚本。完整[下载合同、上限与错误处理](rabi-agent-interfaces.md#下载指定技能目录)以部署版本为准。

Mac 可以下载 `.ps1` 不代表有 `pwsh`、脚本中的路径适用或已获执行授权。这里只验证已登记 Rabi Agent 到其配置 Manager 的下载；公网 RabiLink 大包转发及真实跨机验收另计。

## 上传文件并发送到 QQ 群

> 上传链路已完成本机集成测试、完整构建及 `0.3.4-4b5d30118b40` 部署验证。测试使用真实 HTTP 与模拟 NapCat，未向真实群发送文件；真实双机群文件链路仍待验收。

独立节点凭据及总控批准的 primary Agent 是前提。上传仅把文件交给 Manager，不自动发送到群。最短操作与完整发送 JSON 见 [接口说明中的上传示例](./rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)：

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` 为必填、预先保存的稳定 UUID，不自动生成。上传 HTTP 使用 `PUT /api/agent/uploads/<UUID>`、`application/octet-stream`、同 UUID 的 `Idempotency-Key`、URI 编码 basename 的 `x-rabiroute-file-name` 和内容摘要 `x-rabiroute-content-sha256`。同路径 GET 返回 `{code:0,data:{id,fileName,size,sha256,expiresAt}}`，到期时间为 ISO，不返回本地 path。默认单文件 2 GiB（2048 MiB，硬上限）、总量 4 GiB、最多 100 个、TTL 24 小时；HTTP 上传总并发上限为 4，跨 owner 合计。超时、503、切代或不确定回执后先重新发现并核对 Manager，再 GET 原 UUID；不自动重试或换 ID。

大包上传使用流式二进制传输、流式落盘及增量 SHA-256 校验，期限 30 分钟，不把整包装进 JSON 或内存。可在「RabiLink → 配置」保存 `agentUploads.maxFileMiB`（整数 `1..2048`，默认 `2048`），持久化到 `data/Config.json`，重启 Manager 后生效；已鉴权且未被显式禁用的远端 Agent 同样可通过 `PATCH /api/rabi/identity` 修改，遵守共同参数、强 ETag 与幂等合同，不另申请功能许可。

已用 734 MiB（769654784 字节）的受控文件完成真实客户端到 loopback Manager、磁盘及模拟 NapCat 的 size/SHA-256 集成验收；生成和接收均按 64 KiB 小块，大于 8 MiB 的 Buffer 分配/拼接被测试防线拒绝。大测试由 `RABI_TEST_LARGE_UPLOAD=1` 显式启用，临时文件自动清理。**尚未验证真实 QQ 平台接收这一大小的文件**，仍须核对 NapCat/QQ 限制及群权限。旧连接器需要新版 bootstrap（保留已有节点凭据），旧 Hook 缓存需要重载宿主；仅更新 Manager 不会让旧客户端支持大包。

发送仍用原 `/api/agent/send`，保留稳定 `deliveryId`、`sender`、准确 `routeId`、`channel=napcat`，以及 `params.target=group/groupId/instanceId/replyToMessageId`；引用 ID 必须是具体消息 ID 或空字符串。标准输入 JSON 的文件部分为 `payload:{type:'file',fileId:<upload-data.id>,fileSha256:<upload-data.sha256>,text?}`。`fileId` 与 `path`、`url`、`fileName` 互斥，显示名从上传元数据取得，只用于群文件，不用于图片、语音或其它 channel。原引用核对和 tracking 合同仍生效。

`fileSha256` 为使用 `fileId` 时的必填项，必须取上传 `data.sha256`（64 位小写十六进制），防止 24 小时过期后 UUID 复用使旧引用换成其它内容。发送 callback 在 lease 内核对实际 hash，不匹配拒发。

归属按 `nodeId + agentId`，同 Agent 多 session 共享但每次仍要求可信批准 source。Manager 内部可信 resolver 按请求核对授权、归属、完整性与 TTL；活跃 inflight lease 期间不清理文件。不扩大 `allowedFileRoots`，原本地 path 发送照旧。渠道必须允许发送和 `file`，发送者身份仍按投递合同核对。只有 Manager 与渠道回执才能证明群发送。群文件已被 NapCat 接受但 caption 失败时保留 `sent`，只补文本，不重发文件。当前 NapCat 读取 Manager 路径，异机 NapCat 需要共享可读目录；这不解决任意跨机 NapCat 文件可读性。原 `responsePolicy: "none"` 限制不变。完整合同见 [Agent 接口](./rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)。

## API

仅持有节点凭据可做接入诊断；已启用且通过鉴权的 Agent 与本机管理端具有相同公开接口和配置权限。

- `POST /api/lan-agent/enrollments`：受信管理端签发一次性票据。
- `POST /api/lan-agent/enroll`：提交 `{ ticket, nodeId, enrollmentSecret }` 兑换或修复原节点凭据。`enrollmentSecret` 由 0.2.5 客户端生成 32 字节随机数并以 base64url 编码（43 字符），在请求前写入私有恢复记录；Manager 只保存摘要。同节点、同恢复凭据的已完成请求可在响应丢失、票据已消耗或 Manager 重启后返回同一结果，不轮换凭据或改变禁用项。其它新增或修复请求仍必须携带有效票据。旧客户端省略此字段时只支持首次接入，不能替换已有节点。
- `GET /api/lan-agent/self`：节点读取自身身份和连接状态，不列出其他节点。
- `GET /api/lan-agent/capabilities`、`GET /api/lan-agent/resources`、`GET /api/lan-agent/resources/read?id=<resourceId>`：已授权 Agent 发现操作和读取受限资源。
- `PUT /api/lan-agent/instances/<instanceId>/agents/<agentId>/authorization`：正式 Agent 启停接口，本机管理端与已启用且鉴权的 Agent 均可调用，快照继续通过 `authorization.nodes[].enabledAgentIds` 投影启用状态，不另设 API 权限开关；启用正文为 `{ "enabled": true, "binding": { "provider": "<provider>", "sessionId": "<sessionId>", "managedSessionIds": [] } }`，其中 `managedSessionIds` 可省略，明确冻结 UI 当前显示的绑定；关闭正文仅为 `{ "enabled": false }`。先 GET instances，PUT 必须携带稳定 `Idempotency-Key` 与其强 ETag 作为 `If-Match`。授权回执持久保留 24 小时；同键同正文返回原回执，不重写授权，异正文返回 409。缺少版本返回 428，版本冲突返回 412。超时先 GET instances 核对当前授权，不自动重试；回执过期后重新读取并确认意图，再用新键与新 ETag。仅持有节点凭据或已被停用的 Agent 不能自行启用。

- `GET /api/lan-agent/releases/manifest` 与 `GET /api/lan-agent/releases/<version>/node/<assetPath>`：发布清单与文件。
- `GET /api/lan-agent/nodes`：连接状态、发布信息与最近任务。
- `GET /api/lan-agent/instances`：本机和远端实例及其 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents`：添加 Agent。
- `POST /api/lan-agent/instances/<instanceId>/agents/<agentId>/<operation>`：`configure`、`scan`、`threads`、`hooks`、`context`、`tasks`。
- `POST /api/lan-agent/nodes/<nodeId>/tasks`：投递；每次必填 `agentId`、`targetAgent`、完整 `threadId` 与 `message`，不推断默认目标。使用 `idempotencyKey` 去重。
- `POST /api/lan-agent/nodes/<nodeId>/update`：更新请求。
- `WS /api/lan-agent/connect`：`authenticate → authenticated → hello → connected → heartbeat`。

保留 `lan-agent` 连接和发布 API 路径供现有安装更新；未发布的 `lanAgent` 特殊处理端类型与 `lanAgentNodeId` 配置已移除，路由统一使用实例绑定，用户入口统一称为远端 Agent。旧 Remote Agent v3 是独立实验协议，不作为本次 Agent 端的投递路径或安装依赖；其迁移不在本次范围。

## 路由目标与投递测试合同

路由的 `agentAdapters` 保存本机处理端类型；`remoteAgentTargets` 保存 `{ id, provider, instanceId, agentId }`。`id` 为 `remote:<URI 编码的 instanceId>:<URI 编码的 agentId>`，本机目标键为 `local:<provider>`。`primaryAgentTarget` 选择完整目标键，空字符串表示尚未选择；`primaryAgentAdapter` 只是派生的处理端类型，不能区分本机和远端。远端目录、会话和模型仍由所属实例提供。

现有路由保存接口保存上述字段；`/api/rabi/instances/:guid/routes/:routeId/agent-binding` 的 PATCH/POST 同样接受 `remoteAgentTargets` 和 `primaryAgentTarget`，沿用原有管理授权、配置版本与幂等合同。旧 `agentAdapter` 参数明确选择本机目标，不删除其它已添加目标。

`POST /gateways/:id/agent-delivery-test` 是**真实消息投递**，不是预览。正文可以指定 `agentTargetId`；同时提供 `agentAdapterType` 时必须与目标一致。只提供旧 `agentAdapterType` 时选择本机；两者均省略时使用已保存的主控。成功返回 `data.agentTargetId` 及原有投递结果。目标不存在、类型不符或离线时失败，不更换目标；结果不确定时先核对原任务，不自动重发。复用连接鉴权，并检查 Route 启用状态及投递合同。

本机会话操作 `POST /api/agent/threads` 可明确携带 `agentTargetId: "local:<agentAdapter>"`，必须与 `agentAdapter` 一致且不得同时提供远端 `instanceBinding`。此标记禁止按同名会话 ID 推断远端 owner；远端操作仍使用明确的实例绑定或实例路径。未提供标记的旧调用保持原有解析合同，鉴权和任务权限检查不变。

计划秘书会话和绑定保存 `agentTargetId`，即使两台电脑返回相同会话 ID 也不会混用；旧记录只在旧配置迁移时确定归属，已采用新格式却缺失目标身份的记录不自动归给后来选择的主控。

## 剩余实机验收

- 本轮发现指引与内容摘要更新机制的最终运行复验，以及 Windows ZIP 公共技能清单验收。
- 两台电脑首次安装、票据过期与重复兑换拒绝、授权启停与离线撤销、旧节点重新接入和旧 WebGUI 密钥轮换、断网恢复和登录启动。
- Codex/DSH 现有任务连续消息、宿主缺席和真实回复可见性。
- Windows、macOS、Linux 启动项和更新失败恢复。
## 能力范围

当前实现统一了实例身份、目录、Agent 管理界面与远端操作传输；实例内可以进入其绑定路由的共用完整设置。高级任务的实例分派、状态隔离与 Hook 归属已有代码和本机契约测试，真实远端宿主中的计划回传、消息处理看板和完整工作流仍须逐项验收。节点在线和本机协议夹具通过不代表真实双机或所有高级能力对等验收完成。

维护者可以由本机可信发布 owner 调用 `LanAgentReleaseStore.importRelease(frozenAgentRoot)`，将已冻结并审查的目录复制为不可变签名快照；HTTP 不接受发布目录或任意代码。`assignRelease(nodeId, releaseDigest, expectedReleaseDigest)` 持久保存稳定节点的版本选择并校验当前摘要；`releaseDigest=null` 返回共同版本。候选使用原签名身份，导入失败或 CAS 冲突不改变节点选择。数据位于私有 state root 的 `data/lan-agent-releases/`，不修改原共同 Agent 根。

现有 `POST /api/lan-agent/nodes/:nodeId/update` 可在不传 `version` 时提交 `releaseDigest` 与必需的 `expectedReleaseDigest`，只为该已连接节点选择既有签名快照，再发原更新通知；冲突返回 409。签名清单、重连通知和不带快照参数的资源读取按可信凭据中的 nodeId 选择；未分配节点和普通应用连接使用共同版本；初始 bootstrap ticket 仍读取共同版本，已有有效 nodeCredential 的连接器按原 nodeId 选择，无需业务 Agent header 或 profile。已签名下载 URL 的 `release` 参数固定不可变快照，分配变化不混入新文件。分配不是接口权限；其他鉴权连接仍可使用全部公开接口。选择已提交但通知失败时响应标记 `uncertain`，先核对该节点的清单，不能当作指针未变重复操作。macOS arm64 已完成真实签名资产、单节点分配、原启动器升级、默认 Desktop IPC 与会话扫描验收；其他平台和实际业务投递仍须分别验收。GET nodes 返回的 releaseDigest 是该节点当前期望发布摘要；实际采用须核对安装指针、worker 或对应的正式证明。
