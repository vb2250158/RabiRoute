<!-- docs-language-switch -->
<div align="center">
简体中文 | <a href="./README_en.md">English</a>
</div>
<!-- /docs-language-switch -->

# Rabi Agent

连接器 0.2.5 中，复制接入提示词即包含本次接入和凭据修复授权，无需额外审批或主控 Agent 确认。已有有效凭据直接复用；凭据缺失或被拒绝时，用新票据修复原节点，保留 Agent 绑定、工作目录及用户明确设置的禁用项。客户端在兑换前保存当前用户私有的 `config.json.enrollment.json` 恢复记录，只含节点身份与随机恢复凭据，不保存票据。响应丢失时自动用同一凭据查询自身状态；中断后重新运行同一个 `--bootstrap`，即使 Manager 已重启也可核对已完成的同次兑换。已删除节点或已被替换的旧凭据不能用失效票据恢复。恢复文件保持私有，成功后自动删除；只有票据失效或缺失时才需要重新复制提示词。

Rabi Agent 是远端电脑客户端。Windows 提供托盘和状态窗口，macOS/Linux 保持后台运行。它主动连接主控 Rabi Manager，提供电脑接口；可选关联远端 Agent 执行任务，Codex Desktop 使用 IPC，DSH 使用本机 `session.prompt`。

主机电脑的 Rabi 服务承担常驻管理职责，无需另设主控 Agent。普通已鉴权 Agent 也可查询计划、近期与沉淀记忆、Skill；Route 或是否为主角色不构成额外许可。电脑能力按实际平台提供，关联 Codex/DSH 无需启动。使用步骤见[主机与远端电脑客户端](../../docs/remote-computer-client.md)。

## Mac 接入与终端

接入弹窗先选择 **Mac（macOS）**，再复制对应提示词；Windows 和 Linux 使用各自的选项。安装时不再关联当前智能体，不设置默认任务。Mac 使用与 CPU 架构匹配的 Node.js 22.13+，安装在 `~/Library/Application Support/RabiAgent`，由当前用户 LaunchAgent 启动；没有 Windows 托盘。

连接器 0.2.4 增加 Zsh/Bash/sh 交互终端，列表仅返回该电脑实际存在的 shell。安装使用 `npm install --omit=dev --include=optional`；终端依赖固定版本 node-pty，原生编译可能需要 Xcode Command Line Tools。文件互传和明确类型/会话 ID 的 Agent 投递复用通用接口。窗口列表、截图及 CMD/PowerShell 当前仍是 Windows 能力。

Mac 原生终端与 Desktop IPC 仍需在线真机验收。`401 LAN_AGENT_CREDENTIAL_REQUIRED` 是节点凭据错误，应保留原 nodeId 和配置，不以创建主控 Agent、新节点或反复重装代替修复。

## 查询 Agent 与明确投递目标

`GET /api/lan-agent/instances` 返回电脑与 Agent 目录；向对应 Agent 的 `/threads` 接口提交 `action:list` 和明确的 `agentAdapter` 查询会话，再向 `/tasks` 每次提交 `provider`、完整 `threadId` 和正文。投递不再使用隐含 `default` 或先改绑固定任务。完整请求、分页和幂等要求见[远端目标合同](../../docs/rabi-agent-interfaces.md#远端-agent-的明确目标与列表查询)。

## 远端终端（0.2.2，实验实现）

在主机 WebGUI 的 **RabiLink → 远端智能体** 展开在线电脑，点击 **远端终端**。Windows 默认支持 **CMD** 和 **PowerShell**，无需额外功能开关。

1. 选择终端类型，可填写远端已有的绝对工作目录，点击 **新增终端**。
2. 在终端中直接输入，支持中文、粘贴、Ctrl+C 和窗口尺寸变化；目录和环境在同一会话中保留。
3. **查询终端** 读取远端真实会话列表和进程状态。关闭窗口保留会话，重新进入后可选择已有终端。
4. 点击会话旁的停止按钮 **退出终端**，结束该终端及其子程序。主程序退出、连接器停止或远端连接断开时也会结束全部终端；不会自动重新执行命令。

终端运行在连接器的 Windows 用户身份下；使用现有已鉴权连接，不增加第二套管理密码或逐功能授权。一个主程序拥有连接器，连接器拥有原生终端宿主，宿主在 Windows Job Object 中管理 CMD/PowerShell 及其子程序。ConPTY 提供真实终端，网页使用 xterm.js。Windows 10 1809 或更新版本提供所需系统接口。

每节点最多 8 个活动终端，当前连接器保留最多 64 条会话记录；输出仅在内存中保留最近 256 KiB，网页滚动缓存最多 2000 行，不写命令或输出日志。断线/超时后查询已有会话和输入序号，不自动重建或重放。活动终端须退出后再重启或更新连接器。

本机原生终端、HTTP/WebSocket/SSE 链路和输入回执已验证；安装版与真实双机验收另行记录。


## Windows 托盘（0.2.1，实验实现）

登录启动和手动运行均进入同一个主程序。稳定启动器是唯一生命周期拥有者，连接器和托盘都是其子程序；状态窗口由托盘子程序内部创建。重复启动不创建第二套连接器，主程序退出或意外结束时子程序一并退出。

- 双击托盘图标打开状态与日志：连接状态、版本、绑定任务、最近投递结果，以及最多 120 条当前进程状态记录。Agent 在真实投递前显示“运行未核验”；不定时扫描宿主或会话。
- 菜单提供启动/停止/重启连接器、重新连接主机、打开主机管理页、开机启动和退出。停止连接器保留托盘，退出结束本应用全部子程序；Codex/DSH 仍由其自身管理。更新或已知任务执行期间，连接器控制暂不可用。
- 开机启动修改由主程序写入并回读；原启动文件留底，其他安装的启动项拒绝覆盖。打开管理页使用不带凭据的当前主机地址，由浏览器完成登录。
- 托盘仅经父子管道消费脱敏状态和提交操作，不读取私有配置、不连接 Manager、不另起 Agent Runtime。

已完成 Windows 原生托盘、菜单、单实例、进程退出和隔离发布资产测试；真实双机升级及登录启动仍待验收。旧签名版本升级后需正常退出原主程序，再从既有启动器启动一次，才采用新的主程序和托盘；不重新接入或更换任务绑定。

命令行控制也交给同一个主程序：`node rabi-agent-launcher.mjs --config <私有配置> --command status|start|pause|restart|reconnect|enable-startup|disable-startup`；`--stop` 退出整套应用。CLI 控制进程只执行单次请求。

> 状态：experimental（实验集成）。接入、授权及上传后群文件发送已通过本机测试、完整构建和 `0.3.4-4b5d30118b40` 部署健康核验。上传集成使用真实 HTTP 与模拟 NapCat，真实双机群文件尚未验收。本轮发现指引与内容摘要更新修复须另核最终运行版本；Windows ZIP 整包尚未验收。

## 本机计划与记忆 MCP（实验实现）

知识 MCP 已分离到 [`../rabi-mcp`](../rabi-mcp/README.md)，不包含在远端 Agent 更新依赖中。下述环境配置用于独立 MCP 应用，不是本工作进程的启动参数。

在 MCP 宿主的环境设置中配置：

- `RABIROUTE_HOST_EXE`：可选，本机 Host 可执行文件；未设置时使用当前用户默认安装位置。
- `RABI_MCP_ALLOWED_ROLES`：必填，JSON 字符串数组，例如 `["example"]`。只允许这些角色，工具参数不能扩权。
- `RABI_MCP_ALLOW_WRITES`：默认 `false`；明确设置为 `true` 才开放创建、更新及会更新阅读时间的近期记忆详情。

工具覆盖知识搜索、计划列表/详情/状态目录、记忆列表与沉淀详情；开启写入后增加计划及近期记忆创建/更新。更新必须传原样强 ETag，写操作必须提供已保存的稳定幂等键。近期详情也按当前 Manager 的 touch 写入回执合同核对；只读 Manager 缺少该回执时不确认成功。工具不提供删除、沉淀执行、归档写入、附件、任务绑定或任意 HTTP 请求。

目前通过 35 项隔离模块、官方 SDK 内存及真实 stdio 子进程测试（正常退出，无日志混入协议），并已实测本机 Host 动态身份发现；测试未读写真实计划或记忆。尚未完成安装发布、外部 Agent 工具注册或手机/眼镜真机验收。手机的 Relay 管理页不是 MCP 宿主；此入口存在不代表眼镜所绑定的 Agent 已加载工具。

## 首次接入

1. 在主机 WebGUI 的 **远端 Agent** 页面选择目标系统，再复制接入提示词。只安装电脑客户端，需要 Node.js 22.13+，不要求 Codex/DSH 已启动；安装工具不绑定自己的当前任务。
2. 提示词使用默认 30 分钟有效的一次性票据下载已签名程序，并由 `--bootstrap` 兑换独立 `nodeCredential`。凭据存入当前用户私有配置；Manager 只保存密钥 hash 与授权，登录启动项不含凭据。票据不是共享 WebGUI Token，成功兑换后不可重用。
3. 连接器自动核对原节点身份；`/api/lan-agent/self` 仅供诊断，`connected=false` 不等于凭据失效，不要求 Agent 手动核验或重绑。新接入的 **是否启用Agent** 默认勾选，启用后按本机 Agent 的方式使用，无需另开 API 或 skills 授权。需要消息投递时，在路由的消息适配器选择 **远端Agent(<IP地址>)** 中的准确 Agent 并保存。

首次只安装客户端时，不设置 `RABI_AGENT_TYPE`、Codex 任务或 DSH 会话变量；`--bootstrap` 保存 `agents: []`，正常启动、登录自启和重连均不要求 Agent 任务。已有配置保留原 Agent 与节点身份。后续通过正式入口登记 Agent；普通已鉴权 Agent 可通过相同接口读取计划、记忆与 Skill，不以主控身份为条件。

远端启用状态只由 Manager 持有；开关修改后立即 PUT 生效，离线也可停用，不必保存执行参数。已接入节点的 CLI、Hook 与执行入口不再使用旧本地 `enabled` 形成第二道门禁。首次接入时，尚无 Manager 决定的旧显式停用状态迁入 Manager；已有启用或停用决定始终优先，重连不会覆盖。保存任务、工作目录和模型不修改启用状态，并移除远端配置中的旧字段。读取失败显示错误，不假定已启用。连接器更新与真实双机调用须分别验收。

完整安装步骤、私有目录、凭据迁移与排障见 [远端 Agent 接入与更新](../../docs/lan-rabi-agent-bootstrap.md)。安装使用统一提示词，不手工复制第二套模板：

```bash
node rabi-agent.mjs --bootstrap
```

仅为安装子进程提供 `RABI_MANAGER_URL`、`RABI_AGENT_BOOTSTRAP_TICKET`、`RABI_NODE_ID`、`RABI_AGENT_DEFAULT_CWD`、`RABI_AGENT_ALLOWED_CWDS` 和 `RABI_AGENT_RELEASE_PUBLIC_KEY_SHA256`。Codex 使用 `RABI_AGENT_TYPE=codex-desktop`、`RABI_AGENT_CODEX_THREAD_ID`；DSH 使用 `RABI_AGENT_TYPE=dsh`、`RABI_AGENT_DSH_URL`、`RABI_AGENT_DSH_SESSION_ID`。不要把凭据放入命令参数、日志或仓库；票据只用于私密安装。

连接器默认根据 Manager 已签名内容摘要自动更新，显式 `autoUpdate=false` 关闭；同版本内容变化也可更新。唯一稳定启动器监管单一 worker；更新候选按 prepared → 排空 → 旧连接关闭 → 激活 → 指针提交 → 释放执行的顺序交接，失败保留旧版，不取消或重发业务。当前用户登录自启、异常保活、旧安装迁移与实机验收边界见[权威接入合同](../../docs/lan-rabi-agent-bootstrap.md)。已有有效凭据不重复兑换、不重绑；覆盖磁盘不等于宿主热更新。

## 从现有任务使用 Manager

远端优先使用 Hook 提供的已安装连接器 `--api` 命令。本机 Host 发现规则只适用于 Manager 电脑，远端缺少 Host 不代表 Manager 离线。能力与资源入口是 `/api/lan-agent/capabilities`、`/api/lan-agent/resources`。目录只广告实际可读文件和 references；四份公共合同及其英文版均可按返回 ID 读取，不能把任意 Markdown 链接当作资源授权。

```bash
node rabi-agent.mjs --api GET /api/lan-agent/capabilities --agent <agentId>
node rabi-agent.mjs --api GET /api/lan-agent/resources --agent <agentId>
node rabi-agent.mjs --api GET "/api/lan-agent/resources/read?id=docs%2Frabi-agent-interfaces.md" --agent <agentId>
```

通用语法：`--api METHOD /path --agent ID [--body-stdin] [--if-match ETAG] [--idempotency-key KEY]`。选择私有配置中的准确 Agent；CLI 自动读取 `nodeCredential`，不接受旧共享凭据。写入先读现行合同，JSON 通过标准输入传入，按要求提供强 ETag 与稳定幂等键。CLI 前后核对 Manager `/meta`；超时、503、`uncertain` 或写后切代先权威读回，不自动重放，412 重新读取并确认原意。

通用 HTTP 调用支持 `--raw-stdin`（原文）、`--body-file FILE`（二进制流）、重复 `--header 'Name: value'`（合法业务头）、`--output FILE`（二进制／文本下载）、`--stream --output FILE`（有期限流消费）、`--timeout-ms MS` 和 `--no-replay`。正文格式互斥；连接凭据、内部来源证明、Host 和代际头由传输拥有，不能由调用方覆盖。输出采用同目录临时文件与不覆盖提交，切代或失败不提交。流消费不自动重放；无限直播 stdout 和 WebSocket 并非该 HTTP CLI 的传输能力，不能将不支持解释为未授权。模块可显式使用回调消费流。下载技能继续使用原严格 ZIP 校验入口。

传输层将近期记忆详情 GET 视为会更新阅读时间的操作：失败或代际变化时不自动重试，并报告 `uncertain`。模块调用方也可通过 `replaySafe: false` 禁止其他有副作用查询的重试；该选项不能让 POST/PATCH 自动重放。`/meta` 的直接对象与 `data` 包装响应均按同一身份核对。本次变更为源码与隔离测试验证，尚未部署。

鉴权成功且未被用户显式禁用的远端 Agent 默认可使用全部公开 RabiPC 接口。操作目录用于发现，不是功能许可白名单；公共管理设置不因远端来源被额外拒绝。连接器自动处理凭据、当前代身份和代际请求头，Agent 无需手动核对身份或重新绑定。共同的参数、对象、Action Gate、文件根、版本和幂等合同仍适用；Host 私有控制协议不是公开 Manager 接口。资源只允许公开文档、技能及其同包直接引用的受控文本，不开放任意文件系统。按需读取 Manager 当前发布的最新技能与合同，不复制计划、记忆或消息处理状态为第二份业务真源。

管理端启停沿用兼容的 `authorization` 接口和 `enabledAgentIds` 状态投影，不是另一个 API 权限开关。并发版本、幂等与异常回读合同见 [接入文档的 API](../../docs/lan-rabi-agent-bootstrap.md#api)。

跨 Agent 投递时，远端主会话来源按实例命名空间记录。目前只支持 `responsePolicy: "none"` 的单向投递；因缺少可信回传路由，`responsePolicy: "required"`、`inReplyToRequestId` 正式回复及远端到远端投递均明确拒绝，不能视为完整支持正式回复。远端上下文只走自身专用 `context` 入口，不开放通用 `codex-hook` 接口。

远端渠道外发仍遵守 Route 发送权限：`onlyPrimary` 要求可信 `provider`、Route 的 `instanceId`/`nodeId` 与 `agentId`、已批准的会话及 `primary_persona` 身份全部匹配；仅裸会话 ID 同名不会继承本机权限。

## 上传远端文件，再发送到 QQ 群

> 实验合同：上传已通过本机真实 HTTP 与模拟 NapCat 集成、完整构建及部署健康核验；未向真实群发送测试文件，真实双机群文件仍待验收。

前提是独立节点凭据、总控批准的 primary Agent，以及允许发送 `file` 的准确 NapCat Route。上传和发送是两步，上传成功不会自动发群文件。在已校验的发布目录运行：

```bash
node rabi-agent.mjs --upload <file> --agent <agentId> --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent <agentId>
node rabi-agent.mjs --api POST /api/agent/send --agent <agentId> --body-stdin
```

`--upload-id` 必须是预先保存的稳定 UUID，不自动生成。第三条命令从标准输入接收如下 JSON；将身份与目标换成当前模板的准确值，`fileId` 换成上传回执 `data.id`，并为发送保存独立、稳定的 `deliveryId`：

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<approved-complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "<upload-data.id>", "fileSha256": "<upload-data.sha256>" }
}
```

上传使用 `PUT /api/agent/uploads/<UUID>` 和原始二进制正文；`Idempotency-Key` 同 UUID，文件名为 URI 编码的 basename，内容附 SHA-256。`GET` 同路径返回 `{code:0,data:{id,fileName,size,sha256,expiresAt}}`，`expiresAt` 为 ISO 时间，不暴露 Manager `path`。默认单文件 2 GiB（2048 MiB，硬上限）、总量 4 GiB、最多 100 个、TTL 24 小时；HTTP 上传跨 owner 总并发上限为 4。超时、503、切代或结果不确定时先核对当前 Manager，再 GET 原 ID；保留原键和文件，不自动重试或换 ID。

大文件上传使用有背压的流式传输和增量 SHA-256，期限 30 分钟。Manager 的「RabiLink → 配置」可保存 `agentUploads.maxFileMiB`（整数 `1..2048`，默认 `2048`），写入 `data/Config.json`，重启 Manager 后生效；`PATCH /api/rabi/identity` 复用已鉴权连接，远端 Agent 同样可按强 ETag、幂等及参数合同修改；未设置额外功能白名单。客户端硬上限为 2 GiB，服务器配置更小时会拒绝超限文件。

734 MiB（769654784 字节）文件已通过真实客户端 → loopback Manager → 文件存储 → 模拟 NapCat 的 size/SHA-256 集成测试，使用小块生成与读取并禁止大于 8 MiB 的 Buffer 分配/拼接。用 `RABI_TEST_LARGE_UPLOAD=1` 显式运行大文件用例；默认跳过且测试结束清理临时文件。真实 QQ 平台的大小/群权限限制尚未验收。已有旧连接器必须先按上文新版 bootstrap 迁移，缓存旧 Hook 的宿主重载后再试；服务端改限额不等于远端代码已升级。

使用 `fileId` 必须同时填写 `fileSha256=上传 data.sha256`（64 位小写十六进制），避免 24 小时到期后 UUID 复用使旧引用换成其它内容；发送 callback 在 lease 内核对实际 hash，不匹配拒发。

文件归属 `nodeId + agentId`，同 Agent 多 session 可共享，但仍须可信、已批准的 source。`fileId` 仅限 NapCat 群文件，与 `path`/`url`/`fileName` 互斥；不能用于图片、语音或其它渠道。显示名取上传元数据；`payload.text` 可选，`replyToMessageId` 须为空字符串或具体来源消息 ID。Manager 每请求通过内部可信 resolver 校验授权、归属、完整性和 TTL，并以 inflight lease 保护在途文件；不扩大 `allowedFileRoots`，原本地 path 流程照旧。`onlyPrimary` 仍核精确 Route 的远端绑定与获批会话。

必须取得 Manager 和渠道发送回执；群文件上传与 caption／整次终态分别确认。caption 缺失不能把整次请求标成成功，不能自动补文字、重发文件或换 deliveryId；先用原请求只读核验，再按用户具体授权处理。异机 NapCat 仍需要能够读取 Manager 文件路径的共享目录，不代表支持任意跨机 NapCat。完整请求头、安全与回读合同见 [Agent 接口](../../docs/rabi-agent-interfaces.md#远端-agent-上传后发送群文件实验合同)。上文正式回复 `none` 限制不变。

## 旧安装与运行边界

- 旧配置缺少 `nodeCredential` 时必须以新票据重新接入，不能迁移 `lanLinkToken` 为节点凭据；保留原实例、Agent、任务与允许的工作目录。已有独立凭据的重连不重复兑换。
- 新源码在 HTTP/WS 监听前检测旧 `lan-agent-tasks.json`：没有完成标记时，即使注册表为空也轮换 WebGUI Token，成功后写标记，失败中止启动。旧远程浏览器链接失效后须在本机取得新链接。检测范围外曾暴露的密钥也须确认撤销或轮换；未轮换的共享密钥仍可能绕过节点授权。整体部署与 Host 健康不等于旧节点迁移验收，仍须逐节点核对重新接入和旧密钥失效，不能宣称所有现有安装已自动安全迁移。
- 接入时固定发布公钥 SHA-256 指纹；内容摘要自动更新核对该指纹、Ed25519 与逐文件 hash。IPC 准备、排空、交接、指针提交及失败恢复使用[统一接入合同](../../docs/lan-rabi-agent-bootstrap.md)。
- 不包含 Manager、Gateway、WebGUI、配对码或设备密码；使用标准 DNS-SD 动态定位原 Manager，不扫描端口。不启动备用 Runtime；Codex owner 或 DSH 绑定不可用时失败，不互相回退。
- 电脑作为实例，每个实例可增加多个 Agent；不再从旧单任务配置自动生成 `default` Agent。已有目录身份保留，投递必须明确指定类型和完整会话 ID；执行配置保存在该电脑，Manager 统一管理。
- 节点在线、任务已入队或本机夹具通过都不等于真实回复完成。跨机连续投递、登录启动、断网与升级恢复，以及高级计划/记忆工作流仍需实机验收。
