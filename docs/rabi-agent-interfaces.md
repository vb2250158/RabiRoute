<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-agent-interfaces_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent 需要关注的 Rabi 接口

## 本轮新增可执行接口

设备配置的六项操作见 [设备 Agent 配置接口](aiui-agent-profile-http.md#可执行合同与自动发现)；它们只保存配置和设备回执，不执行 Agent。其它独立模块也从所属拥有者注册：

- `manager.agent-state.report`：合并原 gateway/adapter 的状态；200 表示已合并，202 `ignored` 表示重复或旧序列。原配置持久化失败可能发生在状态修改后，`uncertain=true` 时先读取原 gateway 的 `agentStates`，不把 202 当成持久化证明。
- `manager.performance.*`：配置读取/保存、样本提交、汇总、日志、状态和原生 SSE 共七项；详见 [性能监控](performance-monitoring.md)。样本的 202 只证明内存接收，SSE 没有断线重放。
- `manager.agent.marvis.open`：复用原主机启动器；200 只表示尝试打开，不证明程序启动、登录或消息投递。没有幂等回执，结果不确定时先查看主机。

- `manager.bilibili-history.*`：八项业务入口与通用 OPTIONS，使用原浏览器生产者身份与人格私有日期分卷，详见 [历史桥合同](bilibili-history-bridge.md)。Manager 不直接读取真实网站账号。
- `manager.agent.copilot.install/login/status` 与 `manager.agent.astrbot.login-test`：复用原安装、设备码登录、状态和 Dashboard 验证拥有者。安装/登录不自动重试；设备码返回后仍由原服务拥有进程，退出等待真实 close。
- YeYu 五项公开计划接口见 [集成说明](../plugins/builtin/io.rabiroute.manager.yeyu-gamer/1.0.0/README.md)。提交固定为计划，带原状态版本与幂等键；接收回执不表示游戏已执行。
- 手机状态与能力七项见 [手机拥有者接口](rabilink-mobile-owner-api.md)，保留来源 PC、设备归属与原幂等回执；不代表启动设备 Agent。
- `manager.napcat.*` 十项使用原 NapCat 健康、登录、配置与进程拥有者，成功响应的含义按各操作原合同判断；无本地幂等回执，不自动重放不确定动作。
- Route、实例身份与 Manager 配置十四项见 [Route 控制合同](route-control-api-contract.md)，继续使用原强 ETag、幂等键及运行时持久化边界。
- 设备 Agent 十三项见 [设备执行合同](device-agent-api-contracts.md)，保留原加载会话、claim、唤醒 nonce、prepared ledger 与回执；排队不表示模型已接收。
- 网关十五项见 [网关控制合同](gateway-control-api-contract.md)。配置持久化、运行时激活、手动触发和消息重放分别按原拥有者结果判断。
- 适配器扫描与桌面设置分别见 [扫描插件](../plugins/builtin/io.rabiroute.manager.message-adapter-control/1.0.0/README.md)、[桌面插件](../plugins/builtin/io.rabiroute.manager.desktop/1.0.0/README.md)；扫描超时不证明离线，打开配置返回不证明窗口已显示。
- 会话两项、消息处理七项、桌宠十二项的源码合同见 [会话](agent-thread-api-contracts.md)、[消息处理](message-processing-api-contract.md)、[桌宠](../plugins/builtin/io.rabiroute.manager.desktop-pet/1.0.0/README.md)；各自的完整构建与运行验收进度见实施记录。

- 语音 39 项、家居 53 项与视频 35 项从所属插件注册，保留原拥有者及旧发现 ID 别名。视频动态模型代理由通用客户端显式传入原生 HTTP 方法（`options.method` 或 CLI `--operation <ID> --method PROPFIND`）；按方法搜索目录可匹配 wildcard，CONNECT/TRACE 等仍遵守原生传输限制，详见[目标架构](api-contract-discovery-target-architecture.md)。
- 人格资源、历史、计划控制和 Skill 合同分别见[资源](persona-resource-api-contracts.md)、[历史](persona-history-api-contracts.md)、[计划控制](persona-plan-api-contracts.md)及 [Skill](persona-skill-api-contracts.md)；[知识](persona-knowledge-api-contracts.md)、[身份](persona-identity-api-contracts.md)和[健康](persona-health-api-contracts.md)保留原索引、记录和生命周期围栏。存储双路径共 58 项继续使用原 CAS、稳定幂等键与反馈队列，编译版验收状态以实施记录为准。

- [核心公共服务](core-public-api-operations.md)九项和[插件目录](plugin-catalog-api-contract.md)五项复用 core 插件的可执行注册；[角色配置](role-configuration-api-contracts.md)保留八项原生生命周期操作，原 revision、操作回执与 Host 私有边界分别核对。

这些目录项是发现与调用合同，不是逐功能授权。安装版、真实外部业务和双机效果的证据须单独核对，见 [实施记录](api-contract-discovery-implementation-progress.md)。


远端连接器 0.2.6：电脑凭据认证整台实例，“是否启用Agent”控制整个实例，默认启用。启用后可直接使用主机全部公开接口，包括改名、计划、记忆、Skill、文件与任务；不要求浏览器登录、主控 Agent、会话登记、绑定或逐功能授权。每次 Agent 调用明确传入实际类型与完整会话 Id；目录和会话列表用于查询，不授予权限。

## 本机自动发现地址

Agent 无需填写 Manager 地址。在源码目录运行 `node scripts/resolve-manager.mjs`，返回 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`；PowerShell 可用 `$rabi = node scripts/resolve-manager.mjs | ConvertFrom-Json` 保存本轮连接信息。

Windows Host 在启动成功和生命周期变化时原子生成状态目录中的 `manager-endpoint.json`（默认 `%LOCALAPPDATA%\Programs\RabiRoute\manager-endpoint.json`）。缓存只包含公开连接身份，不含凭据；停止、恢复或切代时清除旧地址或发布新身份。缓存文件路径可通过 `RABIROUTE_MANAGER_ENDPOINT_FILE` 指定。默认无需配置环境变量，已运行的 Agent 每次重新解析即可读取新代次，不依赖进程启动时继承的旧地址。

解析器先读取缓存并请求 `/meta` 核对完整身份和业务就绪；缓存缺失或过期时只向 Host 查询一次，等待进程退出并捕获完整 stdout，再验证 `/meta`。旧版安装尚不生成缓存时同样可用。PowerShell 直接 `& RabiRouteHost.exe --command status --json` 可能因 GUI 程序未被等待而得到空输出，空输出不能解释为 Host 离线。显式 `RABIROUTE_MANAGER_URL` / `GATEWAY_MANAGER_URL` 仍作为覆盖配置，并验证在线身份。远端 Agent 继续使用已接入的通用传输，不读取本机缓存。

解析结果只用于当前请求批次；写入后的身份复核、幂等与不确定结果处理继续遵守下文合同。Host 缓存改动须随 Host 版本发布，Manager 源码热补丁无法替换运行中的 .NET Host。

完成连接鉴权后即可使用已提供的接口，不再增加逐功能或逐角色授权。发送仍须遵守来源身份、目标、消息格式和幂等回执合同。详见[连接与接口使用](connection-access.md)。

本机 Agent、已鉴权 RabiLink 和已启用远端 Agent 共用配置接口权限。`POST/DELETE /api/agent-adapters/dsh/connection` 接受可信本机 Agent 不带浏览器 `Origin` 的请求；浏览器跨站请求、伪造连接标记和已撤销连接仍被拒绝。配置版本、参数和写后回读要求保持有效。

连接器发布清单 `GET /api/lan-agent/releases/manifest` 和文件 `GET /api/lan-agent/releases/<version>/node/<assetPath>` 同样接受当前已鉴权的本机、RabiLink 和已启用远端 Agent 连接，无需另取节点凭据。首次安装票据及既有节点凭据的下载通道继续有效；未认证请求、已停用 Agent 和已撤销连接不能借该通道绕过原身份检查。

家庭设备、音箱播报和媒体控制使用[家庭设备 Agent 接口](home-device-agent-api.md)：先发现资源与参数，再提交带状态版本、生命周期围栏和幂等键的动作，通过原键只读查询回执。服务受理不表示声音已播放。

角色的电脑/手机时间轴查询、来源选择与采集控制见[角色全天记录接口](persona-all-day-recording.md#manager-公开接口)。读取事件不代表已经开启采集，空列表不证明全天没有活动。

> 状态：现行 Agent 接口指南。远端 Agent 设备链路仍为实验能力；其它接口按当前 Manager API 和测试核对。

本文说明 Agent 在处理 RabiRoute 消息时需要关注的 Rabi 内置接口。它不是普通用户操作手册，而是给 Agent 注入上下文后使用的接口说明。

这些接口用于让 Agent 主动维护计划和记忆，并把普通回复交回 RabiRoute。RabiRoute 负责存储、权限边界、符合角色配置条件的计划延迟归档、到点或显式发起的记忆整理请求、上下文注入和回复回传；Agent 需要关注的是：什么时候新增或更新计划、什么时候记录近期记忆、收到记忆整理请求时如何返回沉淀记忆，以及需要普通聊天回复时把内容交给回传接口。

### Agent 转投的模型设置

`POST /api/agent/threads` 的 `action=send` 优先使用调用方明确指定的 `model`；未指定时使用目标任务唯一所属 Route 的 `agentModel`，仍未配置则省略模型字段，沿用对应 Desktop Agent 的默认设置。不要因读取不到任务模型名而停止转投，也不要读取当前编码 Agent 的配置替代目标配置。主角色需要另选模型时，在原任务投递请求中传入 `model`，可同时指定 `reasoningEffort`；保留原 `taskBinding`。该设置用于新轮次，活跃轮次继续 `steer`。回执不确定时先核对原投递，不自动改投或重发。


## 计划与记忆写入合同

`focused` 消息包只给出本节入口。涉及计划、近期记忆、反馈或整理结果的写入前，必须先读本节及目标接口章节；文档不可读时停止该操作。写入复用连接鉴权，并遵守当前任务授权与投递合同。计划状态先读取当前角色的 `plan-statuses`，不猜 key；附件通过计划 `attachments` 提交。

1. 从 Host 状态（安装版）、结构化 READY（源码版）或测试显式注入取得当前完整 Manager URL。每次请求采用对应操作的当前有界超时设置；读取、长操作和上传使用各自的预算。写入前 GET `/meta`，核对非空 `applicationGenerationId`、`managerInstanceId` 与当前 Host/READY 身份；普通业务请求要求 `health.live=true`，且 `health.state` 为 `healthy` 或 `degraded`。`health.requiredReady=false`、`businessReady=false` 或无关 Route 降级不阻断全部请求，计划恢复、目标路线等依赖由 Manager 对应接口判断。
2. 每项逻辑写入先生成并保存稳定 `Idempotency-Key` 与完整请求体。PATCH 计划/近期记忆、POST 计划反馈或回传记忆整理结果前，先 GET 对应单项资源或 feedback，把返回的强 ETag 原样放入 `If-Match`。禁止使用弱 ETag、`*` 或 `updatedAt` 替代版本。新增计划、新增近期记忆和发起整理带幂等键，不带 `If-Match`。
3. 超时、HTTP 503 或结果不确定时，保留原请求和原键，先权威读回；重试只能使用相同请求体和相同键，不创建第二项操作。HTTP 412 明确表示旧前置版本未提交：废弃旧键和旧 `If-Match`，重新 GET；原意仍适用时保存新键，以新强 ETag 提交。
4. 成功响应必须回显完全相同的 `Idempotency-Key`、返回强 ETag，且 body 的资源身份必须与目标一致。任一条件不满足时不得宣布成功。
5. 响应后再次有界 GET `/meta`，只复核两项身份是否与写前一致，不把无关健康变化当作切代；身份缺失、请求失败或身份变化均视为结果不确定，重新发现当前地址，保留原请求和键做权威读回，不自动重放。身份一致不消除原写请求超时、5xx 等已经存在的不确定性。通过资源读回核对实际结果。

精确 `GET /meta` 是诊断入口：取得有效响应并核对当前身份后即可返回健康详情，不要求 `live`、`requiredReady` 或业务就绪；地址约束、鉴权、超时、禁止重定向和身份校验仍保留。此豁免不能推广到其它 GET，一些读取会更新 `viewedAt`。本节降级访问与写后身份分离合同须由新版客户端实现；仍要求整体 `healthy` 的旧版插件需要升级，本文更新不代表运行中的插件已完成安装或验收。

命令行发现脚本在 Host 启动或切换时，会在有限总时限内重新读取状态；端点暂未发布表示服务过渡，不表示 Agent 缺少权限。取得完整端点后不再把 Host 的汇总状态当作第二层许可，普通请求仍按上述 `/meta` 合同判断可用性。超时应保留最后的启动、连接或身份不一致原因。Windows `healthy` 与 `degraded` 均可提供端点，读取 GUI Host 输出须等待进程并捕获标准输出。连接同一实例的合法地址别名以 generation 和实例身份核验，不以 URL 字符串相等代替身份校验；切换后重新发现，不复用旧端口或自动重放写入。

跨角色投递另读“查询其它角色并投递消息”，保留 deliveryId、来源能力、目标 Route 和跳数合同；远端任务另读“远端 Agent 设备接口”。按需加载说明不会放宽这些要求。

## Manager 事件流（源码已接入，安装版待验收）

`GET /api/events` 现在从同一可执行注册快照发现，transport 为 `sse`。先发送重连间隔与 `ready`，之后是带 JSON data 的事件和协议心跳。断线后重新核对 Manager 身份并刷新当前资源/目录；该流没有持久回放游标，漏收事件不能作为补发业务请求的依据。

流式分发按帧校验并尊重背压。所有已接入调用方共用资源上限：最多 128 个订阅，每个订阅最多缓存 64 帧/4 MiB；超过队列上限会关闭该连接以便重连刷新，订阅已满返回 429 `MANAGER_EVENT_CAPACITY`。这些限额不构成功能许可。客户端断开、插件卸载或源停止后，清理完成才释放在途租约。现有浏览器 EventSource 的查询鉴权继续由入口处理，鉴权参数不进入业务 Schema、目录或 ETag；远端 Agent 仍使用其原连接凭据。

## WebGUI 接入设置的可执行合同（源码已接入，安装版待验收）

`GET /api/webgui-access`、`PATCH /api/webgui-access` 和兼容的 `POST /api/webgui-access` 分别由 `manager.webgui-access.read`、`manager.webgui-access.update`、`manager.webgui-access.update-post` 发现。它们复用原全局配置拥有者；已鉴权连接无需额外人格或 Agent 注册许可。读取可能按原管理身份返回连接凭据和链接，响应为 `private, no-store`，目录不包含凭据值。

写入保留原解析语义：空正文按 `{}` 处理；保留原 Content-Type 不参与解码选择的行为，正文仍按 UTF-8 JSON 解析。只有布尔 `enabled` 改变开关，只有 `regenerateToken: true` 触发显式轮换，其他非 null 的 JSON 值和未知字段继续忽略；`null` 或无效 JSON 返回 400。正文最多 64 KiB。共享合同用 `emptyValue` 和 `allowAnyContentType` 描述此解码方式，OpenAPI 同步标明正文可省略。轮换后的不确定请求先读取设置，不能自动重放；`restartRequired` 仍表达原 Host/监听器状态，本接口不重启 Manager。通过既有鉴权和运行模式检查后，已注册路径的不支持方法返回 405 和 `Allow`，不调用配置拥有者。

## 资源缓存与录音归档的可执行合同（源码已接入，安装版待验收）

同一注册表发布以下 13 个 operation；ID 前缀为 `manager.resources.`。目录、请求校验与实际分发使用同一合同，字段及限额与原存储拥有者共享。

| operation 后缀 | 方法与路径 |
| --- | --- |
| `settings.read` / `settings.update` | GET / PUT `/api/resource-cache/settings` |
| `archive-settings.read` / `archive-settings.update` | GET / PUT `/api/resource-cache/archive-settings` |
| `object.read` / `object.write` | GET / PUT `/api/resource-cache/data/objects/:objectHash` |
| `archive.capabilities` | GET `/api/resource-cache/data/archive-capabilities` |
| `archive.recordings.list` | GET `/api/resource-cache/data/recordings` |
| `archive.processing.read` | GET `/api/resource-cache/data/recordings/:recordId/processing` |
| `archive.manifest.read` | GET `/api/resource-cache/data/recordings/:recordId/manifest` |
| `archive.manifest.commit` | PUT `/api/resource-cache/data/recordings/:recordId/manifests/:manifestHash` |
| `archive.receipt.read` | GET `/api/resource-cache/data/recordings/:recordId/receipts/:manifestHash` |
| `recording-events.write` | PUT `/api/resource-cache/data/recording-events` |

已鉴权公开连接复用统一管理入口，无需另取 resources key、绑定人格或预注册 Agent。对象、归档及移动记录接口的 `x-rabilink-resource-owner` 选择现有数据归属，属于业务目标头，不代替连接身份。原设备 resources 传输继续校验其已有身份与凭据；仅带内部转发头不能获得公开管理身份。

归档设置 PUT 要求先 GET 取得强 ETag，再以原样 `If-Match` 和稳定 `Idempotency-Key` 提交。通用连接器从已验证 `/meta` 自动填写 generation/instance 头，调用方不能覆盖。结果不确定时保留原请求与键，先读回设置及原操作结果。

对象 PUT/GET 传输实际字节，上限 1 MiB；模块使用 `bodyBytes`、`responseMode: "bytes"` 和响应 `bodyBytes`，CLI 使用 `--body-file` / `--output`。保留对象及旧 JSON 接口不依赖 Content-Type 选择解码的行为；归档设置 PUT 仍要求 `application/json`，正文上限 8192 字节。目录通过合同说明这些差异。

共享对象路径优先使用现有归档绑定。只有未绑定的对象目标才进入旧缓存；绑定禁用、NAS 缺失、命名空间错误或提交结果不确定均返回原结果，不切换存储目标。归档 manifest 与精确 receipt 用于确认归档提交；旧对象或移动事件的 `durable: true` 仅确认旧拥有者持久化，不能据此删除手机原始录音。设备与实际 NAS 验收见[手机录音归档](mobile-recording-archive.md)。

## 远端 Agent 资料与发布文件合同（源码已接入，安装版待验收）

以下四个读取 operation 共用原资料目录与签名发布拥有者：

| operation ID | GET 路径 |
| --- | --- |
| `manager.lan-agent.resources.list` | `/api/lan-agent/resources` |
| `manager.lan-agent.resources.read` | `/api/lan-agent/resources/read?id=<目录返回的ID>` |
| `manager.lan-agent.releases.manifest` | `/api/lan-agent/releases/manifest` |
| `manager.lan-agent.releases.asset` | `/api/lan-agent/releases/:version/:platform/:assetPath` |

已鉴权 RabiLink 与已启用远端节点使用原连接，不需要登记 Agent 会话或绑定人格。首次安装票据保留原发布下载通道，只凭该票据不能读取管理资料。异步资料读取完成后复验原连接；客户端断开后，注册器仍等待实际读取拥有者完成再释放租约。

`request.pathTails: ["assetPath"]` 声明最后一个参数捕获一个或多个路径段，路径模板仍用 `:assetPath`。例如 `assetPath: "lib/manager-client.mjs"` 保留目录分隔，每段分别 URL 编码。Manager、通用连接器和 OpenAPI 使用同一解析模块；OpenAPI 展示 `{assetPath}` 并以 `x-rabiroute-path-tails` 声明该行为。空段、点段、反斜杠和控制字符被拒绝，参数只解码一次。其它单段参数的原编码方式保持有效。旧通用连接器将整段值编码、包含 `%2F` 的调用也可执行，无需逐接口升级。

发布文件返回原始字节，包括 JSON 文件的空白与格式；不转换为 Buffer 元数据或重新序列化 JSON。读取使用现有版本、平台、文件成员和目录约束。安装前仍通过原下载流程核对固定公钥摘要、manifest 签名与文件 hash；发现和下载成功不表示已安装。资料目录继续只提供已发布文档、Skill 入口及同包引用。旧 `resources/read` 查询保留只取第一个 `id`、忽略其它字段的语义。

## 直连视频信令合同（源码已接入，安装版待验收）

`manager.rabilink.video.status` 读取 `/api/rabilink/video/status`；`manager.rabilink.video.offer` 通过 POST `/api/rabilink/video/offer` 协商原 WebRTC 接收器。已鉴权远端直接复用连接，无需 Agent 预登记或新许可。HTTP 只接收有界 SDP 与 deviceId，媒体继续直达原接收器，不上传 Relay。协商成功、录像结束与眼镜真机采集分别核验；断线后不自动重放 offer。详见[手机与电脑视频直连](rabilink-direct-video.md#manager-公共合同源码已接入安装版待验收)。

## 角色面板消息合同（源码已接入，安装版待验收）

| operation ID | 方法与路径 |
| --- | --- |
| `manager.role-panel.messages.list` | GET `/api/roles/:roleId/role-panel/messages` |
| `manager.role-panel.messages.send` | POST `/api/role-panel/messages` |

已鉴权远端复用当前连接，无需 Agent 会话预登记或人格许可。GET 保留旧发现 ID `persona:GET:/api/roles/:roleId/role-panel/messages`，别名解析到同一合同。读取使用首个 `limit` 的 Number 转换，非有限正数回到默认 120；历史非有限时间值按原 JSON 语义输出 null。断线会取消未完成的读取并等待原拥有者清理。

POST 沿用原本机人格投递拥有者：`gatewayId` 省略时选择原运行表首项，提供时使用原清理规则；目标必须属于原本机人格对象。`text` 保留 `String(text || "").trim()` 转换，附件由原归一化器处理，至少需要文本或一个有效附件。JSON 不依赖 Content-Type，`maxBytes: 0` 保留原入口无应用层字节上限的行为。运行中配置变化后，审计仍使用本次受理时捕获的路线身份和存储拥有者。

202 的 `status=delivered` 表示原投递已接受；Agent 的业务任务通过原任务状态核验。`timelineRecorded=false` 表示审计写入失败，不补发消息。投递异常返回 502，并保留 `messageId`、`replyContext`、`uncertain=true` 和 `commitState=uncertain`；执行前验证失败返回 400、`commitState=not_started`。接口没有请求级幂等，每次新请求生成新消息 ID。超时、失败、缺少记录或审计失败后，应核对原 ID 和原任务，不自动重发。

原投递子进程执行预算默认 45 秒，可通过统一超时设置调整。终止请求后仍等待该进程实际关闭、标准输出/错误与已接受日志回调完成；HTTP 断线也保留已接受投递和审计的收尾租约。返回结果前复验原连接，撤销连接会停止披露。

## 远端终端与电脑操作合同（源码已接入，安装版待验收）

五个 operation 复用现有目标电脑连接与执行器；已鉴权调用方无需 Agent 会话登记或人格绑定。目标电脑广告的 shell、文件、窗口或截图能力表示实际实现情况，不是第二层许可。终端列表与控制选择远端电脑；本机终端仍由本机宿主管理。

| operation ID | 方法与路径 |
| --- | --- |
| `manager.lan-agent.terminals.list` | GET `/api/lan-agent/instances/:instanceId/terminals` |
| `manager.lan-agent.terminals.execute` | POST 同一路径 |
| `manager.lan-agent.terminals.read` | GET `/api/lan-agent/instances/:instanceId/terminals/:terminalId` |
| `manager.lan-agent.terminals.events` | GET `/api/lan-agent/instances/:instanceId/terminals/:terminalId/events`，SSE |
| `manager.lan-agent.computer.execute` | POST `/api/lan-agent/instances/:instanceId/computer` |

终端 POST 的 `action` 为 `open/list/get/input/resize/close`。保留 `terminalId`、输入 `sequence` 及原文本；同序号异内容冲突或回执已过期时停止重放。原执行器验证广告 shell、目标电脑绝对目录、UTF-8 输入字节数、尺寸和容量。电脑 POST 支持 `file.stat/read`、`upload.begin/write/commit/status/abort`、`windows.list` 与 `screen.capture`；窗口与截图要求 Windows。文件版本、uploadId、偏移、分片 hash、目标不覆盖及提交后的查询沿用原协议。native desktop 字段保留原转换与跨字段校验，未知正文项继续转交原执行器。正文按 UTF-8 JSON 解码，保留原入口不依赖 Content-Type 的行为。

输出查询 `after` 与 `waitMs` 保留首个查询值的 Number 转换；原回放拥有者验证游标顺序及 0–25000 毫秒等待范围。每个终端共享最多 4 个查看者，回放最多 256 KiB / 2048 条事件；SSE 每个查看者最多排队 512 KiB，协议心跳为 25 秒，退出或断连时立即停止。超出回放范围先发送 `gap`；`exit` 或 `disconnected` 后发送完已排队输出再结束。SSE 使用原 `id` 与 JSON `data` 格式，不把整条输出缓存为一个响应。

断开查看连接、撤销原连接或卸载注册会移除订阅并完成清理，再释放在途租约；这些动作不关闭或重开目标终端。已受理输入或电脑操作继续由原拥有者收尾，即使 HTTP 客户端已经断开；异步结果与流输出前均复验原连接。结果不确定时读取原终端的 `nextInputSequence` 或原上传的 `upload.status`，不换 UUID、序号或目标重发。原始源代码中的布尔 HTTP 包装器已删除；资料与发布读取仍见上一节。

## 节点接入与实例管理合同（源码已接入，安装版待验收）

以下 15 个 operation 复用原 authority、registry 和本机配置拥有者，ID 前缀为 `manager.lan-agent.`；已鉴权远端无需逐功能许可或 Agent 预登记。公共能力目录统一使用版本 2 活动快照，旧版本 1 摘要与 core 的旧前缀分发已删除。

| operation 后缀 | 方法与路径 |
| --- | --- |
| `self.read` | GET `/api/lan-agent/self` |
| `enrollments.create` | POST `/api/lan-agent/enrollments` |
| `enroll.exchange` | POST `/api/lan-agent/enroll` |
| `instances.list` | GET `/api/lan-agent/instances` |
| `instances.enabled` | PUT `/api/lan-agent/instances/:instanceId/enabled` |
| `instances.name` | PUT `/api/lan-agent/instances/:instanceId/name` |
| `agents.create` | POST `/api/lan-agent/instances/:instanceId/agents` |
| `agents.tasks` | POST `/api/lan-agent/instances/:instanceId/agents/:agentId/tasks` |
| `agents.configure` | POST `/api/lan-agent/instances/:instanceId/agents/:agentId/configure` |
| `agents.scan` | POST `/api/lan-agent/instances/:instanceId/agents/:agentId/scan` |
| `agents.threads` | POST `/api/lan-agent/instances/:instanceId/agents/:agentId/threads` |
| `agents.hooks` | POST `/api/lan-agent/instances/:instanceId/agents/:agentId/hooks` |
| `nodes.list` | GET `/api/lan-agent/nodes` |
| `nodes.update` | POST `/api/lan-agent/nodes/:nodeId/update` |
| `nodes.tasks` | POST `/api/lan-agent/nodes/:nodeId/tasks` |

签发票据忽略正文，包括非 JSON 和空正文，合同使用可省略的原始正文声明；票据和换取凭据的响应禁止缓存。换取接口复用既有票据或有效恢复证明；持有当前 nodeId 与 enrollmentSecret 可以恢复相同凭据，不要求新票据。目录只发布这些字段的结构。

改名携带当前 expectedName；开关携带布尔 enabled 与 expectedEnabled，保留原比较写入及重复状态语义。停用自身后原连接无法继续读取响应；通过已有管理连接读回状态，不能把该响应当作停用未生效并重放。历史节点与任务可能缺少后来增加的协议字段，列表保留这些记录和扩展项。

Agent 的 configure/scan/threads/hooks 正文扩展与结果由原 provider 拥有；路径 agentId 覆盖正文同名项，新增远端 Agent 时不转交正文的 agentId。threads 的列表和动作均显式传 agentAdapter；hooks 保留 90 秒拥有者超时，其它远端管理动作保留 30 秒。实例任务显式传 provider、完整 threadId、message 和稳定 idempotencyKey；节点任务用 targetAgent 指定提供方。原拥有者完成接收确认后才返回任务结果，相同目标及正文的重复键复用原任务，不再次派发。

节点更新未指定非空 version 时使用原签名发布清单的当前版本；202 表示更新请求已提交，仍须读回实际更新状态。异步管理向原拥有者传递连接围栏，任务与更新在持久化后、实际发送前再次复验；已接受操作不因客户端断开而重发，卸载等待拥有者完成。安装版、功能原位升级与真实双机运行仍待验收。

## LAN Agent WebSocket 连接合同（源码已接入，安装版待验收）

`manager.lan-agent.connect` 通过 `registerUpgrades()` 绑定 GET `/api/lan-agent/connect`，与实际 upgrade 共用目录、合同摘要和活动快照。普通 HTTP GET 返回 426；真正的 WebSocket 握手保留原生首帧 `authenticate/token`，随后发送原 hello/node 元数据，不要求额外 HTTP 身份、人格绑定或 Agent 会话登记。连接后沿用原命令、终端事件、任务和更新结果协议；能力发现不重放这些动作。

目录声明 `transport: websocket` 和 `websocket` 描述，OpenAPI 用 `x-rabiroute-websocket` 导出，101 无 HTTP 正文。原消息上限为 100 MiB，发送缓冲上限为 200 MiB，首帧鉴权等待 10 秒，关闭宽限为 2 秒。原生状态机继续校验消息种类、字段及对象归属；首帧凭据错误按原协议关闭。节点或全局开关停用后，即使再启用，旧连接也不能恢复执行，须以原电脑身份重新连接并查询原任务状态。

插件绑定在原生库写握手前调用 `prepareHandshake()`，以 `accept({closed, close})` 交出真实 Socket 生命周期，并对原生输入/输出调用 `validateIncoming/validateOutgoing`。退役先 `stopAccepting()`，等待已接受 HTTP 命令及实际结果，再 `dispose()` 关闭所属 Socket；清理承诺完成后才释放租约。空闲连接不占用自动源码发布的业务请求计数。生产中央监听已移除，独立 `attach()` 兼容入口委托统一注册器，不保留第二份路径分发。

当前通用客户端通过 `openOperation(operationId, options)` 使用 WebSocket；它与 HTTP `invokeOperation()` 共用活动目录、别名及路径/查询解析。HTTP 方法继续拒绝 WebSocket，CLI 可通过 `--operation ID --websocket --output FILE [--frames-stdin]` 流式消费显式 JSONL 帧，完整选项见[连接器命令行](../apps/rabi-agent/README.md#websocket-命令行源码已接入安装版待验收)。连接器自身通过 `openOperation("manager.lan-agent.connect", ...)` 连接，再由原状态机发送 authenticate/hello；旧路径拼接已删除。

`options.onMessage(value, {signal})` 必须显式提供；JSON 模式返回解码值，bytes 模式返回 Buffer。可选 `onOpen(channel, {signal})` 由协议拥有者发送原生首帧；`onClose(result)` 负责所属资源收尾。`channel.sendJson(value)` 适用于 JSON；`send(text)` 校验序列化 JSON，bytes 模式的 `send(bytes)` 只接受 Uint8Array。Schema、单消息、发送缓冲及接收队列上限来自目录合同；消费串行并施加背压。调用 `close()` 请求关闭，在回调之外等待 `closed`，直到已开始的回调真正完成。取消通过 signal 通知拥有者清理；传输不自动重连或重放，错误不回显凭据。

`sendAsync(data)` 与 `sendJsonAsync(value)` 等待已接受的原生写回调，可对连续输入施加背压；回调完成不表示业务接收或执行完成。`closed` 也等待这些写回调。数据捕获可显式设置 `drainOnRemoteClose: true`：正常远端 1000 关闭后排空已校验帧，再通知 `onClose`；取消、异常关闭或消费失败停止排空。该选项默认关闭，原连接器的命令消费者保留断连即停。CLI 文件捕获启用它，避免把缺少尾帧的文件确认为成功。

CLI 的 `--frames-stdin` 接受逐行 `{"type":"json","data":...}`、`{"type":"text","data":"..."}`、`{"type":"binary","data":"<标准Base64>"}` 或 `{"type":"close","code":1000,"reason":"done"}`；目标 Schema 和原协议决定适用的帧及鉴权首帧，CLI 不代造登录或任务。输出使用 json/text/binary 同形 JSONL，binary 的 data 为 Base64。stdin EOF 仅停止发送，省略 `--frames-stdin` 只接收。`--timeout-ms` 是默认 30 秒的总期限；`--ws-max-output-bytes` 是默认 256 MiB 的本机文件预算；透明消费者可用 `--ws-max-message-bytes`、`--ws-max-buffered-bytes` 调整本机容量，以 `--ws-protocols '["protocol.v1"]'` 选择子协议。

CLI 正常关闭且原 generation/instance 复核成功后不覆盖提交输出；取消、超时、容量或写入错误不提交。stdout 只输出文件摘要和传输回执；`businessOutcome: "not-evaluated"` 表示业务仍须读原协议回执，`inputComplete` 表示输入是否消费完，发送回调不等于业务确认。JSON/文本中的本连接凭据会脱敏，二进制反射该凭据时失败。HTTP 正文、`--upload`、`--stream` 不与 WebSocket 帧模式混用。

握手前后核对同一 Manager 身份；握手后仅健康波动不会误判切代。合同冲突使缓存失效且不重试连接。未知 Schema、缺少消费者或旧 Manager 缺少连接合同时报告兼容性错误，保留原节点及任务，不猜旧 URL。其它公共入口、运行中旧 Manager 的闭包/监听迁移、功能原位升级、安装版和真实双机验收仍未完成。

## Peer 连接控制合同（源码已接入，安装版待验收）

以下入口通过 `registerOperations()` 使用原连接拥有者，返回原 JSON 正文；`events` 使用同一注册器的 SSE 生命周期。

| operation ID | 方法与路径 | 作用 |
| --- | --- | --- |
| `manager.rabilink.peer.servers.read` | GET `/api/rabilink/peer/servers` | 读取设备目录、选择和连接/RTT 状态 |
| `manager.rabilink.peer.selection.read` | GET `/api/rabilink/peer/selection` | 读取保存的目标 |
| `manager.rabilink.peer.identity.read` | GET `/api/rabilink/peer/identity` | 读取本机设备 ID、generation 和公钥，不含私钥 |
| `manager.rabilink.peer.probe` | POST `/api/rabilink/peer/probe` | 正文 `{deviceIds: [...]}`，最多探测十个设备 |
| `manager.rabilink.peer.selection.update` | PUT `/api/rabilink/peer/selection` | 正文 `{deviceId: "..."}`；空字符串显式清除选择 |
| `manager.rabilink.peer.events` | GET `/api/rabilink/peer/events?ids=...` | `ids` 为 JSON 数组，最多十项；重复参数取第一个值 |

两种写请求保留 8 KiB JSON 正文限额和原有未知扩展字段容忍；不要求 JSON 媒体类型。选择保存前、异步结果返回前复验原连接。探测和信任初始化仍归原连接池，不能把请求取消解释为撤销所有共享连接。只读模式继续阻止探测和选择修改，已鉴权 Agent 无需人格或 Agent 预登记。

事件流保留 `: connected`、指定设备的 `status`、所有选择变化的 `selection` 和 15 秒 `: keepalive`。心跳只测量已有通道 RTT，不轮询设备目录或业务。单帧和排队事件均受 64 KiB 限额约束；慢消费者溢出时关闭。取消、卸载或原连接撤销解除监听与定时器，并等待已接受的 RTT 回调结束再释放租约。流无持久回放游标，重连后重新读取目录与选择，不重放业务写入。

## Peer HTTP 透明代理合同（源码已接入，安装版待验收）

普通 HTTP 与 WebSocket 使用同一 URL，HTTP 通过 `registerHttpProxies()` 接入原生拥有者。通用客户端按目录调用以下 operation：

| 方法 | operation ID |
| --- | --- |
| GET | `manager.rabilink.peer.http.get` |
| HEAD | `manager.rabilink.peer.http.head` |
| OPTIONS | `manager.rabilink.peer.http.options` |
| POST | `manager.rabilink.peer.http.post` |
| PUT | `manager.rabilink.peer.http.put` |
| PATCH | `manager.rabilink.peer.http.patch` |
| DELETE | `manager.rabilink.peer.http.delete` |

路径为 `/api/rabilink/peer/http/:deviceId/:service/:path`。`pathRemainder: "path"` 保留原始 URI 后缀，空字符串访问服务根。目标接口负责自己的 Schema、对象归属、限额和回执。代理的 `request.body.kind: passthrough`、`responses.default.passthrough: true` 明确正文不经 JSON 解析、重新序列化或整包缓冲；OpenAPI 使用 `*/*` 与 `x-rabiroute-http-proxy` 公布传输事实。

`httpProxy.wire` 复用原生 12,000 字节数据块、65,536 字节流窗口和每会话 16 个流的限制，未声明整条请求或响应的上限。目标状态码、媒体类型和重复公共响应头保留；凭据、私有身份及逐跳头继续沿原规则剥离。目标端重建 HTTP framing，包含 DELETE 正文。

代理版本条件使用 `x-rabiroute-proxy-contract`；目标的 `x-rabiroute-api-contract`、`If-Match`、`Idempotency-Key` 保留原语义。目标 generation/instance 可通过与升级相同的 `x-rabiroute-target-headers` JSON 对象携带。外层版本条件只针对当前 Manager，版本头不授予功能许可。

二进制响应使用显式 `responseMode: "bytes"`；SSE 或长响应使用 `responseMode: "stream"` 与 `onChunk`，也可使用已有文件输出：

~~~js
await client.invokeOperation("manager.rabilink.peer.http.put", {
  path: { deviceId: "peer-target", service: "manager", path: "api/example/object" },
  bodyBytes: bytes,
  responseMode: "bytes",
  headers: {
    "x-rabiroute-api-contract": "<target-contract-digest>",
    "idempotency-key": "<original-request-key>"
  }
});
~~~

取消、卸载和原连接撤销停止后续派发；租约等待目标获取、已接受写入、输入/输出流和重置回调收尾。不重连或重放写入，不关闭其它请求复用的健康会话。只读验收模式保留 423，persona 兼容别名与 manager 使用相同公共路径和方法；已鉴权连接不增加逐功能许可。安装运行和真实双机验收仍待完成。

## Peer 透明升级合同（源码已接入，安装版待验收）

`manager.rabilink.peer.websocket.proxy` 使用 GET `/api/rabilink/peer/http/:deviceId/:service/:path` 的 WebSocket Upgrade。`pathRemainder: "path"` 表示已编码的原始 URI 后缀：`path: ""` 访问服务根 `/`，其它值不二次编码；入口与目标继续执行既有路径校验。普通 HTTP GET 保留独立拥有者；目录同时注册 HTTP 与升级时，OpenAPI 在普通方法下以 `x-rabiroute-upgrades` 导出完整升级合同。

合同声明 `framing: passthrough`，不解码目标应用协议。原生每块数据最多 12000 字节、每流窗口 65536 字节、每连接最多 16 个流；这些是隧道限额，不是应用消息大小。`handshakeMs: 10000` 从原生目标会话取得后开始，连接发现预算独立。通用 `openOperation()` 返回的文本是 string，二进制是 Buffer，并在回调上下文提供 binary。可用 `protocols` 选择原协议子协议。SDK 对透明消息默认使用本机 100 MiB 消息预算和 200 MiB 缓冲预算，可通过 options.maxMessageBytes/maxBufferedBytes 调整；服务端透明管道没有新增对应整条消息上限。

`request.contractHeader` 为 `x-rabiroute-proxy-contract`，由目录客户端设置代理自身摘要；原 `x-rabiroute-api-contract` 仍可表达目标接口摘要。当前 Manager 自动添加的身份预期不转交成目标身份预期；需要目标版本时，在 `x-rabiroute-target-headers` 的 JSON 对象中携带原目标头。既有公共头过滤继续剥离凭据、代理来源与逐跳字段，真实身份证明由目标传输拥有者生成。该对象也可表达下一跳目标头，不要求增加逐业务转发分支。

源 Node/RabiLink 连接、对端公钥、作用域、generation、服务与资源规则继续由原拥有者核验；persona 是 manager 的兼容别名，公开读写和升级接口采用相同合同，不增加路径或方法许可。排队打开、数据和结束帧在实际加密派发前复验原连接；拒绝只取消本请求，不消耗加密序号或破坏共享会话。卸载停止接收并等待 Socket、隧道流、校验管道及已受理写入/重置回调全部结束；不切回本机或重放消息。普通 Peer HTTP 与其它公开入口仍在迁移，安装版、功能原位升级及真实双机验收尚未完成。

## Remote Agent Hub 合同（源码已接入，安装版待验收）

这是既有实验 v3 bridge 的公共 HTTP 入口，operation ID 前缀为 `manager.remote-agent.`。它与 `/api/lan-agent/` 的电脑凭据/显式会话协议分别保持各自拥有者；迁移不启动备用处理 Runtime，也不增加逐功能或人格许可。

| operation 后缀 | 方法与路径 |
| --- | --- |
| `devices.list` | GET `/api/remote-agent/devices` |
| `scan` | POST `/api/remote-agent/scan` |
| `connect` | POST `/api/remote-agent/connect` |
| `disconnect` | POST `/api/remote-agent/disconnect` |
| `tasks.list` | GET `/api/remote-agent/tasks` |
| `tasks.create` | POST `/api/remote-agent/tasks` |
| `task-events.receive` | POST `/api/remote-agent/task-events` |

`devices.list` 与 `scan` 返回当前设备及最近 20 项任务，`tasks.list` 返回最近 100 项；其它 query 保留原忽略行为。scan 忽略正文，包括非 JSON 和空正文；其余写入按原 UTF-8 JSON 与空对象默认值解析，不依赖 Content-Type。原 String/默认值、事件状态与扩展字段的业务解释仍归 Hub，结构合同不根据 TypeScript 标注新增运行时拒绝规则。

connect 继续要求先发现设备，使用原 v3 nonce 与双向 HMAC-SHA256 验证，再把 bridge 密码保存到原本机存储；这是目标 bridge 的既有身份验证。新合同在发送证明、保存密码前复验原调用连接，失败等待新 Socket 关闭。目录不含实际密码，响应禁止缓存。disconnect 保留原目标转换与无目标行为；已关闭 Socket 的收尾纳入 Hub 的卸载等待。

内联文件提供 sha256 时，派发前核对解码字节的实际摘要；错误返回 400，不创建任务或写入 Socket。创建任务保留设备、Gateway、工作目录和线程名的既有默认值，文件只从原数组字段收集，沿用原解码字节限额、路径与摘要规则。返回任务去掉文件内容，实际 Socket 载荷携带原字节。事件必须归属原任务设备；终态重复返回原任务，不重复保存文件或调回业务。源事件的已受理回调由原 Hub 收尾，卸载等待真实结束。

此 Hub 的任务/事件仅保存在内存中，没有持久幂等键；202 表示 Socket 已写入，任务是否完成要读取后续状态。返回 taskId 后保存该 ID；结果不确定时先查看原设备与任务窗口，不能凭空声称已经恢复回执或自动重发。重启可能丢失记录。旧 `agent:GET:/api/remote-agent/devices`、`agent:GET:/api/remote-agent/tasks`、`agent:POST:/api/remote-agent/tasks` ID 通过同一合同 aliases 保持兼容。

## 消息投递：Rabi 可用时统一走 Rabi

此规则覆盖 Rabi 管理的群聊/私聊、附件、跨角色、持久 Agent 任务正文与续投、任务结果、callback / knowledge-callback 和 Outbox。普通界面对用户的答复、只读任务核对及同一任务内临时子 Agent 协作不属于旁路投递。发送仍须有原动作授权。

当前源码的 `GET /api/agent/help` 返回 `schemaVersion: "2"`，从活动可执行注册快照投影 operation。每项 `contract` 包含请求/响应 Schema、副作用、恢复方式和具名业务校验；旧发现 ID 可通过 `contract.aliases` 查询到唯一 canonical operation，不安装第二个路由；`help.contractLevel: declared`、`auditLevel: runtime-schema` 表示已声明并参与运行时结构校验，不代表真实环境已验收。覆盖字段的 `scope: registered-routes`、`globalCoverage: not-proven` 明确限定注册器范围，`complete` 不代表全项目验收。`data.coverage.gaps` 列出仍未迁入合同的旧注册声明；它不包含注册器之外的所有分支，不能据此证明全项目覆盖。旧安装版可能仍返回版本 1 的 baseline/verified 摘要，应按返回版本解释，不能把两种计数拼成同一份目录。当前源码的安装更新和双机验收尚未完成。

版本 2 的 `catalogDigest` 对完整可执行合同及已知覆盖缺口作规范化 JSON 的 SHA-256 摘要（`sha256:` 前缀）；筛选和分页不改变目录摘要。`catalogRevision` 与 application/Manager/plugin 身份共同标识快照，`ETag` 标识具体查询表示，支持 `If-None-Match`。摘要与 ETag 不代替鉴权、业务条件或 `/meta` 身份核验。

发送能力提供 `data.requestContract`（`version: 2`、`kind: runtime-json-schema`）：`schema` 是发送 operation 实际执行的 JSON Schema，`validators` 明确列出服务端继续执行的文本归一化、目标组合、媒体、来源/状态与幂等规则。字段名和限额由 `src/agentSendContracts.ts` 拥有，旧的局部字段表已退出。`requestContractDigest` 对整份请求合同作规范化 JSON 的 SHA-256 摘要；`channelsDigest` 使用同一规范化算法摘要渠道定义。`GET /api/agent/send/capabilities` 的 `schemaVersion` 为 `2`。客户端应按版本读取 Schema 与具名规则，不能把发现成功当作全部业务条件已满足或真实平台已送达。此处描述当前源码与隔离 HTTP 验证；安装版和双机更新尚未验收。

版本 2 的 Help 接受 `operationId`、`path`、`method`、`limit`、`cursor`，每项只能出现一次。前三项去除首尾空白后取交集，`method` 不区分大小写，`path` 使用精确路径模板；`limit` 为 1–200。未知、重复、空白或不符合 Schema 的值返回 400 `API_REQUEST_SCHEMA_INVALID`；未匹配的 operation ID 返回 404 `AGENT_HELP_NOT_FOUND`，仅路径/方法查无结果返回 200 空列表。分页 cursor 绑定当前快照和筛选条件，切代或修订失效返回 409 `API_CATALOG_SNAPSHOT_CHANGED`，必须重新读取；不得拼接不同快照。错误不回显查询值，不得在查询参数中放凭据。

插件层还提供 `node scripts/agent-api-route-inventory.mjs`：它输出 exact method/path、`dispatchScopes`（prefix）和 `unresolved`（通配或未展开项）三类清单。扫描使用 TypeScript AST，不执行插件；支持属性换序和带引号属性，忽略注释中的伪声明，动态路径、动态方法与 spread 声明记入 unresolved。旧声明仅展开显式含 routeId 的对象；`executableRegistrations` 另列 registerOperations/registerUpgrades 调用位置，实际 operation 必须读取活动运行目录，调用次数不是接口数量。完全由导入或工厂生成的旧声明仍无法展开；exact 数量按文件与 routeId 区分，不是全局唯一 URL 数量。不要把 prefix 或单一 Agent 目录数量当成全部 Rabi API。群聊/私聊和文件使用 `POST /api/agent/send`。发送前可再调用 `GET /api/agent/send/capabilities` 获取当前渠道、参数说明和示例。内置目录的 `params` 键与发送校验共用字段白名单；字段类型、条件必填和权限仍由实际校验器执行，不应把说明文本当作完整 JSON Schema。QQ/NapCat 使用 `channel: "napcat"`，不能写 `channel: "qq"`。未知渠道会返回 `errorCode`、`help`、`repair` 和支持渠道；其他参数错误的帮助完整度以具体处理器为准；跨角色使用 `POST /api/personas/{targetPersonaId}/messages`；持久任务正文与续投使用 Rabi 线程桥 `POST /api/agent/threads`；正式 callback 按来源需求合同调用。保留原 taskBinding、来源身份、requestId、tracking、引用和稳定幂等字段。Rabi 的 adapter 最终调用 NapCat、Desktop IPC 或其它平台是链路的一部分；调用方绕开 Rabi 才属于旁路。

只有按上节动态发现、核对身份并有界重试后确认 Rabi 不可用，才允许在原授权内使用已核实的当前平台入口。旧端口拒绝连接、Hook 概括提示、参数错误、权限/策略拒绝、owner 未加载或接口能力不足，都不能单独证明 Rabi 已挂。截图或旧任务中的地址不能替代当前 generation。Rabi 健康时应解决具体接口问题，不因工具方便而直发。

超时、断连和 5xx 可能发生在接收后；先读正式回执和目标接收证据。原投递结果不明时不换通道、不换 ID、不重复发送。旁路前须确认原消息未生效或具备跨通道去重证据，并核实目标身份；不得启动第二 Runtime、写会话文件、换目标或逃避审批。

旁路送达只证明平台接收，不能冒充 callback、knowledge-callback、Outbox 或计划状态已记录。保留原标识、目标、时间、摘要和真实平台回执；恢复后先查状态，再按接口支持方式补录，不为补回执重发正文，不直接修改真实存储。没有补录能力时明确保留“旁路已送达，正式回传待恢复”。下一次独立投递仍从 Rabi 开始。

### QQ 只读诊断（权限对等源码合同；部署与实际 QQ 未验收）

`GET /api/agent/qq/diagnostics?routeId=<精确RouteID>` 接受统一入口认证且仍启用的 Agent principal，或符合现有 socket、Host、Origin 与代理检查的可信本机管理请求；不接受请求体或其它 query。不再以 Route primary、provider 或来源元数据形成远端专属门禁；原凭据、Agent 启用状态、电脑凭据代次与实例启用状态 仍由统一认证检查，异步探针及输出前复验原授权。伪造 Agent 请求头、DSH 会话名或请求参数不授权；撤销请求不回退到本机身份。源码实施与回归不代表运行节点已更新，不得绕过鉴权拒绝。

授权后要求 Route 已启用、QQ 消息端已启用、恰有一个已启用的配置实例、Gateway 正在运行，并仅向该实例配置的OneBot HTTP(S) origin（含用户配置的局域网或远端地址） 发出短时 `GET /get_status`。请求禁止重定向、不缓存、无 body；不访问 WebUI、其它 Route 或其它 QQ 实例。返回只有 `routeId`、`instanceId`、`wsConnected` 和 `oneBot.reachable/online/good` 布尔值，不含 QQ 号、昵称、URL、token、消息正文、原始错误或路径。WS 值来自对应 Route 的实例运行状态，只有其 `lastConnectedAt` 不早于当前 Gateway 的 `startedAt` 才可为 true；历史状态不能代替当前进程；OneBot 探针失败为 HTTP 503/未知，不解释为 QQ 离线。该诊断**不赋予发送权限**，不回填登录/账号配置，不代表真实 QQ 已验收；实际 QQ 烟测须另有明确授权和当前连接证据，不由源码测试自动授权。

### QQ 群文件元数据（源码合同；运行态未验证）

`GET /api/agent/qq/group-files?routeId=<精确RouteID>&groupId=<精确群号>[&folderId=<文件夹ID>]` 使用与 QQ 诊断相同的可信 Agent／本机管理身份边界，不要求 Route primary 或额外可信来源元数据。未设置 `messageAdapterPolicies.napcat.readableGroupFileIds` 时，本地与已启用远端 Agent 默认可查询该账号能访问的群文件元数据；显式配置数组时仅允许所列群号，`[]` 表示拒绝全部。读取和保存配置均保留“未设置”与空数组的区别，不从目标群或发送文件根目录推导限制。只选精确 Route 下唯一启用的 NapCat 实例，不跨 Route、账号或群回退；拒绝多余/重复参数和请求体。读取前后均复核原连接及当前限制，不泄露凭据、原始上游错误、其它群的元数据；不下载或发送文件。

根目录调用只读 `get_group_root_files`，指定 `folderId` 调用只读 `get_group_files_by_folder`，固定 `file_count: 50`、3 秒超时、最多 256 KiB 响应和 50 项投影，返回有界的文件/文件夹元数据。`completenessUnknown: true` 与 `potentiallyTruncated: true` 始终表示无法证明穷尽；非法条目可能丢弃，`projectionTruncated` 仅标记投影裁剪。找到精确文件可作为存在证据，空结果或未找到**不能证明缺失**，不得以此自动补发。补发缺失文件还需要平台支持并经验证的完整分页/搜索覆盖，或覆盖对应期间的可信自发事件与原 Outbox 终态经平台对照形成的逐文件闭环；缺少这些证据时停止缺失判定并回传未知，不能扩大范围或绕过权限。此为源码接线与测试合同，不代表当前安装版本、DSH 工具能力或 QQ 在线状态已验收。

## 消息查询：先 Rabi，无法完成时才绕过

### QQ 原消息、历史分页与附件下载

附件及收藏表情直接使用所选 NapCat 返回的 HTTP(S) 地址，支持自定义 CDN 域名、端口及资源重定向；不再额外检查内置腾讯域名名单。

本机 Agent 可通过以下入口读取当前 Route 绑定的 QQ 会话，无需取得 NapCat 地址或 token：

```http
GET /api/agent/qq/history?routeId=<routeId>&kind=group&target=<groupId>&limit=50
GET /api/agent/qq/history?routeId=<routeId>&kind=group&target=<groupId>&cursor=<nextCursor>&limit=50
GET /api/agent/qq/messages/<messageId>?routeId=<routeId>&kind=group&target=<groupId>
GET /api/agent/qq/messages/<messageId>/attachments/0?routeId=<routeId>&kind=group&target=<groupId>
```

私聊使用 `kind=private`，`target` 为对方账号。先动态发现 Manager 并核对 `/meta`；接口可从 `GET /api/agent/help?path=/api/agent/qq/history` 发现。每次调用必须给出精确 Route、会话类型和目标；`limit` 为 1–100，默认 50。历史页返回 `data.entries`、`nextCursor`、`cursorStalled`、`completenessUnknown: true`；沿游标逐页读取，游标停滞或空页时停止，分页覆盖不保证 QQ 完整历史。原消息优先调用 `get_msg`；缓存失效时查询同会话、原消息 ID 锚定的最多 10 条历史页，未命中返回 404 `QQ_MESSAGE_NOT_IN_PAGE`，不扩大为全群扫描。

消息返回 `messageId`、时间、发送者、正文和 `attachments[]`。每项包含从零开始的 `index`、`kind`、`name`、Manager 相对地址 `contentUrl`；用当前 Manager 地址加 `contentUrl` 下载二进制即可。索引允许 1–9 位十进制数，返回列表中超过 99 的索引同样可下载。下载重新核对原消息和会话，再以该消息资源 ID 调用 `get_file`。图片、视频、音频和文件均使用同一入口；视频缩略图不算原视频。结果不暴露 NapCat URL、鉴权或本地路径；不接受调用方 URL、文件路径、任意 OneBot 动作或资源 ID。

源码中这三类入口已注册为 `agent.qq.history.read`、`agent.qq.message.read`、`agent.qq.attachment.read`；收藏表情为 `agent.qq.stickers.read` 与 `agent.qq.sticker.preview`。它们的请求、JSON 投影或有限二进制响应来自可执行合同；OpenAPI 包含当前生效的附件、表情预览字节上限及图片媒体类型；媒体大小默认无应用层配额，运行时 Buffer 能力仍适用。这里的下载由业务拥有者完整读取后返回，不能据此推导持续流式传输。安装版是否包含这些合同须读取该运行实例目录确认。

附件字节、读取超时和并发由 [QQ 读取公开环境配置](connection-access.md#请求仍需正确) 控制；默认附件和上游 JSON 无应用层字节配额（JSON 用 RABIROUTE_QQ_JSON_MAX_BYTES 配置），消息读取 8 秒、附件读取 30 秒、并发 2。繁忙返回 429 `QQ_READ_BUSY` 并说明当前配置；超时返回 `QQ_READ_TIMEOUT` 和对应变量，配置字节限额返回 413 和修改入口。下载可能触发 NapCat 自身媒体缓存，Rabi 不另存业务记录。空路径且没有受支持下载地址返回 422 `QQ_MEDIA_REFERENCE_UNAVAILABLE`，超限返回 413，消息 ID／会话不符或读取中 Route 改变返回 409；上游失败返回 503，不回显原始错误。调用方按需要保存返回的文件并检查非空结果。

这些入口接受统一认证且仍启用的 LAN Agent principal，与可信直接本机管理连接同权；未认证 Relay／隧道请求及伪造 Agent 请求头不授权。异步读取、备用上游读取和输出前复验原授权，撤销返回 403 且不回退到本机身份。仅选择指定 Route 的唯一启用实例，拒绝含多个实例的配置，不跨 Route 或账号回退；本机管理读取权限不赋予发送权限。既有 `message-endpoint-history` 继续用于 Rabi 已记录消息的跨来源检索；原消息与附件需求优先使用上述受管入口。

正常群聊、私聊和最新反馈查询先走 Rabi。安装版通过 `RabiRouteHost.exe --command status --json` 获取当前 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId`；源码模式使用结构化 READY 地址。读取 `<managerBaseUrl>/meta`，按上节合同核对 generation/实例身份；普通查询要求 `health.live=true`，接受 `healthy` 或 `degraded`，再由目标接口判断依赖是否可用。旧地址或瞬时失败时重新发现并有界重试；Hook 的概括性“Host 未运行”提示不能替代实际失败原因。不扫描端口、不读取退役实例锁、不直接启停 Manager。

当前 `GET <managerBaseUrl>/api/gateways` 提供 Route 诊断，其 `messageFiles` 包含近期消息摘要。NapCat 摘要合并群聊和私聊后仅返回最近 8 条，须按目标 Route、群/私聊、消息 ID 和时间筛选；它不是完整历史检索接口。`GET /api/roles/{roleId}/chat-history` 读取的是 Agent 最终回复，不能替代 QQ 群聊历史。
### 查询消息端历史消息

**覆盖与成本限制（Agent 调用前必读）**

- 查询范围是该角色已保存的消息。`includeArchives` 默认关闭；`includeArchives=1` 纳入已保存归档，不保证聊天平台的全部历史。
- 返回最近的匹配片段，每条消息按既有顺序排列。`limit` 默认 50、最多 200；`maxChars` 默认及最多 200,000，预算含文本、分段和记录开销，首条消息可超出预算。`count` 仅是本次返回数量，`coverage` 仅标注角色、归档开关及筛选范围，不是总条数或完整性证明。少于 `limit` 也可能受字符预算影响。
- 本接口没有 `cursor`、`offset`、`nextCursor` 或完整结束标记。不要用这批结果计算整月消息分布，也不要用“最早时间减一秒”模拟分页：同秒多条消息会遗漏。全量统计先核验来源及时间覆盖；受管 QQ 历史分页也不保证平台全部历史。
- 响应的 `coverage` 明示 `recordScope=saved_role_messages`、`resultMode=latest_matches`、`completenessUnknown=true`、`paginationSupported=false`、有效 `limit/maxChars/from/to` 和 `limitReducesArchiveScan=false`。传 `cursor` 或 `offset` 返回 400 `MESSAGE_HISTORY_PAGINATION_UNSUPPORTED`，读取前拒绝，防止重复取得同一片段。
- 已传的 `from/to` 必须是有限 Unix 秒数，双边范围须 `from <= to`；空值、日期文本、`NaN` 或倒置范围返回 400 `MESSAGE_HISTORY_TIME_RANGE_INVALID`，读取前拒绝，避免无效时间条件被静默忽略后扫描全部归档。未传时间范围仍可查询。
- 查询使用本机持久倒排索引，不在请求中扫描原始归档。中文短词、数字和字面子串保持原匹配规则；首次索引未就绪返回 503 并在后台构建，不能把未就绪当空结果。见[持久消息检索](message-history-search.md)。
- 消息查询客户端总预算建议 3000ms；Manager 默认 2500ms 响应截止包含排队和执行，专用查询池默认最多排队 500ms，均可在超时设置调整。超时、繁忙、未就绪或未覆盖目标来源版本明确返回 503；原始文件扫描不是回退路径。客户端断开不取消后台建索引。
- 可传 `budgetMs=1..2147483647` 表示客户端剩余毫秒预算，显式值优先于服务端默认值；排队、执行和可见性阶段仍受各自已配置预算及原请求剩余时间约束。成功和进入读服务后的失败包含 `requestId`；`coverage.indexVersion/sourceVersion/indexedAt/sourceSnapshotIndexed` 标识索引及捕获的来源快照覆盖，不能据此把有限片段视为全部历史。可见性等待默认 1500ms，可在超时设置调整，包含在原请求截止内。
- `coverage.indexCoverage=partial` 表示存在跳过记录、待续末行或旧格式覆盖未知。查看 `sourceRecordsSkipped`、`sourceRecordIssues`、`pendingRecordBytes` 和 `legacyCoverageUnknown`；此时零条结果不证明全部历史无匹配。派生索引单条工作预算由 `maxIndexedRecordBytes` 返回，当前 8 MiB；仅该记录不进入索引，消息写入、原始正文读取和其他正常记录不受影响，原文不删除。详见[持久消息检索](message-history-search.md)。
- `GET /api/agent/help?path=/api/roles/%3AroleId/message-endpoint-history` 返回相同限制。Help 的 `path` 使用目录中的 `pathTemplate`，保留 `:roleId`，不能替换成实际角色 ID。

知识索引更新使用独立的普通优先级读池，最多 1 个进程、16 个排队任务，执行预算最高 30 秒；仍受全局最多 6 个读任务约束。它不继承后台目录读池的闲置优先级或未确认终止状态；单个目录刷新故障不会封锁知识索引初始化。

读进程只按任务加载依赖。消息查询与后台索引使用独立有界进程池；索引在本机持久保存，当前文件只更新变化记录，查询通过来源指纹核对有效性，不读取消息原文件。计划/记忆知识索引仍由自己的服务维护。

知识索引发布已经完成的文件读取批次，并按记录身份重放读取期间的新提交；文件监听发现的变动继续增量核对。持续的计划或记忆更新不再导致整批读取被丢弃、首次索引一直无法就绪。索引读取失败仍保留已发布结果与错误状态，不伪装成完整空索引。

历史检索在索引构建时规范化记录并保留来源副本；查询在指定来源范围内先确认去重胜者，再匹配关键词，时间范围、字符预算及返回顺序保持不变。正式构建中的同步内部调用复用当前请求的代码版本租约，异步工作和迭代器继续独立保留租约；性能验收必须使用正式构建的读进程，不能用未包装的源码耗时代替。

处理端需要恢复 QQ 群聊、QQ 私聊或其它消息端上下文时，使用只读接口：

```http
GET /api/roles/{roleId}/message-endpoint-history
```

常用参数：`query`（支持空格、英文逗号、中文逗号、顿号分隔的多个关键词）、`match=any|all`（默认 `any`）、`adapter`、`kind=group|private`、`sender`、`target`、`conversationKey`、`from`、`to`、`includeArchives=1`、`limit`。用户说“最近一小时”等时间范围时，必须转换为 Unix 秒 `from`（必要时传 `to`）；用户要求“所有消息”时省略 `query`，不要臆造关键词。`limit` 只是返回上限，不代表完整覆盖；无时间范围时也使用索引；结果依然是有限片段，不能作为全量历史证明。返回 `entries`、`count` 和 `coverage`；消息记录保留消息端、群/私聊会话键、发送者、目标、消息 ID、回复 ID 和附件摘要。`kind=group` 只查群聊入站消息，`kind=private` 只查私聊入站消息；`reply_sent` 等出站回复不应当当作用户原始反馈。

查询由有界交互读进程执行，不占用目录整理任务队列；客户端断开会取消排队任务或终止仍在读取的进程。另支持 `channel` 和 `maxChars`；`limit` 默认 50、最多 200，`maxChars` 默认及最多 200,000。既有 `entries/count` 和筛选语义保持兼容，`coverage` 增加上述限制标记；读池繁忙、超时或无法确认子进程终止返回 HTTP 503，业务参数错误仍返回 400，不把失败伪装成零条记录。此隔离不承诺任意大小历史都能在超时前查完，也不代表其它同步入口或线上健康已验收。

新会话的上下文恢复顺序：先从用户原话提取对象和关键词；再查本接口恢复消息端历史；涉及计划、记忆或原任务归属时另查 `knowledge/search`；最后回到当前文件、配置、代码或运行证据。查询覆盖范围必须随结果一起判断，空结果不等于系统从未出现过该消息。


只有 Rabi 无法访问、接口不可用或已确认摘要无法覆盖所需历史时，才使用当前 NapCat 或正式日志补查。Rabi 可用时从当前 Route 绑定和状态取得连接；不可用时只使用当前任务明确提供的连接、当前运行实例配置或已确认的正式日志。直连前用 `get_status`、`get_login_info` 核对在线状态及账号，再调用只读历史/消息接口。不得从旧任务、记忆或安装残留逐个试账号和端口；凭据不回显。鉴权拒绝不得通过旁路逃避权限。

空结果先核对目标及时间覆盖，不应归为连接故障。返回结果时区分“连接失败”“查到零条”“历史未覆盖”；绕过时说明原因、实际来源与时间范围。查询不授权发送、重放消息、修改配置或重启服务。下一次独立查询仍从 Rabi 开始。

## 上下文注入

RabiRoute 投递消息给 Agent 时，应在上下文中注入本接口文档链接，让 Agent 知道当前可以关注和使用哪些 Rabi 接口：

```text
Agent 需要关注的 Rabi 接口：{agentInterfaceDocPath}
```

推荐路径：

```text
docs/rabi-agent-interfaces.md
```

### 身份关系记忆接口

身份关系记录“这个消息端账号可能对应谁，以及哪些人与人、组织或项目关系已确认或待确认”，不等同于聊天记录、计划或当前发言立场。关系记录本身不分长期或短期；当前消息里的临时角色由情景记录表示。身份关系由角色私有保存。只有受支持消息端从真实发送者字段提供稳定 `senderStableId` 与 `endpointIdentityNamespace`，并且消息实际进入命中的 Route 投递时，系统才会自动建立“待认识”的候选参与者。昵称、群权限、一次自报或正文里转述的身份都不能触发确认。账号查询键必须同时提供 `platform`、`endpointIdentityNamespace` 和 `senderStableId`；不要使用 Route ID 代替其中任何一项。

```text
GET /api/roles/:roleId/identity-relations
GET /api/roles/:roleId/identity-relations?platform=<platform>&endpointIdentityNamespace=<namespace>&senderStableId=<id>&conversationKey=<optional>
PUT /api/roles/:roleId/identity-relations
POST /api/roles/:roleId/identity-relations/observations
```

`GET` 不带查询参数时返回账号、参与者和关系卡的当前视图；带完整账号键时返回该账号的解析上下文。`PUT` 一次只写一种记录：`endpoint_account`、`participant` 或 `relation_card`，用于人工确认、纠正和冲突处理。`POST .../observations` 供处理 Agent 在对话中发现新身份线索时使用：它只能更新当前账号已经关联的候选参与者和候选关系，不能写成 `confirmed`，也不能覆盖冲突记录。写入要附最小化证据引用，例如消息 ID、消息端、群/私聊会话或简短核对说明；不要复制整段私人聊天正文。多电脑同步后，若同一记录存在不一致的并发事件头，视图会标记 `conflicted`，给出 `conflictEventIds`，并在 `conflictCandidates` 中保留每个候选的完整记录，供角色页比较后修正；这类记录不会参与自动确认。要收敛冲突，`PUT` 必须明确提供该记录的全部关键字段，新的事件会替代所有当前事件头。

稳定账号键只能证明“这是同一个消息端账号”，不能单独证明“始终是同一个人在使用”。共用账号或证据互相矛盾时，`participantLinks` 可以保留多个候选；当前账号只有一个候选参与者时，观察请求可以省略 `participantId`，存在多个候选时则必须先通过带完整账号键的 `GET` 读取候选 ID，再明确指定。系统不会根据昵称、最近发言或最高置信度自行选择。

证据应区分作用。用户明确纠正、可核对的跨消息端归属和持续稳定的账号事实可以支持人工确认；自报姓名、别人转述、显示名以及词汇、句式、回复节奏等说话习惯一致性只能作为候选的辅助证据。即使多次表现一致，也不能单独创建确认映射。来源不能提供稳定发送者标识，或者自报只存在于转发、引用、附件文字等不可信上下文时，Agent 必须保持未识别，不得调用观察接口把它合并到既有人物。

说话习惯档案属于参与者记录，只能通过受审阅的 `PUT` 更新，不能由观察接口从未归因消息中自动学习。`speakingHabits` 每项包含 `dimension`、自然语言 `description`、可选 `confidence` 和 `evidenceRefs`；证据至少要有一条作者已经确认的 `messageId`。允许的维度为 `sentence_opening`、`sentence_length`、`stance_expression`、`emotion_threshold`、`analogy_source`、`punctuation`、`reader_relationship`、`value_preference`、`information_order`、`avoidance`、`imperfection`、`scene_boundary`。共享账号中作者仍不确定的消息不得写入任何人的档案。

```json
{
  "kind": "participant",
  "participantId": "participant-example",
  "speakingHabits": [
    {
      "dimension": "sentence_opening",
      "description": "常先指出当前判断，再补条件和未确定项。",
      "confidence": 0.75,
      "evidenceRefs": [
        { "messageId": "confirmed-author-message-id", "note": "作者已经人工确认。" }
      ]
    }
  ]
}
```

```json
{
  "platform": "napcat",
  "endpointIdentityNamespace": "bot:example",
  "senderStableId": "example-user",
  "participantKind": "person",
  "participantDisplayName": "对方明确自述的称呼",
  "aliases": ["本轮出现的新称呼"],
  "conversationKey": "napcat:group:example",
  "evidenceRefs": [
    {
      "messageId": "example-message-id",
      "conversationKey": "napcat:group:example",
      "note": "只写身份线索和判断依据，不复制整段聊天。"
    }
  ]
}
```

角色页把同一读取结果投影为“已识别身份”和“未识别身份”。已识别人物使用整张卡片作为入口，在同一个身份工作区内查看和编辑参与者资料、说话习惯、消息端账号与关系；参与者、账号和关系仍通过独立 `PUT` 保存，不构成一次事务。独占账号放在唯一人物中；已经知道使用者范围的共用账号同时出现在每个可能使用者中，并标记“共用”，但解析结果仍保持多人候选。“未识别身份”按 QQ、微信、声纹等消息端分类，容纳尚不知道对应人物、候选尚未指向已识别人物或存在冲突的账号。页面会在身份修正或角色同步事件后刷新；共用账号的单条消息归因、其他候选和冲突仍只能作为核对材料，不能被当作项目归属或执行授权。

声纹在概念上也是消息端账号。当前通用账号键使用 `platform=voice`、`endpointIdentityNamespace=host:<处理主机 ID>` 和 `senderStableId=voiceprintId`；一段多人录音可以关联多个账号。当前版本已把语音归类工具放进同一个“身份定位”区域，但旧数据仍由下文的 `voice-identities` 兼容接口和文件保存。不要同时向两套接口重复写同一条判断；完成统一数据迁移前，声纹的“这是我 / 其他人”、覆盖率和冲突读回仍以下文接口为准。

### 情景记录

```text
GET /api/roles/:roleId/conversation-situations?limit=20
GET /api/roles/:roleId/conversation-situations/:situationId
```

消息实际投递时会生成这份只读情景记录。它没有聊天正文，只保留会话和消息标识、关系卡派生的项目线索、附件/身份歧义以及 `mayParticipate=true`、`mayCreateOrUpdateCurrentProjectRecords=false`。它用于人工审阅主动智能是否把“可参与讨论”误解成“应负责当前项目”；接口不能用来创建、确认或授权项目动作。

```json
{
  "kind": "endpoint_account",
  "platform": "napcat",
  "endpointIdentityNamespace": "instance:qq-main",
  "senderStableId": "example-user-id",
  "participantLinks": [
    {
      "participantId": "participant-example",
      "status": "confirmed",
      "confidence": 1,
      "evidenceRefs": [{ "messageId": "example-message-id" }]
    }
  ]
}
```

候选映射只用于核对，不能用于真实称呼、授权、项目归属或执行。`confirmed` 也只说明身份或关系本身；它不能绕过明确委托、项目范围和外部动作审批。身份关系不进入 `knowledgeMatches`，也不需要为每条消息提交 `knowledge-callback`。

同时默认注入轻量索引：

```text
当前计划：
- plan-001：完善计划和记忆机制文档

近期记忆：
- memory-001：计划和记忆由 Agent 主动维护
```

近期记忆统一指 `memory/recent/` 里的记忆。默认配置下，最近 24 小时内更新或查看过的近期记忆会直接注入；超过 24 小时且尚未沉淀的近期记忆不默认显示，只有用户消息命中标题或 `keywords` 时才会被召回。默认注入和可编辑窗口取 `updatedAt` / `viewedAt` 中较新的时间；沉淀窗口取 `updatedAt` / `recalledAt` 中较新的时间。按 ID 查询只刷新 `viewedAt`，更新刷新 `updatedAt` 和 `viewedAt`，关键词命中召回同时刷新 `viewedAt` 和 `recalledAt`。

RabiRoute 还会注入 `[处理前上下文确认]`。它会从未归档计划、近期记忆和沉淀记忆中按 ID、标题和 `keywords` 做轻量打分，列出默认最多 5 条高相关必读项。Agent 在回复、发布任务、更新计划、写入记忆或执行外部动作之前，必须先按该小节里的 GET 路径读取内容；不能只凭标题行动。若必读项无法读取或内容不足以确认，应说明上下文无法确认，或先向用户追问。

### 只启用知识接口的本机 Manager 模式

直接在 Codex 中维护角色计划或记忆、但不希望 Manager 自动启动已启用网关、RabiLink Relay 或局域网发现时，可以在启动 Manager 前设置：

```powershell
$env:RABIROUTE_MANAGER_AUTOSTART = "0"
npm run manager
```

此模式仍提供 `/meta`、计划、记忆和校验等 Manager HTTP 接口；`GET /meta` 会返回 `managerAutostart: false`。它关闭已停止 Route 的自动启动和文件监视器，不移除显式运行控制接口。若调用方已经显式启动某条 Route，之后又通过 Manager 保存配置，Manager 仍会重启该运行中 Route 以应用新的会话、模型和消息端设置；否则界面保存态会与真实投递态分叉。调用方仍不得在没有相应授权时请求启动、重启、触发、回传或外发动作。生产托盘和正常消息路由不设置该变量，行为保持不变。

### 身份与网关诊断的可执行合同

源码以 `manager.meta.read` 和 `manager.gateways.read` 注册 `GET /meta`、`GET /api/gateways`。旧 `agent:GET:/meta` ID 解析到同一操作。Meta 在依赖未就绪时仍可返回身份与健康数据，不以 `live`、`requiredReady` 或 `businessReady` 的真假拒绝诊断；普通业务调用继续按当前身份及目标依赖判断。调用方仍须使用原连接鉴权，不能把诊断可读当成额外业务授权。

诊断响应使用 `Cache-Control: private, no-store`。原诊断拥有者忽略的查询参数保持兼容；身份发现仍使用精确 `/meta`。网关提供方字段保持开放，`messageFiles` 是按消息端命名的对象，其中近期片段不代表平台完整历史。安装状态以当前活动目录为准。

### 适配器目录、显式扫描与连接管理

源码通过 `agent.adapters.<key>.<method>` 发布 9 类 operation：`catalog.get`、`all.get`、`dsh.get`、`grokBot.get`、`connection.get`、`connections.get`、`connect.post`、`disconnect.delete`、`hooks.post`。以活动目录中的合同确认实际安装状态。目录只描述已实现的适配能力；扫描须显式请求，不后台轮询，不创建替代会话或执行真实 prompt。新增接口继续复用已鉴权连接，无人格或工作区的第二层许可。

DSH 保存和断开仍须先读取当前 `revision`，正文携带 `expectedRevision`；冲突或结果不确定时重新读取原连接，不能自动重放。正文上限仍为 16 KiB，总预算仍为 90 秒，包含正文等待和连接验证；`launchUrl` 是只写输入，不出现在目录或连接元数据。连接凭据继续由原受保护存储拥有。Hook 更新可能修改已安装集成文件，其响应不证明已执行 Agent 任务。扫描关闭、繁忙和原宿主缺席保持既有取消、排队及失败语义。

### Codex Hook 上下文接口

源码已通过同一可执行合同发布 Hook 的上下文、角色列表、诊断及会话绑定接口，canonical operation ID 为 `agent.hook.<context|roles|doctor|sessions|session|bind|unbind>.<method>`；旧 `hook:METHOD:/path` ID 解析到同一处理器。JSON 正文上限仍为 256 KiB，服务原有字段别名与归一化规则保留；未知查询参数和重复查询参数在业务前被拒绝。`/context` 可能更新状态或触发既有回传，不自动重放；结果不确定时保留原 session/turn 并核对绑定、计划和投递记录。安装版是否已包含合同，以其活动目录为准。

已启用并鉴权的远端 Agent 可以调用 Hook 角色目录、诊断与会话绑定管理接口，无需工作区、角色或 Route 绑定。提交 `/context` 时须提供该 Agent 真实拥有的会话和匹配的 `agentType`；默认值为 `codex`。读取请求体后、写入前再次核验原连接仍有效，避免撤销后的请求继续写入。消息组登记同样使用公共接口，不再单独限制远端调用方。

通用入口接受 `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS`，不按 Windows 文件名限制资源 ID，也不按接口目录拒绝未来路径。普通业务正文可以是数组、标量或包含 `sender`、`worker` 等目标配置字段，具体 Schema 由目标接口校验；来源身份检查只用于真实消息投递、处理决策和 Hook 事件。

Codex 插件必须把 Hook 原始事件提交给 Manager，而不是在插件内复制角色、计划、记忆或召回逻辑：

```http
POST /api/codex-hook/context
```

请求体沿用 Codex Hook 字段，至少包含 `hook_event_name` 和真实 `session_id`。当前接受：

- `SessionStart`：提供 `source`；
- `UserPromptSubmit`：提供 `turn_id` 和 `prompt`；
- `PreToolUse`：提供 `turn_id`、`tool_name`、`tool_use_id` 和 `tool_input`；
- `PostToolUse`：在上述字段外提供 `tool_response`。

Manager 负责解释严格的 `[rabi:*]` 控制标记、维护 session 绑定，并把事件标准化为 `session_start`、`user_prompt`、`reasoning_pre_tool` 或 `reasoning_post_tool`。这些事件与 RabiRoute 消息投递的 `message_delivery` 都进入同一个 `RabiContextManager`；只有它调用 `roleKnowledgeSnapshot()`、执行计划归档和 `viewedAt` 策略，并在 `data.additionalContext` 中返回可注入内容。未绑定会话返回空字符串。

推理期触发只返回本轮新增的相关知识。相同 `turn_id` 内，Manager 按条目类型、ID 和修订时间去重；Pre/Post 重复看到同一条目时既不重复注入，也不重复刷新 `viewedAt`。`preview` 策略不归档计划、不刷新 `viewedAt`、不创建 consolidation run。

Rabi PC 可按完整 session ID 主动维护绑定：

```text
GET    /api/codex-hook/roles
GET    /api/codex-hook/sessions
GET    /api/codex-hook/sessions/:sessionId
PUT    /api/codex-hook/sessions/:sessionId  { "roleId": "YeYu" }
DELETE /api/codex-hook/sessions/:sessionId
GET    /api/codex-hook/doctor
```

绑定状态属于 Manager 私有运行数据。插件不得保存第二份 binding、角色根、关键词索引或记忆正文；Manager 离线时只允许失败开放并说明本轮未注入，不能使用插件本地缓存伪造成功。

### 智能手表 / 手环健康查询

启用 `wearable` 消息端后，结构化健康观测按角色进入独立时间线，不进入普通聊天记录。Agent 可使用本机 Manager API 查询，而不是依赖提示词里复制全部健康数据：

```text
GET   /api/roles/:roleId/health/state
GET   /api/roles/:roleId/health/history?metric=heart_rate&from=<ISO>&to=<ISO>&limit=100&order=desc
GET   /api/roles/:roleId/health/summary
GET   /api/roles/:roleId/health/config
PATCH /api/roles/:roleId/health/config
POST  /api/roles/:roleId/health/observations
```

`state` 和 `summary` 都包含时效信息；`unknown` 或 `stale` 不得解释成确定的睡着、醒来或健康状态。经 RabiLink Relay 输入并命中心率/睡眠规则的观测会形成 `wearable_health_alert` Agent 事件。认证秘钥、Relay token 和原始敏感元数据不得作为观测字段传入。完整字段、配置和验收边界见 [`rabilink-wearable-health.md`](./rabilink-wearable-health.md)。

### 读取远端角色配置（0.3.19 实验实现）

本机 Route 的 `agentRoleDeviceId` 非空时，`agentRoleId` 属于该远端 PC。0.3.19 新增下列实验来源接口；来源 PC 缺少接口时需要升级，不能改读本机同名角色：

```http
GET /api/roles/:roleId/persona-reference?file=persona.md
```

`file` 只接受角色目录内的单个 `.md` / `.markdown` 文件名。成功返回 `{code:0,data}`，其中 `data` 包含 `schemaVersion:1`、真实 `roleId`、`file`、`document`、规范化 `personaConfig`、SHA-256 `revision`、`applicationGenerationId` 和 `managerInstanceId`。正文与配置默认不设应用层字节配额；可在来源 Manager 设置 `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES`、`RABIROUTE_PERSONA_CONFIG_MAX_BYTES`，0 或移除变量取消限制。路径越界、损坏 JSON 或明确配置的超限均拒绝受影响读取，不返回截断内容冒充完整结果；配置无效仅对受影响能力返回 503 和字段说明。

通过当前本机 Manager 的 `/api/rabilink/peer/http/<设备>/persona/...` 访问来源 PC。首次使用通过 `POST /api/rabilink/peer/persona/bootstrap` 提交 `{deviceId}`，复用 RabiLink 已鉴权的应用连接、签名握手和 P2P / Relay 传输，并固定双方公钥。启用且已鉴权的应用连接默认可使用来源 PC 全部公共 Manager 接口，无需逐角色或逐服务授权；旧手工服务列表由现有应用连接迁移清理。用户明确停用应用、凭据变化或连接撤销后拒绝访问。实际 Gateway 解析还核对当前 Route capability、已保存引用和两端 Manager 身份，这些检查用于确认上下文和目标；切代、离线、鉴权失败或绑定变化时停止投递，无同名本机回退。

Peer 发现与 bootstrap 使用以下可执行合同；具体版本是否已发布，以目标 Manager 的活动目录为准：

| operation ID | 接口 | 原有执行规则 |
| --- | --- | --- |
| `manager.rabilink.peer.list` | `GET /api/rabilink/peer/list` | `deviceKind`、`online=true|false` 按首个查询值筛选，统计注册记录；保留提供方扩展字段 |
| `manager.rabilink.peer.persona.bootstrap` | `POST /api/rabilink/peer/persona/bootstrap` | 只接收 `{deviceId}`，正文上限 8192 字节，复核原连接与 Manager 身份 |
| `manager.rabilink.peer.device-bootstrap` | `POST /api/rabilink/peer/device-bootstrap` | 先核验真实 Relay 设备来源，再读正文；保留原 `authenticatedAt`、签名、nonce 和 45 秒绝对有效期。`maxBytes:0` 保留原读取器未设置应用层字节上限的行为 |

设备 bootstrap 的来源证明属于原设备身份合同，普通 Agent 不能在正文中冒充 Relay 设备。私有加密 `/api/rabilink/peer/receive` 仍用于传输信令，不进入公共目录。结构、媒体类型及方法错误由统一注册器返回；原设备有效期、签名和业务错误仍由对应拥有者返回。

本机实际处理 Agent 与消息端保留原 Route 配置，使用远端角色正文、消息规则和最近消息额度。计划、记忆与技能通过来源入口按需查询；本机 `roleDir`、`rolePath` 为空，投递审计留在本机 Route 目录。远端定时/脚本、计划秘书、记忆整理和 Hook 权限不会因此在本机启用。本机角色目录不把该 Route 挂到同名本机角色下，本机跨角色消息接口也拒绝冒充远端发件角色。

对外回复需要语言风格检查时，读取远端角色当前配置，向来源 PC 的 `POST /api/roles/:roleId/persona-reference/language-style` 仅提交 `{text,file,revision}`。来源从该角色已保存配置读取风格资料，拒绝调用方提供风格地址；不能把来源路径用于本机读文件。前后核对两端身份和来源快照 revision。显式单次 `styleValidation=0` 按既有合同处理，但不能绕过远端配置读取、离线或鉴权失败。角色通道只允许限定读取及此项检查，不提供远端知识写入或完整管理操作。页面与完整边界见[远端角色引用](remote-persona-reference.md)；真实双 PC 投递仍需单独验收。

### 查询其它角色并投递消息

“角色”是面向用户和 Agent 的正式名称；现有 `roleId`、`/api/roles/*` 和 `data/roles/` 是兼容保留的内部名称。角色列表提供专用接口，不需要从 Route 管理结果中拆解：

```http
GET /api/personas
GET /api/personas?addressable=true
GET /api/personas/:personaId
```

列表入口已迁入可执行合同 `manager.personas.list`，保留旧发现 ID `agent:GET:/api/personas`，安装版待验收。已鉴权远端直接调用，无需会话预登记或角色许可。目录沿用当前角色快照与运行表，只包含当前存储根的角色；远端拥有的 Route 不计入本机可达性。筛选仅认首个 `addressable` 的精确字符串 `true`，其它查询项保持忽略。读取不启动 Route，也不投递消息。原目录快照尚未安装时返回 503，需等待目录就绪后读取。

列表返回角色的 `personaId`、显示名称、是否可以接收消息，以及绑定的 Route。`addressable=true` 只返回至少绑定一个已启用 Route 的角色；只有一个已启用 Route 时会同时返回 `defaultRouteId`。

角色详情、投递和回执现采用 `manager.personas.read`、`manager.personas.messages.send`、`manager.personas.messages.receipt`，旧 `agent:METHOD:/path` 发现 ID 仍解析到同一合同，安装版待验收。投递保留 65536 字节 JSON 上限、去除首尾空白后 32768 个 UTF-16 码元的文本上限，以及 200 个码元的对话/引用上限；JSON 仍不依赖 Content-Type。读取正文前捕获原存储拥有者，持久处理前后复验原连接，实际投递前复核来源证明，以及原来源和目标的本机归属与启用状态。

投递异常返回原消息 ID、回复上下文及 `uncertain=true`；该失败结果也可能已按原 `deliveryId` 持久保存。回执 `state=completed` 表示幂等记录已完成，投递是否成功仍以 `result.status` 为准。审计失败不补发，HTTP 断线后原进程、日志、审计及持久记录继续收尾。

当前角色需要联系另一个角色时，使用目标角色路径，并从当前 `AgentPacket.replyContext` 读取 `runtimeRouteId` 和 `personaMessagingCapability`。凭据同时绑定 Route 与角色，不能用另一个 Route 或角色的身份复用：

```http
POST /api/personas/:targetPersonaId/messages
Content-Type: application/json

{
  "deliveryId": "stable-unique-delivery-id",
  "sourceRouteId": "source-route",
  "sourceCapability": "value-from-replyContext.personaMessagingCapability",
  "targetRouteId": "optional-when-target-has-one-enabled-route",
  "conversationId": "optional-stable-conversation-id",
  "inReplyToMessageId": "optional-message-id-being-answered",
  "hopCount": 0,
  "text": "请检查今天的构建状态。"
}
```

`deliveryId` 必填，并由调用方为一次业务投递稳定生成。相同 ID 与相同请求只执行一次，重试返回同一完成结果；相同 ID 携带不同内容返回 `409`。请求结果不明确时先查询回执，不要直接生成新 ID 重发：

```http
GET /api/personas/messages/receipts/:deliveryId
```

发送 Route 和接收 Route 都必须已启用；目标角色有多个已启用 Route 时必须提供 `targetRouteId`，不能猜测；不能通过这个接口给自己发送消息。`hopCount` 必须是非负整数，最大为 `8`。成功响应为 HTTP `202` 且 `status=delivered`，表示消息已经沿目标 Route 的现有 `role_panel_message` 路径交给目标处理端。服务只在处理端接收后记录 `status=sent`；失败记录只代表一次尝试。

跨角色投递是显式的单向消息，不会自动建立双向聊天。目标角色的普通回复只留在自己的角色面板。需要回复来源角色时，目标角色必须再次调用 POST：把新的 `deliveryId` 用于本次回复，沿用收到的 `personaConversationId`，令 `inReplyToMessageId` 等于当前消息 ID，并把 `personaMessageHopCount` 加一。超过 `personaMessageMaxHops` 时停止继续互投。

需要向消息端发送内容时，AgentPacket 会同时给出明确发送接口、已经按当前来源生成的请求模板，以及只读来源上下文：

```text
明确发送 API：`<managerBaseUrl>/api/agent/send`；安装版从 Host `status --json` 发现本代地址，源码模式由 Manager 标准输出提供。
明确发送请求模板：{"deliveryId":"<stable-id>","sender":{"agentType":"primary_persona","sessionId":"<当前 Codex 主角色完整会话 ID>"},"routeId":"main","channel":"napcat","styleValidation":1,"params":{"target":"group","groupId":"456","instanceId":"default","replyToMessageId":"<能引用时填源消息 ID；不引用时填空字符串>","replyImageDescriptions":[]},"payload":{"type":"text","text":"<正文>"}}
来源上下文（只用于核对来源，不可直接作为发送参数）：{"routeKind":"direct_at","messageId":"123","groupId":"456"}
```

## 明确发送接口

Agent 的外部消息统一使用一个发送接口。旧 `/api/agent/replies` 已取消；`/api/agent/send` 不接受“把 replyContext 原样传回后自动猜目标”的用法。

```http
POST /api/agent/send
```

请求体固定包含：

- `deliveryId`：本次业务发送的稳定 ID，重试时保持不变；
- `sender.agentType`：调用发送接口的 Agent 角色标识；
- `sender.sessionId`：调用发送接口的 Agent 完整会话 ID；
- `routeId`：精确的已启用 Route ID；
- `channel`：发送渠道；
- `params`：该渠道的目标参数；
- `payload`：`text`、`image`、`voice`、`file`；NapCat 另支持把 `markdown` 渲染成图片；
- `styleValidation`：枚举值 `1 | 0`，默认 `1`。`1` 使用角色绑定的目标语言风格 Skill 校验文本；`0` 跳过本次校验；
- `messageLengthConfirmation`：NapCat 超限响应返回的单次确认凭据；第一次请求省略，复核后以完整原请求和同一 `deliveryId` 再次提交。
- `tracking.requirementId`：可选，用于关联消息处理看板，不能决定发送目标；回复已登记的消息处理需求时必须填写；
- `tracking.sendContextReviewToken`：消息处理需求在发送前完成最新群聊上下文核对后取得的短期凭证，只对同一需求、发送者会话、目标和正文有效。

所有 Agent 按注入模板填写实际发送角色与当前完整会话 ID，使用统一投递合同。

QQ 群文本示例：

```json
{
  "deliveryId": "send-example-001",
  "sender": {
    "agentType": "primary_persona",
    "sessionId": "019f0000-0000-7000-8000-000000000001"
  },
  "routeId": "main",
  "channel": "napcat",
  "styleValidation": 1,
  "params": {
    "target": "group",
    "groupId": "456",
    "instanceId": "default",
    "replyToMessageId": "123",
    "replyImageDescriptions": [
      "图片展示动态文字变长后底框随内容扩展，想表达背景宽度需要跟随正文变化。"
    ]
  },
  "payload": {
    "type": "text",
    "text": "收到，我来处理。"
  },
  "tracking": {
    "requirementId": "message-requirement-001",
    "sendContextReviewToken": "<POST send-context 返回的 token>"
  }
}
```

已鉴权远端调用 `send` 或线程桥时，发送来源使用本次显式类型与完整会话 ID，不要求该聊天已列在连接器的 `sessionId/managedSessionIds` 中，也不为此次请求重绑连接器。节点凭据、连接撤销与用户明确停用仍校验。`GET /api/agent/uploads/:uploadId` 复用当前 Manager 连接鉴权，主机及其他已鉴权连接可读取原上传 DTO；使用 `fileId + fileSha256` 时继续核对有效期与真实内容，不再把原上传 Agent 身份当作额外许可。渠道仍按 capabilities 声明的文件发送能力执行。

### QQ 表情

QQ 系统小表情可在文字中使用 `[CQ:face,id=<QQ 表情 ID>]`。收藏表情先调用 `GET /api/agent/qq/stickers?routeId=<Route ID>&instanceId=<实例 ID>&count=1000`；`instanceId` 在该 Route 只有一个启用账号时可省略，`count` 范围为 1–1000。返回当前账号的 `items { id, name, description, previewUrl }`，`name` 来自 QQ 原生收藏描述，不含原始媒体地址或凭据。`previewUrl` 是同一 Manager 的只读图片接口。旧 NapCat 可安装[名字兼容插件](../plugins/napcat-stickers/README.md)；没有该插件或收藏本身未命名时，名字为空，选择前查看预览。数量上限和 `completenessUnknown` 不证明收藏列表完整。

发送沿用 `POST /api/agent/send`、原来源和稳定 `deliveryId`，使用 `"payload":{"type":"sticker","stickerId":"<列表中的 id>","text":"可选说明"}`，`channel=napcat`，`params` 与普通群聊/私聊一致。发送时重新从所选账号的收藏列表解析 ID，保留表情图片子类型；表情被移除时返回失败，不跨账号寻找替代品。表情属于现有 `image` 输出能力，沿用 Route 显式设置、引用、文字长度、文风、幂等与回执检查。不能同时提供 `path`、`url` 或 `segments`。QQ 内添加或删除收藏后，下一次查询直接读取当前内容；代码没有预置角色、固定图册或日常随机发送计划。

NapCat 图文混排使用 `payload.type=image` 和有序的 `payload.segments`，一次发送一条群聊或私聊消息：

```json
{
  "deliveryId": "send-mixed-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前完整会话 ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "456", "replyToMessageId": "", "replyImageDescriptions": [] },
  "payload": {
    "type": "image",
    "segments": [
      { "type": "text", "text": "第一张：" },
      { "type": "image", "path": "<授权目录中的第一张图片>" },
      { "type": "text", "text": "第二张：" },
      { "type": "image", "path": "<授权目录中的第二张图片>" },
      { "type": "text", "text": "两张图的差异见上。" }
    ]
  }
}
```

`segments` 仅用于 NapCat 图片消息；按数组顺序发送非空的 `text`、`image` 或 `markdown` 段，至少包含一个图片或 Markdown 段。段数与图片/Markdown 段数默认不限；如需额度，设置 Manager 环境变量 `RABIROUTE_AGENT_SEND_MAX_SEGMENTS` 和 `RABIROUTE_AGENT_SEND_MAX_IMAGES`，0 或删除变量可取消限制，下次加载 Manager 生效。公开 Help 显示当前值；超限错误说明对应设置和取消方式。每个图片段只填 `path` 或 `url` 之一；本地路径逐张按 `allowedFileRoots` 校验，任何一张不合格都会在平台发送前拒绝整条消息。使用 `segments` 时不要再填顶层 `payload.text`、`path`、`url` 或 `planAttachment`。原单图 `payload.text + path/url/planAttachment` 仍可使用。文字与 Markdown 源文会合并用于语言风格校验；`replyImageDescriptions` 仍只描述**被引用的来源消息**中的图片。

单独把 Markdown 文本渲染成图片，提交 `"payload":{"type":"markdown","text":"# 标题\n\n| 项目 | 结果 |\n|---|---|\n| A | 通过 |"}`。需要与普通文字、已有图片交替排布时，在上述 `segments` 数组中加入 `{"type":"markdown","text":"# 标题\n\n**正文**"}`；该段在原位置变成图片，整条消息只发送一次。两种形式都要求 NapCat Route 允许 `image` 输出，不能再附加顶层 `path` 等媒体字段。

Rabi 使用本机 Chromium、Chrome 或 Edge 的无脚本浏览器进程渲染 Markdown，自动检测常见安装位置；也可通过 `RABIROUTE_MARKDOWN_BROWSER_PATH` 指定浏览器可执行文件的绝对路径。标题、列表、表格、引用和代码块会出现在 PNG 中。原始 HTML 转义，链接不可点击，Markdown 图片语法只显示说明占位，不加载本地或远程资源。默认不设 Markdown 源文、图片高度、PNG 大小或消息图片总量的应用额度；可通过公开的 `RABIROUTE_MARKDOWN_*` 环境变量显式配置，详见[连接与配置限制](./connection-access.md)。Chromium 视口整数范围、内存和实际截图能力仍由运行时决定，失败会如实返回。浏览器不可用或渲染失败时，整条消息不进入 NapCat 发送。

角色可在 `personaConfig.json.languageStyle.styleSkillUrl` 绑定自己的语言风格 Skill。不同角色可以绑定不同 URL。URL 可指向 Skill 目录、`SKILL.md` 或 `references/style-data.json`；Manager 从其中读取程序化 JSON 规则。

### NapCat 长消息确认

在消息路线的 **NapCat → 长消息确认** 中设置 `messageAdapterPolicies.napcat.textConfirmationThreshold`。接受 `0–200000` 的整数；默认 `0` 关闭，用户显式设置后才启用。超过阈值的 `/api/agent/send` 先返回 HTTP `409`、`status=message_length_confirmation_required` 和 `messageLengthValidation`，尚未创建 Outbox 发送或幂等回执，提示不会发到 QQ。

字数按 Unicode 码点计算，包含数字、英文、标点和正文内空格，去除首尾空白与 CQ 控制标记。文字、图片/文件说明、Markdown 及有序图文段中的全部文字均参与计数；自动生成的引用和 @ 标记不计入。

Agent 应先检查和精简。一条说不清时，按完整意思拆成少量消息，像聊天一样一句接一句说；每条分别接受长度和文风检查，不按字数硬切或重复背景。尚无回执的原 `deliveryId` 可用于第一条，后续各条使用独立稳定编号并保留来源、目标和话题上下文；需要向同一源消息继续补充时，按既有合同显式传 `params.allowAdditionalReply=true`。重试沿用各条原编号，已发送或结果不确定的内容先核对回执，不重新拆分发送。

原请求还没有发送回执时，可保留 `deliveryId` 修改正文并重新检查，不携带旧确认凭据。确需保留单条原文时，用同一 `deliveryId` 和完整原请求再次调用，只增加 `messageLengthConfirmation=messageLengthValidation.confirmationToken`。凭据有效期十分钟，绑定发送身份、目标、原文、附件与当前阈值；改内容、目标、编号或阈值，凭据过期或 Manager 重启后都需重新检查。成功回执按原编号读取，超时或不确定时先核对原回执，不换编号重发。

长度确认与文风校验独立。超限响应也会带当前文风结果；文风失败仍需改写或按下节合同显式确认，`styleValidation=0` 不跳过长度确认。该参数是单次内容复核，不改变连接权限、Route 输出设置或角色风格绑定。

### 外发文风校验

`styleValidation=1` 且校验不通过时，Manager 返回 `409` 和 `status=style_confirmation_required`，附带规则编号、段落、原因和命中证据，消息尚未进入 Outbox。Agent 确认原文符合本次需求后，使用同一 `deliveryId` 重发，并把 `styleValidation` 改为 `0`。这次跳过不修改角色绑定，后续发送恢复默认校验。

通用校验接口只分析文本，不发送消息：

可执行 operation ID 为 `manager.language-style.validate`，以目标 Manager 的活动目录为准。请求正文上限 512 KiB；正文去除首尾空白后最多 200,000 个 UTF-16 码元。文件地址在目标 Manager 所在电脑解析；`scope` 默认 `outbound_message`，`prompt` 保留原有字符串转换和截断规则。HTTP 200 的 `data.status` 可能是 `passed`、`failed` 或 `unavailable`，应同时读取 `passed` 与具体校验结果。

```http
POST /api/language-style/validate
```

```json
{
  "text": "待检查正文",
  "styleSkillUrl": "file:///path/to/style-skill",
  "scope": "outbound_message",
  "prompt": "可选的来源问题"
}
```

接口返回 `passed`、`status`、`violations`、`checkedRuleIds` 和 `skippedRuleIds`。Codex Stop Hook 使用同一接口，只在校验不通过时提示，不阻止或改写 Codex 输出。

当前渠道和必填目标：

| `channel` | `params` 必填目标 |
| --- | --- |
| `napcat` | `target=group + groupId`，或 `target=private + userId`。群聊必须显式提交 `replyToMessageId`：能取得来源消息时尽量填写真实消息 ID；明确不引用时填写空字符串 `""`。引用消息含图片时，`replyImageDescriptions` 必须按原图顺序逐张填写图片内容和想表达的意思；缺失、数量不符、空泛描述、图片不可读或来源消息无法核对都会在进入幂等发送前报错。完全省略 `replyToMessageId` 也会在进入 Outbox 前返回可行动错误。同一来源消息在 10 分钟内已有成功回复时，新的改写默认返回 `409`；只有确有新增事实的后续回复才显式填写 `allowAdditionalReply=true`。 |
| `wecom` | `chatId` |
| `feishu` | `chatId` |
| `weixin` | `sessionId` |
| `rabilink` | `targetDeviceIds` 或 `targetDeviceKinds`；非主动发送还要 `sourceMessageId` |
| `speech` | 可选 `sessionId`；该渠道只代表 RabiSpeech 合成/播放，不代表 QQ 已发送 |
| `fennenote` | `sessionId`、`mode=message/playback` |
| `role_panel` | `roleId` |
| `plan_feedback` | `roleId`、`planId`、`kind=guidance/approval` |

Route 的消息端输出策略仍会检查开关、支持的 payload 和允许的文件根目录。请求中的 `channel` 是唯一发送管道；Route 原有 `outputAdapter`、来源消息类型和 `replyContext` 都不能把它改成另一渠道。

### 消息处理需求与看板接口

启用消息处理 Agent 后，Manager 会给每个已投递的消息组分配 `messageProcessingRequirementId`，并把它放进 AgentPacket 的 `replyContext` 和消息处理任务说明。Agent 必须通过结构化接口结束本轮，不能只在 Codex 最终输出里说“已处理”。

```http
POST /api/message-processing/requirements/:requirementId/outcome
```

直接回复时先提交决定，使需求进入 `awaiting_send`，再完成“发送前上下文核对”，最后调用明确发送接口。Manager 只有在 `channel` 与原消息端一致、结果为 `sent`，且 QQ 等渠道带真实发送标识时才关闭看板项：

```json
{
  "decision": "reply",
  "reason": "用户明确要求确认命名和预制位置"
}
```

发送前不能只依赖 AgentPacket 创建时附带的最近消息，因为处理期间群里可能已经有人回答，或者另一名 Agent 已经发过同义回复。先读取 Manager 当前保存的有界双向消息：

```http
GET /api/message-processing/requirements/:requirementId/send-context?sourceMessageId=:sourceMessageId
```

单条回复必须传本次准备引用的 `sourceMessageId`。响应保留有界上下文，并把 `requiredReviewIds` 缩小为该主消息和从消息记录解析出的明确回复链；同一聚合需求里的其它消息仍参与上下文版本计算，但不要求逐条声明为本次正文依据。Agent 判断拟发送内容仍合适后，把这次精确发送请求作为 `proposedSend` 提交审核：

来源消息较早、已超出近期窗口时，Manager 只会从该需求所属角色的正式 `group-messages.jsonl` 恢复同 Route、同 `sourceMessageId` 的唯一记录。找不到、出现重复记录或 Route 证据冲突时，GET 失败关闭，不会扩大到其它群或其它历史需求。

上下文读取使用同一有界交互读池。发送校验才额外恢复完整来源和附件证据，并与最近上下文合并在一次读任务中；GET 和审批不增加这项额外恢复。最近窗口沿用 80 条、24,000 字符预算，必要时允许附加 1 条精确来源；记录与来源、附件元数据合计的 UTF-8 JSON 最多 1 MiB，超限拒绝，不截断证据。读取前后发现相关文件清单或元数据变化会失败关闭；这不是跨文件原子快照。

等待结束后重新读取需求并核对版本、来源归属、凭证有效期、审查会话、上下文版本和发送指纹。变更或读取失败要求重新审查，不自动循环校验。发送入口冻结请求；校验成功或失败后都权威重读同一 `deliveryId` 回执。只有已持久化的 `completed` 回执且包含结果才交原幂等发送服务核对指纹与发送者后重放。`reserved`、`sending`、`uncertain` 不能借此发起新发送；重放期间回执消失也不会重新发送。保留原 `deliveryId` 并查询回执，不以新 ID 绕过未决状态。

```http
POST /api/message-processing/requirements/:requirementId/send-context
```

```json
{
  "contextVersion": "<GET 返回的版本>",
  "reviewedContextIds": ["<本次 sourceMessageId 和明确回复链对应的 requiredReviewIds>"],
  "reviewedByThreadId": "<当前完整会话 ID>",
  "reason": "群里尚无人回答，拟发送内容仍对应当前问题。",
  "proposedSend": {
    "deliveryId": "send-example-001",
    "sender": {
      "agentType": "primary_persona",
      "sessionId": "019f0000-0000-7000-8000-000000000001"
    },
    "routeId": "main",
    "channel": "napcat",
    "params": {
      "target": "group",
      "groupId": "456",
      "instanceId": "default",
      "replyToMessageId": "123"
    },
    "payload": {
      "type": "text",
      "text": "收到，我来处理。"
    },
    "tracking": {
      "requirementId": "message-requirement-001"
    }
  }
}
```

审核通过后，把返回的 `sendContextReviewToken` 加入 `tracking`，并原样发送同一请求。凭证两分钟后失效；审核后出现新消息、需求状态改变、发送者会话改变，或目标、引用消息、正文发生变化时，Manager 都会拒绝发送并要求重新读取上下文。已有 Agent 回复同一来源消息时，改写措辞仍视为重复；确有新增事实的后续说明必须显式填写 `allowAdditionalReply=true` 和原因。

受跟踪发送在引用和图片检查阶段只使用本次审批绑定的精确正式来源证据。需求里过时的 `conversationKey` 或 `replyContext.groupId` 不能把来源改到另一群；正式群、Route、实例与发送目标不一致，来源记录不唯一，或图片附件没有标为已审核时都会拒绝发送。普通未跟踪发送仍按原 Route 历史查找，不使用这项恢复。

这项检查适用于所有 Agent 类型。只要 `replyToMessageId` 指向已登记消息处理需求的来源消息，主角色或其它 Agent 也不能省略 `tracking.requirementId` 绕过看板和发送前核对。

普通群讨论可以决定不回复，但必须说明原因。直接 @、直接回复、私聊和计划进展通知不能用泛化的 `agent_judgement` 关闭，只接受重复、他人已回答、消息撤回、来源无效等受限原因：

```json
{
  "decision": "no_reply",
  "reasonCode": "answered_by_other",
  "reason": "群内已有成员给出完整答案"
}
```

如果后续同题消息已经改变或补全原消息，可以使用 `reasonCode=superseded_by_followup`，但原因中必须写明取代它的后续消息 ID 或真实发送回执，不能只写“后面处理了”。

只有图片、视频或文件而没有文字问题的消息，在附件已经下载核对并写入关联计划后，可以使用 `reasonCode=attachment_consumed`；必须同时提交 `planId`，并在原因里保留原 `sourceMessageId`。含有文字问题的消息不能使用这个原因跳过回复。

Manager 不判断群消息的业务含义。每个新消息需求在关闭或准备回复前，消息处理 Agent 都必须核对原消息、附件和必要的回复链，并提交 `projectFactAssessment`：

新登记的消息需求还带有 `source.evidenceReviewRequired=true`。Manager 会在 `source.messageIds`、`source.replyChainMessageIds` 和 `source.attachments` 中保留聚合需求的完整证据。NapCat 图片会在收到时立即保存到运行目录，并通过 Desktop IPC 作为 `localImage` 随当前任务输入；只看到 CQ 代码、文件名或 URL 不算看过图片。准备回复或关闭前，outcome 必须同时提交：

```json
{
  "sourceEvidenceReview": {
    "reviewedMessageIds": ["source-message-id", "quoted-message-id"],
    "replyChainChecked": true,
    "attachmentReviews": [
      {
        "attachmentId": "source-message-id:image:1",
        "status": "reviewed",
        "observation": "图中是动态文案底框，当前文字长度明显短于底框最大宽度。"
      }
    ],
    "evidence": "已核对当前消息、引用消息和随任务附带的图片。",
    "reviewedAt": "2026-08-11T12:00:00.000Z",
    "reviewedByThreadId": "完整消息处理任务 ID"
  }
}
```

`reply` outcome 可以先提交已经核对的证据并进入 `awaiting_send`。POST send-context 会根据 `proposedSend.params.replyToMessageId` 重新计算精确子集：本次主消息、它的明确回复链，以及被引用消息自带或被正文明确提到的附件。`sourceEvidenceReview` 和 `projectFactAssessment` 必须覆盖这个子集。群引用回复的来源归属只在 `kind=message_reply` 中计算；`plan_progress_notification` 等派生通知不拥有原群消息的引用回复权。同一 Route、同一消息组和同一来源消息的历史重复只允许 `createdAt` 最新的 canonical `message_reply` 继续审批；没有 `message_reply` 时失败关闭，不能由计划通知承接。不同消息组、不同 Route、最新项不唯一、回复链记录缺失、相关附件为 `unavailable`，或正文依赖了未纳入事实核验的消息时同样失败关闭。同一聚合需求中无关消息的不可用附件不会阻止这条回复。`no_reply` 关闭整个需求时仍必须覆盖全部消息和附件。这个证据核对与项目事实判断分开保存：前者证明 Agent 看了什么，后者记录 Agent 如何判断长期项目事实。

先通过 `GET /api/message-processing/requirements/{requirementId}` 读取需求。响应里的 `knowledgeMatches` 是 Manager 根据角色计划和记忆的标题、ID、关键词生成的候选关联。Agent 必须读取每个候选项，并逐项调用 `POST /api/message-processing/requirements/{requirementId}/knowledge-callback`。

回调的 `result` 可使用 `unchanged`、`updated`、`created`、`not_relevant`、`deferred`；`responseAction` 可使用 `none`、`reply`、`discuss`、`handoff`。`unchanged` 也必须提供具体核对依据。`updated/created` 必须提供 `recordType`、`recordId`、`verifiedAt`，而且目标计划或记忆必须包含原消息 ID，Manager 才会接受。`deferred` 不是最终结果。

Manager 从投递时起为未完成回调设置一小时期限。到期后，它会把缺失项再次投给原消息处理 Agent，并重新设置一小时期限。若 `knowledgeMatches` 为空，Agent 仍须从附件、回复链和消息对象提取至少两组同义关键词主动查询，不能把未命中直接当成无需处理。

```json
{
  "projectFactAssessment": {
    "status": "critical",
    "reviewedMessageIds": ["msg-schedule-1"],
    "replyChainChecked": true,
    "evidence": "原文是内部上线目标，措辞为大概按照，不是公开定档。",
    "assessedAt": "2026-08-05T06:00:00.000Z",
    "assessedByThreadId": "完整消息处理任务ID",
    "facts": [{ "kind": "schedule", "evidence": "示例项目暂以2030年10月15日为内部目标，尚未正式定档" }]
  }
}
```

`status=none` 表示 Agent 已核对并判断没有需要长期保存的项目事实；此时不能携带 `facts`。`status=critical` 必须携带至少一条 `facts`。Manager 只校验结构、消息 ID 覆盖和状态，不使用关键词替 Agent 判断。

当 Agent 判断消息包含上线/公测排期、版本范围、批准/否决、负责人变更、取消/延期或发布版本等项目事实时，即使无需群内回复，也不能直接关闭。Agent 应把事实写入计划、绑定记忆或明确的项目文档；随后在 outcome 中同时提交记录证据：

```json
{
  "decision": "no_reply",
  "reason": "群内无需重复发言，但内部上线目标已经写入统一包计划。",
  "criticalFactDisposition": {
    "status": "recorded",
    "record": {
      "type": "plan",
      "planId": "plan-example-release"
    },
    "evidence": "messageId=msg-schedule-1；已核对原文和回复链，并更新计划与绑定记忆。",
    "verifiedAt": "2026-08-05T06:00:00.000Z"
  }
}
```

已有同一记录时使用 `status=duplicate` 并提供带类型的 `record`、证据和核对时间。计划使用 `{ "type": "plan", "planId": "..." }`，记忆使用 `{ "type": "memory", "memoryId": "..." }`，项目文档使用 `{ "type": "document", "relativePath": "docs/..." }`。文档路径必须相对于当前项目，绝对路径和跳出项目目录的路径会被拒绝。尚未完成判断或记录时只能 `handoff` 给秘书、计划 Agent 或主角色，`reply` 和 `no_reply` 都会被 Manager 拒绝。消息处理看板的 `factAssessmentOpen` 用于发现尚未完成 Agent 语义判断的需求，`criticalFactOpen` 用于发现已判断为项目事实但尚未登记完成的需求。

Manager 还会按 `record` 的类型读取对应计划、记忆或项目文档，确认记录真实存在并至少包含一个原始群消息 ID。仅提交一个看似有效的业务 ID、路径，或只在 `evidence` 中自述“已更新”，都不能关闭事项。

转交秘书、计划 Agent 或主角色时，调用 `/api/agent/threads` 的 `send` 动作，并增加结构化字段。Manager 只在目标 Desktop owner 接受后把看板改为“已转交”；如已确定计划，应同时传 `planId`，让后续计划进展能够回到原群或私聊：

```json
{
  "action": "send",
  "threadId": "<target-task-id>",
  "cwd": "C:/Path/To/Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "<message-agent-task-id>",
    "sessionName": "当前消息处理任务名称"
  },
  "sourceThreadId": "<message-agent-task-id>",
  "sourceAgentType": "message_processing",
  "prompt": "请处理这个计划事项，并把结果返回来源消息处理任务。",
  "messageProcessing": {
    "requirementId": "<requirement-id>",
    "outcome": "handoff",
    "targetAgentType": "plan_agent",
    "planId": "<plan-id>",
    "planTitle": "<plan-title>"
  }
}
```

不需要额外接口。上述请求会直接返回投递结果。只有下面三个值同时成立，才表示目标 Codex Desktop 任务已经接收消息；这不表示对方已经完成业务：

```json
{
  "code": 0,
  "status": "delivered",
  "delivery": {
    "status": "delivered",
    "targetThreadId": "<target-task-id>",
    "acceptedBy": "codex_desktop_owner",
    "action": "started",
    "transport": "desktop-ipc"
  },
  "handoff": {
    "status": "recorded",
    "requirementId": "<requirement-id>"
  }
}
```

缺少 `prompt`、`sourceThreadId` 等参数时，同一次响应返回 `code=-1`、`status=failed`，并在 `error.field`、`error.message` 和 `error.retryable` 中说明原因。目标任务已经接收、但消息处理看板记录失败时，响应为 `status=delivered_tracking_failed`：此时不得再次向目标任务发送同一内容，只处理或上报 `handoff.status=tracking_failed`。

维护者和 WebGUI 可读取同一份状态：

```http
GET /api/message-processing/board?routeId=<gateway-id>&limit=100
```

返回项包含处理阶段、来源消息组、处理任务、转交、决定、发送回执、失败、超时和“Agent 已空闲但没有提交结果”标记。该接口是 Manager 状态的只读视图，不从日志重新推断业务状态。

### 受控外发幂等回执

`deliveryId`、`sender.agentType` 和 `sender.sessionId` 都是发送接口的必填字段。Manager 会在进入 Outbox 前把 reservation 持久化到运行期 `data/agent-send-idempotency/`；完成结果会原样保存发送者身份。同一个 `deliveryId` 和相同请求只执行一次，完成后重复 POST 返回原 `sent/draft/blocked/failed` 结果。相同 ID 携带不同发送者或其它不同请求返回 `409 conflict`，`reserved/sending/uncertain` 状态也失败关闭，不会自动重发。

NapCat 群回复另按 `routeId + groupId + replyToMessageId` 做短时保护。某条被引用消息在 10 分钟内已经成功收到回复时，换 `deliveryId`、换 Agent 或换一种说法再次发送都会被拒绝；Manager 重启后仍从近期成功回执恢复这项判断。确有新证据必须补充时，调用方可以显式提交 `params.allowAdditionalReply=true`，并对这次额外回复负责。这个字段不能用于绕过普通重复发送保护。

调用方在 POST 超时或收到空回执后，应先查询原 ID。不存在的回执返回 HTTP `404` 和 `idempotency.state=missing`；`in_progress` 继续回读，`uncertain` 或 `conflict` 禁止自动重发。只有原 `deliveryId`、原 payload 完全不变，并且 Manager 从同一 Route 的 Outbox 明确确认没有请求记录和终态记录时，才允许一次受控重试。Outbox 已记录请求但没有终态、记录的 payload 摘要不同，或受控重试仍没有终态时，都转为 `uncertain`：

```http
GET /api/agent/send/receipts/:deliveryId
```

原 ID 的 `in_progress` 表示持久回执尚无终态且执行租约仍活跃，不是字节进度。原执行已结束或租约过期但没有终态时，只读查询返回 `uncertain`，不改写持久回执。文件上传成功但附带文字未确认时，不能把整个请求标成成功。禁止换 ID 自动重发。

回执维护使用 `POST /api/agent/send/receipts/:deliveryId/verify`（只读核验）或 `POST /api/agent/send/receipts/:deliveryId/settle`（凭完整原发送证据受控结算）。JSON 正文必须且只能包含 `{ "originalRequest": <原始 POST /api/agent/send 请求> }`；保留全部原字段及原 deliveryId，摘要不一致返回冲突。这两个接口均不发送文件或补发文字。`platformVerification=unknown` 不证明未送达；缺少完整原证据时不能结算。`503 AGENT_SEND_MAINTENANCE_UNAVAILABLE` 表示运行版本未装配维护能力，不是 QQ 拒绝发送或功能许可不足。

核验诊断用 `evidence.historyState` 区分 `missing`、`read_failed`、`oversized`、`changed`、`damaged`、`request_not_found`、`terminal_missing` 和 `completed`。可信历史已找到原请求但没有整次终态时是 `reason=terminal_unproven`，不是读取失败。`binding_missing` 与 `missingBindingFields` 表示原上传 owner 记录确实缺字段；`binding_capability_unavailable`／`platform_capability_unavailable` 表示处理器未装配相应能力，不能解释成远端 Agent 身份错误。原账号及绑定 revision 仅从原 ID 和摘要匹配的 owner 上传记录读取；旧记录缺失时不能拿当前账号补造。新上传记录在发送当时前后核对身份及配置后保存证据；文件存在仍不证明内容 SHA 或配套文字。`state=verified` 只表示核验动作完成。

连接器 0.2.12 的 `POST /api/agent/send` 默认沿用文件上传的 30 分钟等待预算，覆盖文件校验和平台上传；显式 `--timeout-ms` 仍优先。取消或超时不证明发送失败，必须按原 deliveryId 查询回执，不能自动重放。NapCat 失败回执保留动作、HTTP 状态、retcode 或安全传输错误码；不返回原始上游文字、凭据或主机路径。历史通用 502 无法补造缺失的底层诊断。

上传和外发分开确认：`PUT /api/agent/uploads/:uploadId` 上传原始字节；同路径 `GET` 只回读已提交文件元数据，不提供百分比、速率或 ETA。完成上传后以 `payload.fileId` 和 `payload.fileSha256` 调用 `POST /api/agent/send`，再以上述原 deliveryId 查询外发回执。

如果只有消息端回执 ID，可以按渠道反查最多 100 条匹配记录：

```http
GET /api/agent/send/traces?channel=napcat&sentMessageId=:platformMessageId&routeId=:optionalRouteId
```

返回项包含 `deliveryId`、完成时间、Route、目标和 `sender.agentType + sender.sessionId`。旧回执没有发送者字段，因此只能从启用本合同之后的新发送记录追溯。当前字段是调用方声明并由 RabiRoute 持久保存的来源；它用于审计，不等同于对 Agent 会话的加密认证。

只有回执返回 `status=sent` 且包含目标通道要求的真实标识（QQ 文本为 `sentMessageId`）时，调用方才能继续做平台回读并把业务状态标成已发送。`deliveryId` 只提供 Outbox 请求幂等，不代替 NapCat/外部平台的真实存在验证，也不是自动重试队列。公开示例应使用占位 ID，不把运行期回执文件提交到仓库。

### 语音消息端角色回复

当来源上下文显示 `routeKind=voice_transcript`、`adapterType=speech` 和 `characterTtsDialogue=true` 时，本轮来自 RabiPC 语音消息端。Agent 使用注入模板调用 `/api/agent/send`，明确填写 `channel=speech`、当前 `routeId`、`params.sessionId` 和文本 payload。Outbox 从 Route 读取角色、声线、TTS 模型、语言和自动播放设置；成功时表示请求进入 RabiSpeech 合成或主机级 FIFO，不表示 QQ、企业微信或其它渠道已经发送。

这个状态只由 `speech` / RabiSpeech 消息端的转写事件注入。不要把 QQ、角色面板或其它文字入口手工标记成语音状态，也不要绕过 Outbox 直连 worker，否则会丢失来源绑定、策略检查和会话隔离。

手机音频流虽然复用同一套 RabiSpeech ASR，但来源是 `rabilink`。发送回原设备时必须明确填写 `channel=rabilink`、`params.sourceMessageId` 和 `params.targetDeviceIds`；注入模板只使用稳定 `sourceDeviceId`，不会把临时 `sourceStreamId` 当设备。它不是 `speech` 发送，因此不会误触发独立语音端的 TTS/FIFO 规则。

### 声纹证据与角色身份解释

RabiRoute 投给角色的语音记录只保留不透明声纹/聚类 ID、`Speaker 1` 等分段标签、分数和判定证据，不携带人名，也不把任何声纹标成“用户”。收到记录的角色应结合自己的关系、记忆和会话上下文解释身份；不同角色可以对同一声纹形成不同关系认知。

每条新语音同时携带 `sourceHostId/sourceHostName`。声纹 ID 只在产生它的处理主机范围内解释，因此角色身份键是“处理主机 + 声纹 ID”，不能把两台 PC 恰好相同的 cluster 字符串当成同一个人。角色自己的结构化解释以追加式文件 `data/roles/<RoleId>/voice/voice-identities.jsonl` 为真源；它会随角色目录同步，而 RabiSpeech、Manager 和 Route 都不会替角色填写 `displayName`、`relationship` 或 `isUser`。

查询或更新当前角色的解释：

```http
GET /api/roles/:roleId/voice-identities
GET /api/roles/:roleId/voice-identities?sourceHostId=<host>&voiceprintId=<voiceprint>
PUT /api/roles/:roleId/voice-identities
Content-Type: application/json
```

```json
{
  "sourceHostId": "example-host-guid",
  "sourceHostName": "Studio PC",
  "voiceprintId": "unknown-cluster-7",
  "displayName": "老板",
  "relationship": "我的用户",
  "isUser": true,
  "aliases": ["老板"],
  "notes": "由当前角色结合持续会话确认"
}
```

`isUser` 没有系统默认值；未知时应省略，而不是写成 `false`。重复提交相同解释不会新增事件；修正会追加新事件，`deleted=true` 会追加 tombstone，不会原地改写共享历史。每个新事件会自动记录它收敛的上一组事件，调用方不需要也不能手工维护父事件。

两台 PC 从同一共同版本并发修改同一个 `sourceHostId + voiceprintId` 时，JSONL 并集合并会保留两个事件头，不再按文件顺序静默选择最后一条。`GET` 返回 `conflicted=true`、`conflictFields` 和带 `eventId/deleted` 的 `conflictCandidates`。如果 `isUser` 或删除状态发生分歧，`voice-transcripts` 把相关分段归为 `conflict`；只有称呼、关系或备注分歧但所有分支的 `isUser` 一致时，用户/他人分类仍可保留，同时关系资料继续标记待收敛。角色再次 `PUT` 自己确认的最终解释时，Manager 会自动 supersede 当前全部事件头，下一次多电脑同步即可收敛。AgentPacket 会提供 `voiceIdentitiesPath`、处理主机、全部声纹 ID、已知关系和待收敛字段；这些内容明确标记为“角色记录”，不是主机推断。

需要从一天或一段时间的会话中区分“当前角色确认的用户、其他人、未知或冲突声纹”时，使用角色级只读视图，而不是自行修改原始消息：

```http
GET /api/roles/:roleId/voice-transcripts?from=<ISO>&to=<ISO>&speaker=user&limit=200&includeArchives=true
```

`speaker` 可为 `user`、`other`、`unknown` 或 `conflict`。返回结果在读取时联结 `conversation/current.jsonl`（可选归档）与当前角色的 `voice/voice-identities.jsonl`，提供整条记录的 `personaClassification`、逐分段 `classification` 和匹配身份。`mixed` 表示同一录音包含多种分段结论。这个视图不把称呼或 `isUser` 回写到主机原始消息和角色会话账本；角色关系修正后再次查询会立即得到新解释。

响应中的 `matchedCount` 和 `summary` 都基于完整筛选结果计算，不受明细 `limit` 截断。`summary` 给出总录音/分段数、录音时长、说话人时长、`user/other/unknown/conflict` 分类统计、已解释时长和 `coverageRate`；`unresolvedVoiceprints` 按 `sourceHostId + voiceprintId` 汇总仍未知或冲突的声纹、分段数、时长和最后出现时间。它们只是读取时派生的覆盖率视图，不是新的账本，也不会写回角色文件。

当前路由消息明确询问声纹、说话人、“哪些是我/用户说的、哪些是别人说的”或全天录音归类时，AgentPacket 会把上述时间范围查询、四类 speaker 过滤、关系 GET/PUT 和追加事件规则注入当前角色任务；普通消息不携带这段说明。Agent 应执行当前请求所需的一次查询，不能周期轮询覆盖率；`unknown` 或 `conflict` 只能根据当前角色自己的会话、记忆和用户确认来收敛，不能直接采用主机候选名称或高分。

下面的本机接口仍作为 RabiSpeech 操作员诊断兼容入口：当人工已确认某条录音标签时，可以创建/复用诊断资料并绑定当前 `recordId + speakerLabel`。这些名字不会进入 RabiRoute 主机通用消息或角色账本，不能作为 Agent 判断用户身份的真源：

```http
PUT /api/speech/speaker-identities
Content-Type: application/json
```

```json
{
  "sessionId": "meeting-one",
  "recordId": "speech-0123456789abcdef",
  "speakerLabel": "Speaker 1",
  "displayName": "秋雨",
  "aliases": ["Qiu Yu"]
}
```

已知稳定人物 ID 时可传 `speakerId`，此时接口直接复用该资料；未传时按显示名和别名大小写不敏感查找，唯一命中则复用并合并别名，未命中则创建，多个资料同时命中会返回 `409`，要求调用方改用明确 ID。资料查找/创建、别名合并和 `recordId + speakerLabel` 绑定在一次本机注册表写入中完成，重复请求是幂等的。

人工入口仍位于 WebGUI「语音服务 → ASR 语音识别 → 说话人 / 声纹设置」，和 Agent 接口共用 `output/speaker-profiles.json`。界面按未知/已知说话人折叠，并为每个分段人物预览最近 10 句话，帮助人工确认或纠正。

这个接口写的是 RabiSpeech 本机诊断元数据和显式录音绑定。Manager 在通用消息入口删除人名，只转发不透明声纹/聚类证据；对应角色拥有“是谁、是不是用户”的最终解释权。只有能力发现明确返回已校准支持时，才可以把分数描述成声纹匹配证据，但仍不能把主机匹配直接等同于角色关系。

### Agent 触发多电脑角色同步

使用同一个 RabiLink 应用 token 的 PC 可以由本机 Agent 查询并显式同步：

```http
GET /api/persona-sync/peers
POST /api/persona-sync/sync
Content-Type: application/json
```

```json
{
  "peerId": "office-pc",
  "roleId": "Rabi"
}
```

省略 `roleId` 表示同步全部角色。同步器优先局域网直连，失败后经 Relay 受限中转。Agent 必须检查逐文件结果、`fileConflicts` 和 `semanticConflicts`；后者会在同一次同步响应中列出已成功并集合并、但仍有并发分支的语音账号兼容归类或通用身份关系。语音项包含处理主机、声纹、字段和事件候选；身份关系项包含记录类型、记录 ID 和事件候选，不需要另行轮询覆盖率。`conflicts > 0` 或 HTTP `409` 表示仍有待处理冲突，不能声称同步完成。

普通文件冲突由本机 Agent 使用 `GET /api/persona-sync/conflicts`、`GET /api/persona-sync/conflicts/content` 和 `POST /api/persona-sync/conflicts/resolve` 处理。解决动作支持 `keep_local`、`use_remote`、`use_merged`，并应携带列表返回的 `expectedLocalHash` 防止覆盖刚发生的新修改。三条冲突控制接口仅允许回环调用，不经 LAN listener 或 Relay 暴露。底层 manifest、文件读取、单文件 merge 和完整请求字段见 [多电脑角色数据同步](persona-data-sync.md)。

当当前路由消息明确提到多台电脑、角色/角色同步或 persona sync 时，AgentPacket 会把上述回环地址、当前 `roleId`、一次性执行要求和冲突判定直接注入绑定角色的当前任务；普通聊天不注入这段能力说明。默认只同步当前角色，只有用户明确要求时才允许省略 `roleId` 同步全部角色；peer 不唯一时必须先确认目标，不能猜测，也不能用轮询等待覆盖率。

NapCat 群聊始终需要提交 `params.replyToMessageId`。能取得来源消息时尽量填写真实消息 ID：

```json
{
  "deliveryId": "send-qq-progress-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主角色完整会话 ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": {
    "target": "group",
    "groupId": "456",
    "instanceId": "default",
    "replyToMessageId": "123",
    "replyImageDescriptions": [
      "图片展示动态文字较短时底框保持紧凑，并保留图标和文字间距。",
      "图片展示文字变长后底框随内容扩展，想表达背景需要自适应宽度。"
    ]
  },
  "payload": { "type": "text", "text": "【工会入口无响应】我先接手调查，有结论后继续引用这里同步。" }
}
```

Outbox 会在字符串消息前添加 OneBot `[CQ:reply,id=123]`，或在消息段数组前插入 `reply` 段。`replyImageDescriptions` 的数量必须与被引用消息的图片数量完全一致，并按消息中的图片顺序一一对应；每项都要写实际看到的内容和图片想表达的意思，不能只写“已查看”。发送成功后，RabiRoute 会在每张本机图片旁创建或追加图片同名的 `.md`，保存来源消息 ID、图片序号、Agent 类型、完整会话 ID、发送 ID、QQ 回执 ID 和本次描述。存档回执只返回映射文件，不把描述正文复制进运维追踪结果。

主动无源群消息应明确填写 `"replyToMessageId":""`，并保持 `"replyImageDescriptions":[]`，表示有意不引用；这时不会添加引用段。完全省略 `replyToMessageId` 会拒绝请求，并提示 Agent：能引用时使用来源 QQ 消息 ID，确实不引用时传空字符串。私聊不要求该字段。

发送本地 QQ 群文件时仍使用同一个发送接口：

```json
{
  "deliveryId": "send-qq-file-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主角色完整会话 ID>" },
  "routeId": "main",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "456", "instanceId": "default", "replyToMessageId": "123" },
  "payload": {
    "type": "file",
    "path": "C:/Path/To/Allowed/ReleasePkg/build.apk",
    "fileName": "build.apk",
    "text": "【构建包】版本、渠道和签名已确认，文件已上传。"
  }
}
```

对应 NapCat 策略必须支持 `file`。`messageAdapterPolicies.napcat.allowedFileRoots` 未配置或为空时不限制本地文件目录；用户设置非空列表时才按其真实目录限制，拒绝提示给出该配置及取消方式。RabiRoute 会校验文件存在、类型和真实路径，再调用 `upload_group_file`；成功结果包含 `sentFileName`，NapCat 返回稳定标识时还包含 `sentFileId`。如果文件上传成功但跟随的说明文本失败，返回仍为 `status=sent` 并在 `reason` 中说明文本失败，调用方只能补发文本，不能重复上传文件。

### 远端 Agent 上传后发送群文件（实验合同）

> 上传链路已通过本机真实 HTTP 与模拟 NapCat 集成、完整构建及 `0.3.4-4b5d30118b40` 部署健康核验；真实双机群文件尚未验收。先核对运行实例的 capabilities 与版本，不把本机模拟渠道测试当作真实群回执。

远端优先使用 Hook 提供的已安装连接器 `--api`；本机 Host 发现规则仅适用于 Manager 电脑，远端没有 Host 不代表 Manager 离线。用 `GET /api/lan-agent/capabilities` 发现操作，`GET /api/lan-agent/resources` 发现实际可读的文档与 references，再用 `/api/lan-agent/resources/read?id=...` 读取返回的 ID。公共合同含对应英文版，不能把 Markdown 任意链接当成可读取资源。连接器按内容摘要更新及首次 bootstrap/DSH reload 要求见 [远端接入与更新](./lan-rabi-agent-bootstrap.md#安装与发布)。

已使用独立节点凭据接入、并由总控批准的 primary Agent，可把远端文件上传到 Manager，再显式调用发送接口。CLI 从私有配置读取凭据和准确 Agent 身份；不使用共享 WebGUI Token，也不把凭据写到命令参数。上传不自动发送：

```bash
node rabi-agent.mjs --upload <file> --agent-type codex --id "<FULL_SESSION_ID>" --upload-id <UUID>
node rabi-agent.mjs --api GET /api/agent/uploads/<UUID> --agent-type codex --id "<FULL_SESSION_ID>"
```

`--upload-id` 是调用方预先保存的稳定 UUID，必填，不自动生成。底层请求为 `PUT /api/agent/uploads/<UUID>`，正文为文件原始字节，`Content-Type: application/octet-stream`，`Idempotency-Key` 必须与路径 UUID 完全相同；`x-rabiroute-file-name` 为 URI 编码的 basename（不含目录），`x-rabiroute-content-sha256` 为内容 SHA-256。鉴权沿用 Bearer 节点凭据和 `x-rabiroute-agent-type` + `x-rabiroute-session-id`。`GET` 同一路径回读元数据；成功结构如下，不返回 Manager 的本地 `path`：

```json
{
  "code": 0,
  "data": {
    "id": "00000000-0000-4000-8000-000000000001",
    "fileName": "report.zip",
    "size": 1234,
    "sha256": "<64 hexadecimal characters>",
    "expiresAt": "2030-01-02T00:00:00.000Z"
  }
}
```

#### 上传 Help 的局部机器可读合同

`GET /api/agent/help?path=%2Fapi%2Fagent%2Fuploads%2F%3AuploadId` 的 PUT/GET 帮助提供可选 `help.machineReadable`（`version:1`、`kind:partial-upload-contract`），定义位于 `src/manager/agentUploadContract.ts`。这不是全 API OpenAPI 文档，也不参与执行校验或授权。

- `request.path.uploadId.schema` 描述小写 UUID（版本 1–8、RFC variant）；`request.query.allowed=[]` 表示 Agent 目录不允许查询参数。
- `request.headers` 只列上传业务头，不是完整认证头合同。PUT 必填头必须单值；`idempotency-key.equalsPathParameter=uploadId` 表达跨字段相等，Content-Type 值不区分大小写但不接受参数，`content-encoding` 禁止。SHA-256 请求头允许大小写；回执统一小写。文件名先 URI 解码，再通过路由和存储的 basename、安全名称与 UTF-8 字节限制检查；这些语义未完整 schema 化。可选 Content-Length 由实现转成 Number、经存储核对非负安全整数及实际字节数。
- PUT `request.body` 为 `{kind:binary,mediaType:application/octet-stream,encoding:raw,emptyAllowed:true}`，**没有 JSON Schema**，不代表 JSON 字符串或 Base64。GET 为 `kind:none`，处理器不读取正文，不宣称主动拒绝所有带正文的请求。
- `responses["200"].schema` 是 JSON Schema 2020-12，只描述成功 JSON 正文 `{code:0,data:{id,fileName,size,sha256,expiresAt}}` 的字段结构，所有字段必填且不允许额外字段。PUT/GET 共用同一结构；GET 不提供上传进度、完整状态机、文件字节、owner 或本地 path。`scope:success-body-shape` 不意味着全部值语义或 HTTP 边界已被 schema 覆盖。

两项仍为 `contractLevel:baseline`、`coverage.exactRequestSchema=false`、`coverage.exactResponseSchema=false`。`coverage.missing` 与机器合同的 `missing` 一致，明确保留认证/授权边界、错误响应 schema、响应头、存储 DTO 值语义，以及 PUT 的文件名/流完整性/动态限额或 GET 的归属/过期/完整性检查。消费者不能凭 200 schema 的存在升级为 verified、绕过 owner 检查或重放上传。

上传错误保留原有字符串 `code`，并附带同值 `errorCode`、`help { method, path }`、`repair` 和 `retryable:false`。`retryable:false` 表示不能自动重放，不表示人工修正后永远不可再调用；415 按提示修正二进制格式，403 核对原身份和启停，409 或不确定结果先 GET 原 ID 核对，不换 ID 绕过。帮助链接不授予额外权限。408 `upload_timeout` 和连接中断 `upload_aborted` 有具体恢复提示，仍为 `retryable:false`；先 GET 原 ID，不自动重传。连接已断开时无法保证收到错误 JSON。

默认单文件额度为 2048 MiB（可配置），总量为 max(16 GiB, 单文件额度)、最多 100 个文件、TTL 24 小时；总量、数量和保留时间可通过[公开环境变量](./connection-access.md)调整；HTTP 上传总并发上限为 4，跨 owner 合计。上传来源用于审计与配额记账，不形成第二层读取许可；其他已鉴权连接可查询原上传 ID，并以 fileId 与 SHA-256 引用原文件。内容完整性、有效期、并发和容量仍按原合同检查。超时、503、响应不确定或 generation 变化后，保留原 UUID、文件内容和摘要，先重新发现并核对当前 `/meta`，再 `GET` 原路径核对 `id/fileName/size/sha256/expiresAt`，不自动重试 PUT 或换 ID。

如果磁盘权限或文件锁故障导致临时预留清理失败，系统保守保留其配额并记录审计，不删除可能活跃的数据。需修复存储故障，并在 Host 重启后再次触发回收；不保证任意存储故障都自动恢复。

大文件通过有背压的二进制流上传、落盘和增量 SHA-256 校验，不把完整安装包读入内存，也不使用 JSON/Base64 传包。上传期限为 30 分钟。可在「RabiLink → 配置」保存 `agentUploads.maxFileMiB`，整数范围 `1..8589934591`，默认 `2048`；值保存在 `data/Config.json`，重启 Manager 后生效。已鉴权连接也可通过 `PATCH /api/rabi/identity` 修改该配置；上传请求仍遵守服务器当前限制。Manager 不另加 2 GiB 硬上限；使用支持该额度的客户端。默认存储总容量至少容纳一个已配置的最大文件，存储容量、文件数和过期时间可通过[公开环境变量](./connection-access.md)调整。

受控集成测试已用 **734 MiB（769654784 字节）** 文件完成真实客户端 → loopback HTTP → 文件存储 → 模拟 NapCat 的上传和发送摘要核对；文件由 64 KiB 小块生成，测试禁止大于 8 MiB 的 Buffer 分配/拼接，接收端按块核对。用 `RABI_TEST_LARGE_UPLOAD=1` 启用 `src/manager/agentUploadFlow.test.ts` 的大文件用例，默认日常测试跳过。该结果不是 QQ 平台验收：真实 QQ/NapCat 的文件大小、账号及群权限、磁盘可读性和响应期限仍以实际渠道回执为准。旧连接器须按接入文档执行新版 bootstrap，已缓存旧 Hook 的宿主需重载；服务端增大配额不会升级旧客户端。

最短发送示例：先完成上述上传并确认回执，再把以下 JSON 经标准输入交给 `node rabi-agent.mjs --api POST /api/agent/send --agent-type codex --id "<FULL_SESSION_ID>" --body-stdin`。占位身份与目标替换为当前注入模板，`fileId` 使用上传回执 `data.id`；为本次发送保存独立、稳定的 `deliveryId`：

```json
{
  "deliveryId": "send-upload-example-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<complete-session-id>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": { "type": "file", "fileId": "00000000-0000-4000-8000-000000000001", "fileSha256": "<upload-data.sha256>", "text": "报告文件。" }
}
```

- 使用 `fileId` 时必须同时提交 `fileSha256=上传 data.sha256`（64 位小写十六进制），把引用绑定到原始内容，防止 TTL 到期后 UUID 复用改变旧引用的文件字节。发送 callback 在 lease 内核对实际 hash，不匹配即拒发。
- `payload.text` 可省略；`replyToMessageId` 必须是具体来源消息 ID 或明确不引用的空字符串，原引用核对和 tracking 要求不变。
- `fileId` 仅用于 `channel=napcat`、`target=group`、`type=file`，与 `path`/`url`/`fileName` 互斥；不能借此发送图片、语音或其它渠道。显示文件名（`displayName`）取自上传元数据，不由发送请求另行覆盖。
- Manager 内部可信 resolver 每次请求重新核对授权、归属、完整性和 TTL，并持有 inflight lease 防止在途文件被清理；不扩大 `allowedFileRoots`，原本地 `path` 流程及其根目录检查照旧。
- 渠道仍须允许发送并支持 `file`；发送者身份仍按投递合同核对。上传成功不是群发送成功，必须检查 `/api/agent/send` 的 Manager 与 NapCat 回执；发送不确定时查询原 `deliveryId` 回执。
- NapCat 已接受群文件但随后 caption 失败时，仍保留 `status=sent`，只补发文本，不重发文件。当前 NapCat 接口读取 Manager 交给它的文件路径；异机 NapCat 必须能够通过共享目录读取该路径。本功能只解决远端 Agent 到 Manager 的上传，不解决任意跨机 NapCat 文件可读性。
- 远端线程投递通过 Manager 持有的端点合同处理，支持 `responsePolicy: "none"`、`required`、`inReplyToRequestId` 正式回复以及远端到远端投递；来源必须来自原始认证 lease，目标必须是已启用的精确实例 Agent 会话，不接受请求正文自称的身份。旧连接、停用后重新启用、换会话或换 owner 均不能继承原授权。未支持精确 owner 执行的 Provider 失败关闭，不启动备用 Runtime。

当图片或文件已经作为计划附件存在时，可用 `payload.planAttachment` 按 ID 引用，不必先复制到 `allowedFileRoots` 里的目录：

```json
{
  "deliveryId": "send-plan-attachment-001",
  "sender": { "agentType": "codex", "sessionId": "<当前会话 ID>" },
  "routeId": "<exact-route-id>",
  "channel": "napcat",
  "params": { "target": "group", "groupId": "<group-id>", "instanceId": "<napcat-instance-id>", "replyToMessageId": "" },
  "payload": {
    "type": "image",
    "text": "[CQ:at,qq=<qq>] 截图见下。",
    "planAttachment": { "roleId": "<role-id>", "planId": "plan-...", "attachmentId": "<attachment-id>" }
  }
}
```

- `planAttachment` 只接受 `type=image` 或 `type=file`，与 `path`/`url`/`fileId` 互斥；`roleId` 为拥有该计划的角色角色 ID。
- Manager 每次请求从真实计划存储解析该附件，并再次核对解析结果仍位于该计划的附件目录内；计划或附件不存在、类型不符、逃出目录都拒发。它**不**扩大 `allowedFileRoots`，普通 `path` 流程的根目录检查完全照旧。
- 与 `fileId` 一样，信任边界是「按 ID 引用对象」，不是「任意路径可读」；未接入该 resolver 的运行环境会明确失败而不是退回读取原路径。

`payload.text` 中的 CQ 码按固定白名单解析为真实消息段，而不是按纯文本发送：

- 支持 `[CQ:at,qq=<QQ或all>]`、`[CQ:reply,id=<消息ID>]`、`[CQ:face,id=<表情ID>]`，参数值按 URL 解码；`at` 的 `qq` 必须是数字或 `all`。
- 其余 CQ 形态（`image`、`record`、`video`、`file`、`json`、`xml`、`forward`、`node`）会被明确拒绝，因为文本注入这些段会绕过渠道的 `payloadKind` 策略和 `allowedFileRoots` 校验；需要发这些内容请改用带 `path`/`url`/`planAttachment` 的类型化 payload。
- 无法识别的 CQ 样式 token（例如缺少必需参数）会从文本中剥离，不再作为字面文本进入群聊。正文里若要展示 CQ 字样，请改用全角字符或拆分书写。

Agent 可以主动向自己已经掌握的群号或企业微信群 chat id 发送推进消息，不需要引用原消息，但必须明确 `channel` 和目标参数。是否能发由消息端发送开关、消息端可用性和 payload 策略决定。

主动投递到 RabiLink 眼镜也使用同一个动作安全门，不要直接绕过到 Relay：

```json
{
  "deliveryId": "send-rabilink-active-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主角色完整会话 ID>" },
  "routeId": "RabiLink",
  "channel": "rabilink",
  "params": { "proactive": true, "source": "scheduler", "targetDeviceKinds": ["glasses"] },
  "payload": { "type": "text", "text": "该休息一下了。" }
}
```

`routeId` 必须指向启用了 RabiLink 输出策略且已配置 Relay 的 Route。主动发送必须明确 `targetDeviceIds` 或 `targetDeviceKinds`；普通来源回复还要提供 `sourceMessageId`。

企业微信群聊也使用同一个发送接口。Agent 必须填写 `channel=wecom` 和 `params.chatId`；来源上下文里的 `wecomReqId` 只用于可选关联，不再决定渠道。

企业微信回复示例：

```json
{
  "deliveryId": "send-wecom-001",
  "sender": { "agentType": "primary_persona", "sessionId": "<当前 Codex 主角色完整会话 ID>" },
  "routeId": "main",
  "channel": "wecom",
  "params": { "chatId": "wrCHATID", "userId": "zhangsan", "reqId": "REQ_ID" },
  "payload": { "type": "text", "text": "收到，我来整理一下。" }
}
```

返回示例：

```json
{
  "code": 0,
  "ok": true,
  "status": "sent",
  "channel": "napcat",
  "routeId": "main",
  "targetType": "group",
  "groupId": "456",
  "instanceId": "default",
  "sentMessageId": "124"
}
```

被阻断示例：

```json
{
  "code": -1,
  "ok": false,
  "status": "blocked",
  "reason": "Only current QQ group/private source replies can be sent automatically.",
  "draft": {
    "text": "这条只能作为草稿。",
    "targetType": "group",
    "groupId": "456"
  }
}
```

## 远端 Agent 的明确目标与列表查询

先用当前 Manager 的 `GET /api/lan-agent/instances` 查询电脑及 Agent 目录，取得 `instanceId`、`agentId`、`provider` 和连接状态。`agentId` 是连接器中的 Agent 配置身份，完整会话 ID 另用 `threadId` 传递，两者不能混用。

会话列表使用 `POST /api/lan-agent/instances/{instanceId}/agents/{agentId}/threads`：

```json
{"action":"list","agentAdapter":"codex","limit":100,"offset":0}
```

按 `limit/offset` 翻页读取；DSH 使用 `agentAdapter:"dsh"`。取得真实完整 ID 后，调用 `POST /api/lan-agent/instances/{instanceId}/agents/{agentId}/tasks`：

```json
{"provider":"codex-desktop","threadId":"<完整会话 ID>","message":"<任务正文>","cwd":"<远端执行目录>","idempotencyKey":"<稳定投递键>"}
```

这里 AgentType 对应 `provider`，会话 Id 对应 `threadId`；每次投递都必填。省略身份会失败，不选择 `default`、第一个类型或配置中的会话，不通过改绑配置决定本轮目标。已有 Agent 目录身份保留；旧单任务配置不再自动生成 `default` Agent。配置好的消息路线读取自己的目标后，也必须显式提交本轮类型与会话 ID。

旧 `POST /api/lan-agent/nodes/{nodeId}/tasks` 同样必须传 `targetAgent`、`threadId` 和 `message`，`agentId` 是可选的目标元数据，不再推断类型。幂等键绑定完整目标与正文；换目标必须是独立请求，结果不确定时先核对原操作。连接器 0.2.3 通过 hello 声明 `taskTargeting:"explicit-session-v1"`；未声明的旧客户端拒绝任务投递并提示升级，防止其忽略新字段后仍投向固定会话。电脑接口继续按原合同使用。

## Codex 正式线程桥

### 精确 ID 返回 404 后的只读发现

以下是调用方的排障流程，不会自动改绑或重发：

1. 先区分资源 404 与通用 route not found。后者先从当前 help 核对路径、方法和可用能力；超时、权限拒绝、未加载或索引未就绪不证明目标不存在。
2. 在原机器、Agent 端和工作区范围内，使用 `action=list`，以已知名称作为 `query` 搜索。无明确匹配时省略名称条件，读取最近更新或当前活动的会话；只使用接口实际支持的字段，根据返回的 `updatedAt` 和状态筛选，并按 `nextOffset` 分页。不要凭空添加排序、活动过滤或扫描参数。
3. 对候选逐一 `action=read`，核对完整 ID、工作区、业务目标、最近上下文与原计划绑定。原 ID 仍存在时继续它；不同 ID 只有在确认与原任务的关系且符合用户授权后才续接，并记录新旧 ID。名字相同或更新时间最新只用于收窄候选；剩余歧义再请用户选择。
4. 计划详情 404 时，在同一角色通过计划名称搜索和近期计划列表查找，必要时查询归档，核对 `planId/taskBinding` 和历史内容；不重建空计划替代原记录。
5. 发现过程不创建任务、不修改绑定、不发送消息。已有 `202/delivery_unconfirmed`、超时或其它不确定投递时，保留原 `deliveryId`、来源与目标，先核对原回执和实际接收证据；搜索结果不能作为换目标重发的依据。查询能力不可用时记录具体缺口并继续可独立完成的工作。

返回提示应列出当前可用的名称搜索、近期列表或归档查询等下一步。若发现原对象确实存在却仍无法读取，继续调查并修复原接口或存储问题，不能用候选列表掩盖该故障。

### 外部 Agent 的来源与稳定投递 ID

`POST /api/agent/threads` 的 `action=send` 同时核对发送方和接收方。顶层 `agentAdapter/threadId` 是目标；`sourceThreadId` 和 `messageSource` 是调用方的真实来源，不能填成目标任务来补齐必填字段。

普通 Agent 来源至少提供 `messageSource={type:"agent",agentAdapter,sessionId,sessionName}`、`sourceThreadId`、`sourceAgentType` 和 `responsePolicy`。`sourceThreadId` 必须等于 `messageSource.sessionId`，来源 adapter 必须属于实际 owner；`plan.sourceAgent` 只有在该真实来源可核验时才成立。Owner 核对会话并提供当前名称；正文声明、显示名称和职责标签本身不证明归属。已鉴权连接有可信来源身份时，声明必须与原身份一致，不从正文中的 `remoteSource` 或 owner 字段建立认证。

会话 ID是不透明字符串，必须原样保留完整值。`send` 的端点校验要求非空、无首尾空白、最多 4096 个 JavaScript 字符单元，且不含 NUL、换行或 Unicode 行分隔符；不要求特殊编码，也不从 ID格式推测 provider。来源缺失返回 HTTP 400，`error.code=AGENT_SESSION_ID_REQUIRED`、`error.field=sourceThreadId` 和具体 `repair`；目标错误对应 `threadId`。

`create` 与本机 `send` 对 Codex、DSH 来源仍按任务 ID 形状核对：Codex 为任务 UUID，DSH 为 `session-` 加 UUID，这类 `sourceThreadId` 最长 512 个字符。以 `grokBot:` 开头且能解码的规范会话 ID 是独立来源身份，不套用上述形状；Manager 向 Grok Bot owner 核对，owner 缺失、名称空或无法解码时失败关闭。这类 `sourceThreadId` 最长 4096 个字符，与端点 `send` 的不透明会话上限一致。`type=message_adapter` 的 `conversationId` 仍最长 300 个字符；更长的 Bot 会话必须使用 `type=agent`。

`system` 是消息展示语义，不能作为公共 `send` 的免来源入口。只有 `eventType/eventName/eventId` 而没有可核验 Agent owner 的系统请求会失败；补上目标 Codex ID也不能建立来源。内部 Manager 系统事件沿用各自的受管事件合同。无来源会话的外部服务须接入自己的服务 owner，不伪造 Desktop 会话。Grok Bot 的配置、发现和传输边界见 [Grok Bot Agent 端接入](grok-bot-agent-adapter.md)。

Bot → Codex 的来源示例如下。占位值须替换成各自 owner 确认的完整会话 ID；两者是不同端点：

```json
{
  "action": "send",
  "agentAdapter": "codex",
  "threadId": "<目标 Codex 完整会话 ID>",
  "deliveryId": "bot-to-codex-check-001",
  "prompt": "请确认本次合同复测消息已收到。",
  "sourceThreadId": "<scan 返回的来源 Bot 完整会话 ID>",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "grokBot",
    "sessionId": "<scan 返回的来源 Bot 完整会话 ID>",
    "sessionName": "Integration Bot session"
  },
  "responsePolicy": "none"
}
```

Bot 创建 Codex 或 DSH 会话时使用同一个已核验来源。顶层 `agentAdapter` 是要创建的目标（`codex` 或 `dsh`），不是 `grokBot`。Grok Bot 自己的会话仍不能通过线程桥创建、重命名或打开。调用方复制扫描返回的完整 ID，不自行编码；提交的 `sessionName` 会被 owner 当前名称覆盖。

```json
{
  "action": "create",
  "agentAdapter": "codex",
  "title": "Bot 发起的任务",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "prompt": "请处理这件新任务。",
  "sourceThreadId": "<scan 返回的来源 Bot 完整会话 ID>",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "grokBot",
    "sessionId": "<scan 返回的来源 Bot 完整会话 ID>",
    "sessionName": "任意旧名称，会被 owner 名称覆盖"
  }
}
```

DSH 目标把 `agentAdapter` 改为 `dsh`，来源字段保持不变。

公共端点投递支持请求体中的稳定 `deliveryId`：非空、无首尾空白、最多 100 字符，不含 NUL 或行分隔符。调用方在第一次请求前保存 ID及完整载荷；Manager 按真实来源隔离幂等键，持久保存原目标、请求摘要、执行参数和受理状态。相同来源、ID及载荷复用原操作；同 ID不同目标或载荷返回 `AGENT_DELIVERY_ID_CONFLICT`，`error.field=deliveryId`。省略该字段会为每次新请求生成新 ID，不能保证调用方重复 POST 幂等。计划 API 的 `Idempotency-Key` 头不替代此字段。

返回的 `communication.deliveryId` 是 Manager 的实际投递标识，可能与调用方提交的 ID不同；保存它供 `reconcile_delivery` 使用。`prepared` 的同键重试可以完成尚未开始的原投递，`dispatching` 只核对原回执，已提交则返回原结果。HTTP 202、超时或 `delivery_unconfirmed` 后保留原载荷与 ID，不换键重发、不启动另一轮；查询或核对仍缺证据时保留未确认状态。正式回复继续带原 `inReplyToRequestId/result/nextAction`，不把回复关联 ID当成来源会话。

### 已认证的跨实例端点投递（实验实现）

`send`、`required` 正式回复和远端到远端往返复用同一个 Manager 请求存储。目标使用 `instanceBinding={instanceId,agentId}`，并保留原始完整 `threadId`；正式回复参数由 Manager 放入目标消息，不要自行换目标或缩短会话 ID。权限按已启用的 Provider 通用校验，但执行能力单独检查；没有精确 owner 投递能力时拒绝，不创建替代 Runtime。

Manager 先从原始认证 lease 解析来源和精确目标，再持久化准备结果、渲染一次信封、记录正在投递、交给目标 owner，最后核对回执并提交。完整身份包含 `managerInstanceId`、`instanceId`、`nodeId`、`agentId`、`provider`、原始会话 ID 和授权 incarnation；回执还须匹配原 `deliveryId`、generation 和 prompt hash。连接、Agent 启停、电脑凭据或实例启用代次变化后，不复用旧授权。

稳定投递键和正文摘要使用 Manager、电脑实例、节点、provider 与完整会话身份；目录中的 `agentId` 别名变化不会产生一条新投递。查原调用键时同时识别既有旧键与回执，保留原 deliveryId；损坏或多义的原预约返回冲突，不能据此重新发送。


发送结果不确定时返回 HTTP 202、`delivery_unconfirmed`、`retryable=false`，保留原正式回复 reservation。不得换投递 ID重发正文。`reconcile_delivery` 只核对原目标的传输证据；启动、连接、catalog、回执和 turn 事件触发有去重的恢复，不换 owner、不自动重投。公共核对本身不轮询。打开新轮次的 Desktop IPC 若在调用方等待结束后才成功，或同一 owner 的 rollout 稍后才出现原投递标记，桥接会在默认 60 秒内保留这一次请求并补记回执；确认后按迟到回执提交原投递。追加已有轮次的超时仍只使用原有的短回执宽限。连接器只持有传输 attempt/receipt，不另建业务请求账本。Codex 可从同一个 Desktop owner 的原始用户消息恢复精确 hash；其它 Provider 缺少可读接受证据时继续待确认。

该合同目前是源码实施与回归范围，不代表运行节点已经更新，更不代表两台真实电脑已通过端到端验收。


某些调用方没有注入 `codex_app__list_threads`、`codex_app__read_thread`、`codex_app__create_thread`、`codex_app__send_message_to_thread` 等 Codex Desktop 连接器工具。提示词不能补出未注册工具，也不能因此自行启动另一个 Runtime。

这类回合需要改用 RabiRoute Manager 提供的本机线程桥：

```http
POST <managerBaseUrl>/api/agent/threads
```

线程桥提供六个动作：

- `list`：从 Desktop 状态按标题查询本机任务，使用 `offset` / `limit` 分页访问全部结果。
- `read`：通过完整 `threadId` 只读读取 Desktop 任务元数据。返回的任务名统一来自 Codex 左侧聊天栏索引；SQLite `threads.title`、首轮初始化提示和 Route 中缓存的旧名称都不能覆盖它。
- `resolve`：先读取精确 ID。有效 ID 且未归档时直接绑定；请求中的 cwd 作为本轮执行目录，不与任务保存的默认 cwd 比较。可变的 Desktop/SQLite 标题和超过新建上限的展示标题也不会否定该绑定；保存 ID 指向已归档任务时返回 `409 archived`。只有 ID 为空、非法或确实失效时才按保存名称和可选 cwd 查找，一个或多个同名同 cwd 候选按 `updatedAt` 自动绑定唯一最新者、零匹配按需幂等创建、最大时间并列时返回候选。
- `create`：在已配置工作区创建空任务，再把初始提示词通过 Desktop IPC 投给该任务 owner。Codex 任务名上限为 240 个 JavaScript 字符单元；更长的输入会由 RabiRoute 安全截断并加省略号，响应和后续配置保存实际创建的名称。
- `rename`：按完整 `threadId` 修改 Desktop 任务名称，已配置 cwd 只提供本次 Desktop IPC 上下文，不改变任务身份；用于持久计划协助槽从单个扩容为多个时，把原“协助处理计划”任务改名为“协助处理计划1”。
- `send`：通过 Desktop IPC 向已有任务 owner start/steer。

`send` 可选传 `imagePaths` 图片绝对路径。文件须存在并使用 PNG/JPEG/GIF/WebP/BMP 扩展名；可位于目标 `cwd` 工作区外，Rabi 不再附加八张上限。Manager 去重后把图片作为 Desktop `localImage` 输入发送；处理端实际不支持图片或拒绝输入时，按真实处理端错误报告，不改称缺少授权。

查询示例：

```json
{
  "action": "list",
  "query": "工会入口",
  "limit": 100,
  "offset": 0
}
```

自动解析或创建示例：

```json
{
  "action": "resolve",
  "threadId": "可选；旧配置可能为空或无效",
  "title": "RabiLink",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "createIfMissing": true
}
```

调用方不要让 AI 或用户手改 UUID。下拉保存名称、完整 ID 和 workspace；用户明确输入新名称时前端先清空旧 ID。对 Codex，有效 ID 是稳定任务身份，workspace 决定本次执行目录；任务保存的默认 cwd、返回标题变化或标题长度超过新建限制都不影响继续该 ID。`resolve` 返回 `id`、`name` 或 `created`；重名最大时间并列时返回 HTTP 409 和 `candidates`。

读取示例：

```json
{
  "action": "read",
  "threadId": "019f0000-0000-7000-8000-000000000001"
}
```

创建示例：

```json
{
  "action": "create",
  "title": "[Example][Research] 比较两种接入方案",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000010",
    "sessionName": "当前调查会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000010",
  "sourceAgentType": "agent",
  "responsePolicy": "none",
  "prompt": "读取现有实现和项目规范，比较两种方案并给出验证计划；未经明确授权不要修改文件。",
  "sandbox": "workspace-write"
}
```

续投示例：

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000001",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "sandbox": "workspace-write",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000002",
    "sessionName": "计划秘书会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000002",
  "sourceAgentType": "plan_secretary",
  "responsePolicy": "required",
  "responseInstruction": "完成下一步后返回结果、验证证据和后续动作",
  "prompt": "补充新的约束和验证证据，请续接原任务。"
}
```

所有带有非空 `prompt` 的 `create` 和 `send` 都必须提供 `messageSource`。字段 `type` 必填，消息信封可以展示四种来源；公共 Agent `send` 的 owner 核验仍按上节执行：

| `messageSource.type` | 必填身份 | 可选补充 |
| --- | --- | --- |
| `message_adapter` | `messageAdapter`、`conversationType`、`conversationId`、`messageId`，以及 `senderName` 或 `senderId` | `conversationName`、`messageGroupId`、消息路线名称/ID |
| `agent` | `agentAdapter`、`sessionName`、完整 `sessionId` | `agentType`、`workspace` |
| `plan` | `planName`、`planId` | 只有实际 Agent 发起且能核对时才附带 `sourceAgent` |
| `system` | `eventType`、`eventName`、`eventId` | `actorType`、`actorName`、`actorId`、消息路线名称/ID |

RabiRoute 渲染后的正文固定从以下两段开始，相关上下文和回传参数只能放在它们之后：

```text
[消息源]
消息源类型：<消息端 | Agent | 计划 | 系统>
<该类型的名称、完整 ID、会话、计划或路线字段>

[消息内容]
<prompt>
```

正式回复使用精简模板：`[消息内容]` 内只保留一份 `[回复结果]` 和 `[下一步]`；`prompt` 中与这两个字段完全相同的文字不重复输出，其余文字保留为 `[相关上下文]`。模板不概括或截断证据。回复合同保留投递 ID、原请求 ID、后续请求 ID、回复要求和完整 POST 参数；不再另列一遍接收任务身份或重复说明无需回复。工作区限制由目标 `AGENTS.md` 提供，投递模板不再添加通用协作提醒，也不按项目名称硬编码。

新投递使用 `[回传参数]` 和完整 JSON 请求。发送前由请求记录保存结构化回复与实际正文校验值；`reconcile_delivery` 核对接收正文后从记录恢复结果，不依赖展示标题。旧格式仅用于尚未关闭的历史预留；详见[模板归属与退出条件](message-delivery-templates.md)。

Agent 调用线程桥时通常使用 `type=agent`。`agentAdapter` 填实际 Agent 端，例如 `codex`、`dsh`、`copilotCli`、`marvis` 或 `astrbot`；`sessionName` 和完整 `sessionId` 都不能省略。Agent 间投递还必须提供自己的完整 `sourceThreadId`、`sourceAgentType` 和 `responsePolicy`，且 `messageSource.sessionId` 必须等于 `sourceThreadId`。`sourceAgentType` 可为 `primary_persona`、`message_processing`、`plan_secretary`、`plan_agent` 或通用的 `agent`；`responsePolicy` 只能是 `required` 或 `none`。选择 `required` 时还必须填写 `responseInstruction`，Manager 会生成 `requestId` 并把正式回复参数写进目标任务收到的内容。选择 `none` 表示本次投递不要求目标返回。

带正文的 `create` 与 `send` 使用同一来源核对规则。`type=agent` 时两者都必须提供 `sourceThreadId`；Manager 从实际 owner 读取来源会话名称并覆盖调用方提交的旧名称，包括 Codex Desktop、DSH 和 Grok Bot 服务 owner。Grok Bot 规范会话 ID 按 Bot owner 核对，不要求它符合 Codex UUID 或 DSH `session-` 形状；这类 `sourceThreadId` 最长 4096 个字符，Codex 与 DSH 来源仍最长 512。消息端来源的 `conversationId` 最长 300 个字符，超长 Bot 会话改用 `type=agent`。计划进展、审批和 QA 等 Manager 计划事件只显示计划名称和计划 ID；只有计划任务本人回传结果时才附带并核对 `sourceAgent`。

`contextBlocks` 排在消息内容之后，`controlBlocks` 再排在上下文之后。回传参数与本次必要的发送要求放入控制块；通用协作段不再注入。两个字段都不能包含 `[消息源]`、`[消息内容]` 或 `[投递源]`。旧 `[投递源]`、旧嵌套信封和旧 Agent 回复会自动迁移；旧重放记录无法还原来源时显示“历史投递记录”，不猜来源身份。

正式回复仍使用同一个 `send` 动作。回复方必须把 `inReplyToRequestId`、`result` 和 `nextAction` 送回原请求任务，并再次填写 `responsePolicy`：如果新的下一步还要求原请求方处理后返回，使用 `required` 并填写新的 `responseInstruction`；如果本次往返到此结束，使用 `none`。回复中的 `messageSource.agentAdapter`、`messageSource.sessionId`、`sourceThreadId` 和 workspace 必须描述当前正在回复的接收会话；`inReplyToRequestId` 单独指向原请求，不能把原请求会话或回复目标写成回复来源。

```json
{
  "action": "send",
  "threadId": "019f0000-0000-7000-8000-000000000002",
  "cwd": "C:\\Path\\To\\Your\\Project",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000001",
    "sessionName": "计划业务会话"
  },
  "sourceThreadId": "019f0000-0000-7000-8000-000000000001",
  "sourceAgentType": "plan_agent",
  "inReplyToRequestId": "请求中给出的 requestId",
  "result": "已经完成调查并核对证据",
  "nextAction": "由秘书更新计划并决定是否继续实现",
  "responsePolicy": "none",
  "prompt": "调查结果和证据摘要。"
}
```

普通 Codex 最终回答不算正式回复。目标 Agent 每轮结束时，`Stop` Hook 会检查待回复请求；仍未回复时，从该轮结束起五分钟后向同一个精确任务投递提醒。提醒触发的新一轮结束后仍未回复，会再从该轮结束起等待五分钟。请求状态可通过 `GET /api/agent/requests` 或 `GET /api/agent/requests/:requestId` 查询；维护者可用 `POST /api/agent/requests/:requestId/cancel` 取消不再需要的请求。

Desktop 偶尔会在消息已经写入目标任务后才返回启动或追加轮次超时。启动超时后，同一请求还会在有界窗口内接受迟到的 Desktop 受理，或在 rollout 出现原投递标记时补记回执。Manager 会用正文中的唯一 `deliveryId` 回读目标任务最近的 rollout：确认标记后提交请求/回复状态；有界等待后仍未确认时返回 HTTP `202`、`code=-1`、`status=delivery_unconfirmed` 和 `error.retryable=false`，保留原 `deliveryId`、`requestId` 及 `pending_delivery` 请求，不删除记录、不再次发送。调用方先查询原请求和目标任务，不把 HTTP `202` 当成送达成功。连接中途关闭时同样保留原载荷与 ID，等待这次补核对或显式 `reconcile_delivery`，不换键重发。

原目标任务正式回复一个 `pending_delivery` 请求时，线程桥先核对双方完整任务 ID、工作目录和原目标 rollout 的精确投递标记；按需流式读取该任务记录，不再因标记超出最后 4 MiB 而漏判。证据齐全才恢复为 `awaiting_response` 并继续原回复。缺少标记或身份不符时返回 `error.code=agent_reply_state_conflict`，并包含 `requestId`、`currentState`、`expectedState`、`reason`、`commitState` 和 `nextAction`。原因区分发送任务不符、接收任务不符、工作目录不符、原始接收证据缺失或不可读；`commitState=not_started` 仅表示这次回复没有发送，不能据此重发原任务。迟到的原投递提交不会把已回复请求重新打开。

#### 核对原投递回执：`reconcile_delivery`

当前 Manager 的公共线程桥使用统一端点恢复协议。调用 `POST /api/agent/threads`，保留原 `deliveryId`，并提供**当前调用会话的真实来源身份**。下面是本机 Codex 原端点发起核对的完整示例；先将示例会话 ID、名称及工作目录替换为实际值，将 `deliveryId` 替换为待核对的原投递 ID，不是请求 `requestId`：

```json
{
  "action": "reconcile_delivery",
  "deliveryId": "019f0000-0000-7000-8000-000000000003",
  "sourceThreadId": "019f0000-0000-7000-8000-000000000001",
  "sourceAgentType": "agent",
  "messageSource": {
    "type": "agent",
    "agentAdapter": "codex",
    "sessionId": "019f0000-0000-7000-8000-000000000001",
    "sessionName": "原投递端点会话",
    "workspace": "C:\\Path\\To\\Your\\Project"
  }
}
```

- `sourceThreadId` 是**当前执行核对的完整会话 ID**，必须与 `messageSource.sessionId` 相同；`sourceAgentType` 沿用该端点原投递时的 Agent 类型。来源可以是原投递的发送端或接收端，但不是任意维护会话。正式回复方向与原请求相反：回复的接收端是原请求的来源，不能据此把回复目标填写成当前调用来源。
- `messageSource.agentAdapter` 描述真实来源处理端，DSH 填 `dsh` 而不是 `codex`；名称和工作目录由真实 owner 核对，不授予权限。远端调用复用原已鉴权连接及端点绑定，不通过正文声明新授权。
- 本分支先按 `deliveryId` 查持久投递记录，再核对当前来源。**不调用 `resolveTarget`**：目标、端点代际、正文 hash 和执行选项 hash 来自原记录；顶层 `threadId`、`agentAdapter`、`agentTargetId`、`instanceBinding` 不用于改选恢复目标，不能当作新请求的目标参数。无需 `prompt`、`result`、`nextAction`、`inReplyToRequestId` 或 `responsePolicy`，也不接受它们替换已留存的回复结果。
- 已确认及重复核对均返回 HTTP `200`，响应 JSON 顶层为 `code=0`、`action="send"`、`ok=true`、`status="delivered"`、`delivery.status="accepted"`；顶层 `threadId` 是原投递目标，没有额外的 `data` 信封。尚无有效回执返回 HTTP `202`、`code=-1`、`status="delivery_unconfirmed"`、`delivery.status="unconfirmed"`、`delivery.retryable=false`。这些字段证明投递或回执状态，不证明业务工作完成。恢复正式回复后原请求才为 `responded`；若原投递同时要求后续回复，后续请求仅为 `awaiting_response`，应分别 GET 原请求核对。
- 此动作只核对原 owner 留存回执／实际接收证据，不执行正文投递；原证据缺失、来源不匹配、绑定撤销、正文或代际不符时失败关闭，不重放、不重建、不换 `deliveryId`。普通工具输出、助手引用或孤立 ID 不能作为接收证据。

**旧 reservation 兼容边界**：未装配 `endpointDelivery` 的旧本机 handler／历史恢复辅助入口仍按接收任务 `threadId` 读取回复 rollout，成功为 `receipt_recovered`、重复为 `already_recorded`；读取限定于开始时的文件长度与 30 秒期限。该状态不是当前公共统一端点分支的返回值，旧三字段例子不再作为公共调用示例。旧回复正文解析仅服务没有 `pendingResponseEvidence` 的既有预留；具有结构化证据的新记录不得失败后降级解析。含端点身份的记录经旧恢复辅助函数返回 `endpoint_receipt_required`，不能借旧分支绕过端点校验；当前公共分支也不因找不到端点投递记录而自动转旧恢复。旧预留只能按对应原版本的正式恢复入口核验证据或走正常取消，不直接改存储、不重发正文；全部受影响旧预留闭合并通过兼容回归后方可删除旧解析，见[历史兼容与退出条件](message-delivery-templates.md#历史兼容与退出条件)。

收件日志能力按回复实际进入的原来源任务（`original.source`）核对。发送回复的处理端没有收件日志时，仅允许使用已持久化的结构化 SHA-256 证据恢复；正文必须精确匹配，双方 Adapter、任务 ID、工作目录、原请求及后续请求方向均须一致。缺少结构化证据的旧回复继续失败关闭，返回 `adapter_has_no_receipt_log`。

提醒触发前也执行上述核对。证据仍不完整时保留 reservation、写入 `lastReminderError` 并停止本次“未回复”提醒，不无限重试或要求重发；下一次任务结束或显式核对可重新检查。读取超时、身份/合同不符及旧版本已删除的 `404` 请求均不凭猜测重建，必须保留正式回传未记录的差异。

Agent 间 `create` 与 `send` 投递时，Manager 按 `messageSource.agentAdapter + sourceThreadId` 向实际 owner 核对来源会话。Codex 读取 Desktop 任务状态和左侧聊天栏名称；DSH 通过 apiproxy `session.list` 读取会话名称、工作目录和运行状态。Grok Bot 来源先确认规范 `grokBot:` 会话 ID，再读取 Bot owner 名称；无法解码、owner 缺失或声明的 adapter 不是 `grokBot` 时失败关闭，不退回 Codex/DSH 形状检查放行。来源不存在、工作目录冲突或来源 ID 与 `messageSource.sessionId` 不一致时失败关闭。所有 RabiRoute 非空投递都先显示 `[消息源]`，再显示 `[消息内容]`。消息端来源显示消息端、会话、发送者和消息 ID；Agent 来源显示 Agent 端、会话名称和完整会话 ID；计划来源显示计划名称和计划 ID；系统来源显示事件类型、名称和 ID。提醒、初始化消息、RabiLink 复盘和重放也使用同一信封。

安全边界：

- Codex / DSH 的 `create` / `send` 使用当前 RabiRoute 已配置的工作区，不能在任意路径启动会话。Grok Bot 服务会话不要求本地文件目录；不为它伪造 `cwd` 或启动本地 Runtime。
- 所有带有非空 `prompt` 的 `create` / `send` 都必须提供完整 `messageSource`。`type=agent` 时，`agentAdapter`、`sessionName` 和完整 `sessionId` 都必填；Agent 互投还必须提供可核对的 `sourceThreadId`，并保证它与 `messageSource.sessionId` 相同。`sourceAgentType` 只声明发送方当前职责，任务名以对应 owner 查询结果为准。
- Agent 互投允许正文引用 `[rabi:bind]`、消息源标题、消息处理 Agent 或计划秘书初始化等文字，不因匹配字符串拒绝整个请求。真实来源仍由结构化消息信封和 owner 核对，正文标题按原有渲染规则转义。来源与目标为同一任务仍按自投递错误处理；消息处理 Agent 的任务 ID如果与主角色 ID相同，消息池会拒绝初始化和投递。
- `sandbox` 字段仅为接口兼容参数，不能覆盖目标 Desktop 任务的模型、工具、沙箱或审批；这些能力以 Desktop owner 为唯一真源。
- 创建线程使用固定的调查边界；没有明确实施授权时，只能调查、整理证据和输出方案。
- `create` 的固定开发说明和所有 `send` 续投都会追加工作区交付约束；未经当前用户明确授权，不得新建额外工作副本、稀疏检出、复制工程或旁路目录；工作区 `AGENTS.md` 有更严格限制时以它为准。具体项目允许的工作副本、同步方向及历史指令的有效性由该工作区当前规则决定。只有改动已经进入用户实际运行或验收的目标工作区，并完成适用的资源关联、构建或编译及运行验证，才能称为“已修复”或“可验收”。
- `create` 按“任务名 + 工作目录”幂等解析。相同创建请求并发到达、调用方等待超时后重试，或任务刚创建但 Desktop 索引尚未及时显示时，都会复用同一次创建结果；不得因为第一次 HTTP 超时再次创建同名任务。返回 `resolution=created` 表示本次新建，`resolution=name` 表示复用了同名同工作目录任务。
- Manager 在运行期 `data/.runtime/codex-thread-creations/` 持久保存创建 reservation。状态按 `reserved → creating → thread_created → naming → initial_turn → completed` 推进。`creating` 超过 5 分钟、没有 `threadId`，并且第二次 `action=list + lookupMode=state_db` 明确确认同名同工作目录任务不存在时，Manager 才先转为 `failed_before_create`，再允许同键重试。记录已有 `threadId`、索引查询失败、查到候选任务或其它证据不足时转为 `uncertain`，后续请求返回 `409` 并禁止自动再次创建。
- `create` 返回 `initialTurnStatus`。若任务已经创建但初始 turn 启动失败，应记录返回的 `threadId` 并用 `send` 重试，不能重复创建同名任务。
- 创建调用超时后，先用 `action=list + lookupMode=state_db + 原任务名` 从本地任务索引回读。这个模式不启动 app-server 元数据扫描，适合判断慢创建是否稍后产生了任务；完整任务列表仍使用默认 `lookupMode=complete`。
- Agent 正式回复按双方任务 ID 校验来源与目标，不再因为工作目录不同而拒绝；工作目录只作为身份信息随请求记录。Windows 普通盘符路径、`\\?\` 扩展盘符路径、UNC 与扩展 UNC 的等价形式仍使用统一的路径规范化规则比较，避免同一个目录因为字符串写法不同而被判成两个工作区。该校验不参与 Codex 任务身份判定。
- 当前 Route 开启“强制使用 RabiAgent 消息投递接口”后，Codex Hook 会拒绝绕过 Rabi 的持久任务工具；DSH `RabiRoute Agent` 插件会拒绝 Shell 直接调用 `/api/agent/threads`、`/api/agent/send` 或 `session.prompt`。两端都必须使用线程桥并填写 `sourceThreadId`、`sourceAgentType` 和 `responsePolicy`。临时子 Agent 的本地协作不属于这项限制；关闭开关只停止绕过检查，已有待回复请求仍继续检查和提醒。
- Manager 线程桥最终投给目标会话的同一个 owner：Codex 使用 Desktop IPC，DSH 使用该会话的 apiproxy owner。两者都不启动或改投备用 Runtime。
- Codex Desktop 未启动、IPC 不可用或目标任务无法加载时返回失败；DSH Endpoint 不可用、会话不存在或工作目录冲突时也返回失败。两端都不得转给另一 Agent adapter 或备用 Runtime。

## 计划接口

计划是 Agent 需要关注的事项。计划不按短期、长期拆目录，而是通过状态和字段表达当前进展、优先级、项目归属和下一步。`plan.status` 只保存当前角色 `personaConfig.json.planWorkflow.statuses` 中启用状态的 key；下面十项是默认模板，不是代码枚举。

```text
分析中
待补充信息
待审批
执行中
等待打包
等待 QA
待讨论
暂停
完成
关闭
```

默认模板的稳定状态 key `等待 QA` 显示为“等待 QA 验收”，英文显示为“Awaiting QA acceptance”；状态 key 不变。

默认“待补充信息”只表示：分析已完成，但现有信息仍无法形成可审批的具体方案，且缺失信息会影响原因、改法、实施范围或验收合同。暂未复现、疑似历史已修复、等待目标包、等待 QA 验收或等待是否关闭都不使用该状态；这些情况应继续分析，或按证据进入“等待打包”“等待 QA 验收”“关闭”。

Agent 可以在已授权任务范围内主动创建和调整计划、修改步骤及更新真实进度，无需为每次计划维护另行审批。实际业务动作的授权、验收证据与计划维护分开判断。版本校验只防止覆盖并发修改，不限制由 Agent 维护计划。

计划、状态目录和反馈写入失败时，响应包含 `message`（具体原因）、`reason`（错误类别）、`commitState`（`not_started/unknown/committed`）、`nextAction` 和 `retryable`。`412 revision_conflict` 要先读取最新计划并合并；`committed` 表示写入已完成、回读暂不可用；`unknown` 只能保留原载荷和原幂等键核对，不应新建替代计划。反馈提交和后台反馈更新只回读目标计划，不再因无关计划目录读取失败而把已提交反馈报错。

计划审批、QA 续投和完成通知检查线程桥的结构化送达状态；HTTP 202 的 `delivery_unconfirmed` 或 `delivered_tracking_failed` 保留待确认，不标记已通知，也不自动重发正文。

查询计划：

```http
GET /roles/:roleId/plans
GET /roles/:roleId/plans/:planId
```

查询和维护角色计划状态：

```http
GET    /api/roles/:roleId/plan-statuses
POST   /api/roles/:roleId/plan-statuses
PATCH  /api/roles/:roleId/plan-statuses/:statusKey
DELETE /api/roles/:roleId/plan-statuses/:statusKey
```

写请求必须携带 `If-Match` 和 `Idempotency-Key`。新增或修改请求体使用状态定义字段；状态 key 不可原地修改。删除请求体必须提供 `replacementKey`，Manager 会先迁移未归档计划，再将旧定义保留为 `retired`，使归档计划和历史快照继续可读。

新增计划：

```http
POST /roles/:roleId/plans
```

请求体示例：

```json
{
  "title": "完善计划和记忆机制文档",
  "focus": "计划和记忆机制文档",
  "status": "分析中",
  "archiveStatus": "未归档",
  "priority": "medium",
  "kind": "documentation",
  "currentStepId": "confirm-contract",
  "currentStep": "确认接口文档注入方式",
  "nextAction": "补充 Rabi Agent 接口文档",
  "blockedBy": "",
  "attachments": [
    { "name": "plan-preview.png", "mimeType": "image/png", "contentBase64": "<base64>" },
    { "name": "acceptance-checklist.pdf", "path": "C:/Path/To/acceptance-checklist.pdf" }
  ],
  "steps": [
    { "id": "inspect-existing", "title": "检查现有计划接口", "startedAt": "2026-07-27T08:00:00.000Z", "completedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "confirm-contract", "title": "确认步骤数据契约", "startedAt": "2026-07-27T08:10:00.000Z" },
    { "id": "update-docs", "title": "更新双语接口文档" }
  ],
  "keywords": ["计划", "记忆", "接口", "上下文"],
  "source": {
    "kind": "agent",
    "summary": "Agent 根据用户讨论新增计划"
  },
  "taskBinding": {
    "agentType": "codex",
    "sessionId": "exact-source-session-id",
    "sessionTitle": "计划执行任务",
    "workspace": "C:/Path/To/Project",
    "completionHook": {
      "enabled": true,
      "gatewayId": "Role__reminder"
    }
  }
}
```

新增计划必须提供有序的 `steps`。`plan.status` 只能写当前角色状态目录中的 enabled key。`archiveStatus` 独立，只允许“未归档、已归档”。步骤不保存独立状态；`currentStepId` 表示当前步骤，`completedAt` 表示已经完成。Manager 返回 key 及其配置的 label、description、palette、order 和 views，WebGUI 与托盘只消费这些字段。

仍在调查、分析完成但无法形成可审批具体方案、完整审批等待和获批执行分别写 `planWorkflow.roles.analysis`、`roles.informationNeeded`、`roles.approval`、`roles.execution` 所指的 key。包体、QA、讨论和暂停同样通过 roles 查找；步骤名称、说明、`waitingFor` 与审批合同不再覆盖 `plan.status`。

只有代码、Prefab、资源、配置等会产生项目内容变动的计划才应采用“实施/开发验证/适用同步提交 → 等待打包 → 等待 QA 验收 → QA 通过完成；失败回实施”的流程。调查、设计评审、运营、资料收集、外部依赖与控制面维护按自身真实步骤推进；Agent 或批处理不得为这些计划虚构 package 或 QA 步骤。Manager 不根据标题、说明或 `kind` 自动补流程。

`attachments` 可选。新附件可提供本机 `path`，或提供 `name`、可选 `mimeType` 与 `contentBase64`；单次新增最多 8 个，单个不超过 10 MiB、新内容合计不超过 25 MiB；保留的旧附件不占本次额度。Manager 把内容复制到角色私有 `plans/attachments/<planId>/`，计划文件只保留安全元数据，不保存 Base64。PATCH 未提供 `attachments` 时保留原列表，提供空数组时清空记录；如需在 PATCH 中保留指定旧附件，可把 GET 返回的对应附件对象原样带回。Manager 对外计划 DTO 不返回本机 `path`。

读取附件：

```http
GET /api/roles/:roleId/plans/:planId/attachments/:attachmentId
```

图片和视频附件使用 `inline` 响应；WebGUI 以紧凑固定宽度的 16:9 缩略图展示 PNG、JPEG、WebP、GIF 与 MP4/M4V、WebM、Ogg Video、MOV/QuickTime，容器不足时才等比缩小，点击后分别打开页内大图或带控制条的视频预览。视频可使用 HTTP 字节范围读取，实际解码能力由浏览器决定；普通文件使用下载响应。该接口只读取计划元数据中已登记且真实路径仍位于本计划目录内的文件。

请求审批前，Agent 应 PATCH 当前步骤的完整 `approvalRequest`。Manager 的完整性判断不阻止计划保存，但缺项时返回 `presentation.approval.state=incomplete`、`enabled=false` 和 `missing[]`；计划卡列出缺项，并禁用审批输入、附件与提交。Agent 必须在同一计划补齐审批人、决定、推荐与备选、reason、真实路径、完整命令、外部目标、验证、回退、排除范围、请求来源与回执后，才允许正式审批。

`taskBinding` 可在 POST 或 PATCH 中写入，用于精确绑定一个 Codex 执行会话。当前只接受 `agentType=codex` 和非空完整 `sessionId`；`completionHook.enabled` 必须是布尔值。启用后，Codex `Stop` Hook 把官方 `last_assistant_message` 交给 Manager，Manager 再经同角色的角色面板 / Forwarding / AgentPacket 链提醒目标处理会话。`gatewayId` 在同角色有多个 Route 时必填。提醒按 `sessionId + turnId` 去重，不会自动 PATCH 计划、推进步骤或写记忆。

完成提醒来自计划独立业务任务。主角色必须在同一轮安排计划管理秘书消费结果、更新计划与记忆，并在计划仍可推进时使用 `/api/agent/threads` 的 `send` 动作向计划自身 `taskBinding.sessionId + workspace` 精确续投业务任务。秘书 ID 不得写入 `taskBinding`，秘书轮转或计划暂停也不得清空业务绑定。主角色检查全部未终态计划、秘书槽与业务任务，结束前满足“可推进但无人管理的计划数 = 0”以及“可推进但空闲的业务任务数 = 0”；这些决策与写入属于 Agent，不由 Stop Hook 或 Manager 自动执行。

完成提醒失败不会阻断源 Codex 最终回答，但会记录失败并返回非阻塞系统警告。workspace、角色、gateway 或源/目标任务冲突均失败关闭；未完成双真实 Desktop 任务验收前，该接口能力为实验状态。

### 计划引导与审批意见接口

```http
GET  /api/roles/:roleId/plans/:planId/feedback
POST /api/roles/:roleId/plans/:planId/feedback
```

RibiWebGUI 用该接口记录 `presentation.acceptsGuidance=true` 且未进入审批的计划级引导；WebGUI/托盘也继续用它记录当前审批步骤的正式意见。两者均可选择只保存；选择“提交并投递”才请求 Manager 通过独立 `plan_feedback` 系统事件通知 Agent。计划引导只带 `planId`，不能带 `stepId`：

```json
{
  "feedbackId": "webgui-guidance-12345",
  "gatewayId": "route-id",
  "text": "先收窄整体范围，再根据结果调整后续步骤。",
  "kind": "guidance",
  "author": "user",
  "source": "webgui",
  "notifyAgent": true
}
```

审批意见继续关联审批步骤。用户 `approval_suggestion` durable 保存时，反馈、附件与计划标记变更在同一 WAL 事务发布，`markerStatus` 取角色 `planWorkflow.roles.approved` 指向的 key，`activationStatus` 不变。`presentation.approval.state=approved` 表示意见已提交，不表示全部选项获批，也不自动实施。`notifyAgent=false` 只保存；`notifyAgent=true` 先保存再投递，只有 confirmed 成功回执匹配同一 `feedbackId` 且计划版本未变时，才更新为 `roles.analysis`。`pending/failed` 或不确定回执不能触发该转换；旧回执不能覆盖新提交或后续计划变更。`guidance` 与 Agent 回复不触发上述状态转换。

结构化审批表单使用可选 `formData: { questions: PlanQuestion[], approvalContract?: PlanApprovalRequest, answers: Record<string, PlanQuestionAnswer>, text: string }`；共用类型位于 `src/shared/planFeedbackFormData.ts`。`questions` 保存源 `currentStep.questions` 快照，`answers` 使用 `question:<id>` 及默认 `approval-decision` 答案 ID，`text` 保存补充文字。审批表单的 `approvalContract` 必须与当前 `step.approvalRequest` 匹配；只有问题与审批合同快照均匹配才可回填。Manager 从 `formData` 生成权威 `feedback.text`，不采用与表单冲突的手写正文；可选 `reuseFeedbackId` 从同计划原反馈复用全部附件，不接收本机路径。重新提交追加新记录，同一提交重试保持原 `feedbackId`、表单与完整正文。审批合同变化后必须重新确认，不能复用旧选择。以下示例为不带结构化表单的审批意见：

```json
{
  "feedbackId": "qq-message-12345",
  "gatewayId": "route-id",
  "stepId": "review-plan",
  "text": "同意方向，但先补充回归范围。",
  "attachments": [
    { "name": "review.png", "mimeType": "image/png", "contentBase64": "<base64>" }
  ],
  "planAttachmentIds": ["attachment-design-preview"],
  "kind": "approval_suggestion",
  "author": "user",
  "source": "qq",
  "notifyAgent": false
}
```

`attachments` 可选。每项使用 `name`、可选 `mimeType` 和 `contentBase64`；最多 8 个，单个不超过 10 MiB、总计不超过 25 MiB。Manager 校验后把内容保存到角色私有的 `plans/feedback/attachments/<feedbackId>/`，记录与 Agent 通知只携带安全元数据和本地路径。同一 `feedbackId` 重试必须保持相同文字、步骤和附件内容。

`planAttachmentIds` 也可选，用于引用当前计划顶层 `attachments` 中已有的附件；最多 8 个且必须唯一。RibiWebGUI 在审批输入框键入 `@` 时显示当前计划附件候选，选中后插入可读的 `@附件「文件名」` 标记，并提交对应附件 ID。Manager 以 ID 校验附件确实属于当前计划，把附件元数据与本地路径作为本次审批审计快照保存，并随同一 `plan_feedback` 投递给 Agent；WebGUI 不读取或提交任意本机路径。同一 `feedbackId` 重试也必须保持相同的计划附件引用。

当反馈关联当前结构化 `qa-* / verify-*` 步骤时，Manager 只把用户或外部入口提交的 `approval_suggestion` 视为 QA 判定候选。`guidance`、`guidance_response`、`approval_response`、`author=agent` 的执行报告，以及正文里的裸 `passed / verified` 测试计数都只作普通反馈记录，不会完成或回退 QA。候选正文明确表示失败或仍复现时，Manager 在同一计划插入或复用 `investigate-<qaStepId>`，清除 QA 步骤的 `completedAt`，按问题类型把最小缺失证据写入 `waitingFor`；证据齐全后继续原 `taskBinding.sessionId + workspace`。只有“QA 明确通过”“验收通过”“确认未再复现”等明确结论才完成当前 QA 步骤。

当 `notifyAgent=true` 时，POST 在反馈成功落盘后立即以 HTTP `202` 返回，通常为 `deliveryStatus=pending`。计划引导与审批意见复用同一 `taskBinding` 投递链：存在完整绑定时，Manager 只通过 `/api/agent/threads` 的 Desktop IPC 主链投向原业务任务；绑定不完整时才把完整反馈交给角色 Agent。owner 未加载时保持 `pending` 并有界重试，只有目标 owner 接受 `start/steer` 才记录 `delivered`。事件不写角色面板 timeline 或统一会话账本，也不注入最近消息；终态通过 `plan_feedback_changed` 通知。

Agent 处理计划引导时使用 `kind=guidance_response`、`author=agent`、`source=agent`、`notifyAgent=false`，只回写 `planId`，不带 `stepId`。Agent 必须先读取整个计划，按引导更新计划说明、范围、优先级或路径，并在需要时调整后续步骤。审批处理仍使用 `kind=approval_response` 并关联 `planId / stepId`。两类 Agent 记录都按 `record_only` 保存，不改变状态；这不同于用户审批保存及确认投递触发的配置标记转换。

AgentPacket 的共用计划 API 提示会直接包含上述计划引导、审批记录入口与“记录后另行 PATCH 计划”的约束，因此不要求每个角色 Skill 重复维护同一套接口。

更新计划：

```http
PATCH /roles/:roleId/plans/:planId
```

常见用途：

- 更新标题。
- 更新、保留或清空计划附件。
- 更新全部步骤及唯一的当前步骤。
- 更新下一步、等待对象和阻塞原因。
- 更新关键词。
- 将状态改为当前角色状态目录中的 enabled key；需要表达生命周期语义时，通过 `planWorkflow.roles` 选择对应 key。
- 暂停或讨论结束后，按实际阶段恢复为 analysis 或 execution role 指向的 key。
- 验收完成后使用 completed role；取消、失效或由后继计划替代时使用 closed role。

计划归档通常不需要 Agent 处理。状态定义同时满足 `terminal=true` 与 `archiveEligible=true` 的未归档计划，超过 `personaConfig.json.planWorkflow.archiveAfterHours` 后，由角色知识快照把独立的 `archiveStatus` 改为 `已归档`，但保留原 `plan.status` key。默认模板延迟为 72 小时；已归档计划不参与关键词召回。

归档计时以计划的 `updatedAt` 为准。Agent 更新计划后，RabiRoute 会刷新 `updatedAt`，该计划重新进入活跃窗口；是否可归档由当前状态配置决定，不由显示名称判断。

## 近期记忆接口

近期记忆是 Agent 主动记录、仍处于可修改或待沉淀窗口内的记忆。近期记忆没有计划状态。

查询近期记忆：

```http
GET /roles/:roleId/memory/recent
GET /roles/:roleId/memory/recent/:memoryId
GET /api/roles/:roleId/memory?counts=1
```

`counts=1` 只返回近期记忆、沉淀记忆、已归档记忆来源和沉淀记录的数量，不读取或返回记忆卡片正文；WebGUI 直达“计划与记忆”页面时用它填充标签计数。

新增近期记忆：

```http
POST /roles/:roleId/memory/recent
```

请求体示例：

```json
{
  "title": "计划和记忆由 Agent 主动维护",
  "focus": "计划和记忆的维护责任",
  "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 负责提供接口、自动归档和记忆沉淀触发。",
  "keywords": ["计划", "记忆", "主动维护", "接口"],
  "source": {
    "kind": "agent",
    "summary": "Agent 根据当前对话记录"
  }
}
```

更新近期记忆：

```http
PATCH /roles/:roleId/memory/recent/:memoryId
```

近期记忆可以通过 ID 修改，用于修正、补充、合并或降噪。近期记忆是否允许修改由 RabiRoute 按当前固定的 24 小时可编辑窗口判断；目前这个窗口还不是 `personaConfig.json` 的公开配置字段。

近期记忆的可编辑窗口取 `updatedAt` 和 `viewedAt` 中较新的时间。Agent 按 ID 查询近期记忆时，RabiRoute 会刷新 `viewedAt`；Agent 更新近期记忆时会刷新 `updatedAt` 和 `viewedAt`。沉淀的 24/72 小时窗口另取 `updatedAt` 和 `recalledAt` 中较新的时间，普通按 ID 查询不会推迟沉淀。

Agent 新增或更新近期记忆时，应主动填写 `keywords`。RabiRoute 在消息投递前只使用标题和 `keywords` 做轻量召回，不对记忆内容进行实时智能分词。当前消息命中近期记忆标题或 `keywords` 时，RabiRoute 会同时刷新该条记忆的 `viewedAt` 和 `recalledAt`。

近期记忆列表的 `lifecycle` 由 Manager 动态返回：`triggersNextConsolidation` 标记最早到达 72 小时的记忆，`willEnterNextConsolidation` 表示该记忆在同一触发时刻是否已经超过 24 小时输入窗口。该结果随记忆目录缓存，记忆新增、修改或命中召回后重新计算；调用端不得根据本地时钟另算候选范围。

`keywords` 是必填项。新增近期记忆时必须提供至少一个关键词；更新近期记忆时如果改写 `keywords`，也必须保留至少一个关键词。

## 写入聚焦与长度校验

新增计划、近期记忆和沉淀结果都必须显式填写单行 `focus`。`focus` 只描述一个主题：一个计划只推进一个目标，一个记忆只记录一个事实、偏好、结论或问题；出现独立事项时创建新条目。标题可用于展示，不能代替 `focus`。

RabiRoute 会按角色 `personaConfig.json` 的 `knowledgeLimits.plan` 和 `knowledgeLimits.memory` 校验标题、`focus`、正文/步骤、来源摘要、单个关键词、关键词数量和总文本长度。未配置字段使用系统默认值；超限写入返回 `400`，不会截断后静默保存。

检查当前角色全部计划和记忆：

```http
GET /api/roles/:roleId/knowledge-validation
```

返回的 `data.ok` 表示是否全部合规，`data.limits` 是实际生效限制，`data.issues` 列出旧条目或手工文件中的违规项。旧文件仍可读取，但下一次写入应先拆分或压缩到限制内。完整默认值和配置示例见 [计划和记忆机制](plan-and-memory-model.md#聚焦与长度校验)。

## 沉淀记忆接口

沉淀记忆是近期记忆经过整理后的稳定记录。Agent 不能直接修改已有沉淀记忆。

查询沉淀记忆：

```http
GET /roles/:roleId/memory/consolidated
GET /roles/:roleId/memory/consolidated/:memoryId
```

沉淀记忆不提供普通 `PATCH` 接口。如果 Agent 发现沉淀记忆需要修正，应新增一条近期记忆说明修正内容，等待下一轮沉淀流程生成新的稳定结论。

按 ID 查询沉淀记忆会刷新该条沉淀记忆的 `viewedAt`。沉淀记忆没有更新接口，`viewedAt` 只表示近期被查看或召回过。

## 内置记忆整理触发

记忆整理是一种内置手动触发消息。它走与普通 `manual_trigger` 一致的 Agent 投递链路。

当前触发来源：

- 用户触发 `triggerId=memory-consolidation` 的内置手动触发项。
- 调用 Manager API 显式创建整理 request。

时间窗口用于判断本次 request 是否到期以及哪些近期记忆进入输入；当前没有仅凭时间流逝就在后台自行启动整理的常驻调度器。

RabiRoute 创建的沉淀请求包含待整理的近期记忆。负责投递的链路可以把这个请求交给 Agent；Agent 只需要返回沉淀后的记忆。

手动创建沉淀请求：

```http
POST /roles/:roleId/memory/consolidation-requests
```

请求体可选：

```json
{
  "triggerSource": "manual",
  "triggerOlderThanHours": 72,
  "includeOlderThanHours": 24,
  "force": false
}
```

默认情况下，只有存在最后活跃时间超过 72 小时且尚未沉淀的近期记忆时，RabiRoute 才创建请求；请求输入为所有最后活跃时间超过 24 小时且尚未沉淀的近期记忆。

创建后 API 返回本轮整理 run 和输入记忆。负责投递的链路可以把这些内容包装成 `memory_consolidation_request` 交给 Agent。

API 返回示例：

```json
{
  "code": 0,
  "data": {
    "run": {
      "id": "memory-consolidation-run-001",
      "roleDir": "data/roles/Rabi",
      "requestedAt": "2026-06-08T00:00:00+08:00",
      "trigger": "api",
      "recentEditableHours": 24,
      "recentConsolidationHours": 72,
      "inputMemoryIds": ["memory-001"],
      "status": "requested",
      "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。"
    },
    "memories": [
      {
        "id": "memory-001",
        "title": "计划和记忆由 Agent 主动维护",
        "focus": "计划和记忆的维护责任",
        "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 提供接口。",
        "keywords": ["计划", "记忆", "接口"],
        "createdAt": "2026-06-06T12:00:00+08:00",
        "updatedAt": "2026-06-06T12:00:00+08:00"
      }
    ]
  }
}
```

投递给 Agent 的抽象消息示例：

```json
{
  "type": "memory_consolidation_request",
  "routeKind": "manual_trigger",
  "triggerId": "memory-consolidation",
  "triggerName": "记忆整理",
  "triggerSource": "manual",
  "roleId": "Rabi",
  "runId": "memory-consolidation-run-001",
  "requestedAt": "2026-06-08T00:00:00+08:00",
  "window": {
    "triggerOlderThanHours": 72,
    "includeOlderThanHours": 24
  },
  "instruction": "请将以下近期记忆整理为稳定、简洁、可长期保留的沉淀记忆，只返回沉淀记忆内容。",
  "memories": [
    {
      "id": "memory-001",
      "title": "计划和记忆由 Agent 主动维护",
      "focus": "计划和记忆的维护责任",
      "content": "用户希望计划和记忆都由 Agent 主动维护，RabiRoute 提供接口。"
    }
  ]
}
```

返回示例：

```json
{
  "type": "memory_consolidation_result",
  "memories": [
    {
      "title": "计划和记忆维护边界",
      "focus": "计划和记忆的维护责任",
      "content": "计划和记忆由 Agent 主动维护；RabiRoute 负责提供接口、注入索引、按角色配置归档符合条件的计划，并触发记忆沉淀流程。"
    }
  ]
}
```

接收 Agent 返回并落盘：

```http
POST /roles/:roleId/memory/consolidation-runs/:runId/result
```

请求体可以直接是 `memory_consolidation_result`，RabiRoute 会读取其中的 `memories` 数组。

RabiRoute 负责写入沉淀记忆、记录整理轮次和标记近期记忆已沉淀。Agent 不需要移动文件、更新沉淀标记或判断触发时机。

## 远端 Agent 设备接口（旧协议兼容）

当前远端 Agent 作为 Agent 执行端接入，见[远端接入](lan-rabi-agent-bootstrap.md)。消息端独立配置入口已移除；以下接口仅描述存量 bridge 的兼容行为。

> 成熟度：实验。协议、安全边界和 Manager API 已实现并有测试，仍需要按真实局域网、VPN/TLS 和目标设备环境做端到端验收。

当路由启用了“远端 Agent”消息端时，本机 Agent 可以把需要特定设备/系统完成的任务投递给远端 Agent 设备。远端机器只需要运行 `plugin-adapters/remote-agent-rabiroute` bridge，不需要安装完整 RabiRoute。

安全边界：

- 本机 loopback 调用用于 WebGUI 和本机角色线程。
- RabiGUI/manager 先扫描局域网远端 bridge，再由用户输入设备密码连接。bridge 不再提供公知默认密码：未配置时每次启动生成高熵临时密码并只显示在远端终端；长期部署应设置至少 16 字节的 `REMOTE_AGENT_PASSWORD`。协议 v3 使用逐连接、角色分离的双向 HMAC-SHA256 challenge，不在 WebSocket 中发送密码原文；连接成功后只在本机运行期数据中记住密码。
- bridge 连接设备本机由远端 Agent 自己拥有的 runtime；不得通过用户级 endpoint 把桌面应用改成依赖 RabiRoute。远端 task 只能在 `REMOTE_AGENT_ALLOWED_CWDS` 内使用 `workspaceWrite`，默认禁止网络，不存在 `dangerFullAccess` 路径。
- WebSocket 控制通道只传 role-separated HMAC proof，不传密码原文。默认 `ws://` 只提供双方身份确认，不提供链路加密；跨不可信网络时应放在受信 VPN 内，或由 TLS 终结层提供 `wss://` 并通过严格的 `REMOTE_AGENT_PUBLIC_CONTROL_URL` 公布入口。
- 任务事件必须来自任务所属的 `deviceId`；其他设备不能把别人的任务标记为 completed/failed。
- 文件传输默认限制为单文件 10 MiB、单任务 25 MiB；可通过 `REMOTE_AGENT_FILE_SINGLE_LIMIT_BYTES` 或 `REMOTE_AGENT_FILE_TOTAL_LIMIT_BYTES` 调整。

查询在线远端设备：

```http
GET /api/remote-agent/devices
```

创建设备任务：

```http
POST /api/remote-agent/tasks
```

请求体示例：

```json
{
  "originGatewayId": "main",
  "deviceId": "builder-device",
  "taskKind": "build-desktop",
  "cwd": "/path/to/project",
  "threadName": "远端构建小助手",
  "message": "请在远端设备执行打包任务，完成后回传产物路径和日志路径。",
  "filePaths": ["/local/path/to/input.patch"],
  "originReplyContext": {}
}
```

文件传输：

- `filePaths`：本机 manager 可读取的文件路径数组。manager 会读取文件内容，随任务发送到远端 bridge。
- `files` / `attachments`：也可以直接传 `{ "name": "input.txt", "contentBase64": "..." }`；带 `path` 时 manager 会读取本机路径。
- 远端 bridge 会把任务文件保存到远端运行期 inbox 目录，并在远端 Codex 任务提示里列出实际路径。
- bridge 会从 `turn/completed` 的最终 `agentMessage` 提取答案并回传，因此默认禁止网络时任务也能闭环；callback 只用于可选的详细进度和附件。
- 远端 Codex 完成后，可在本机 callback 中填写 `artifactPath`、`logPath` 或 `files`；路径会先解析真实路径，而且只能位于当前任务 cwd 内，junction/symlink 越界会被拒绝。
- 同一“规范 cwd + 线程名”的任务会一直串行到 terminal；恢复到仍有活跃 turn 的线程时先有限等待，无法安全复用就创建独立线程，不把不同任务 steer 进同一个 turn。
- Manager 会把回传文件保存到 `data/remote-agent-files/<taskId>/`，并在任务事件的 `savedFiles` 中记录本机保存路径、大小和 sha256。

远端结果会先回到本机 RabiRoute，再投递回发起任务的本机角色线程。远端 Agent 不应直接回复 QQ；是否回复 QQ 仍由本机角色通过明确发送接口决定。

查询整理轮次：

```http
GET /roles/:roleId/memory/consolidation-runs
GET /roles/:roleId/memory/consolidation-runs/:runId
```

## YeYu Gamer Manager 本机门面

实验性的 YeYu Gamer 接入不是通用 Agent 执行器。启用后，已鉴权且启用的远端 Agent 与可信本机调用方可通过 RabiRoute Manager 读取 `/api/agent/yeyu-gamer/{health,meta,snapshot,capabilities}`，以及向 `/api/agent/yeyu-gamer/work-items` 派发 `mode: "plan"` 的 work item。调用方必须使用新鲜 snapshot 的 `stateVersion` 和稳定的幂等键；成功回执只证明 Manager 已记录计划项。

门面向已鉴权且启用的远端 Agent 提供同一组公开接口；无 Agent 凭据的本机调用继续通过原 loopback、Host、Origin 与转发头检查。下游目标固定为 `http://127.0.0.1:8877/api/v1`。凭据来自 YeYu Gamer 本机运行目录的独立 `rabiroute.token`，不得写入 RabiRoute 配置或返回给调用方。接口不提供 claim、decision、capability invocation、Shell、路径、点击或旧脚本入口。配置、请求和无游戏启动验收方式见 [YeYu Gamer Manager 本机接入](yeyu-gamer-manager-integration.md)。

## 错误边界

Agent 不应该：

- 直接修改沉淀记忆。
- 把聊天日志原样写成记忆。
- 把计划归档当成需要自己判断的事项。
- 在没有需要时请求全量记忆或全量计划。
- 把 RabiRoute 当成完整 Agent OS 或执行器队列。

Agent 应该：

- 用计划接口维护关注项。
- 用近期记忆接口记录自己主动总结出的上下文，并填写可召回的 `keywords`。
- 需要详情时按 ID 查询。
- 收到记忆整理触发时只返回沉淀记忆。

## 角色技能接口

角色技能是角色目录下的可复用操作指南，放在：

```text
data/roles/<RoleId>/skills/*.md
data/roles/<RoleId>/skills/<skill-folder>/SKILL.md
```

每个技能文件使用 Markdown 正文和简单 frontmatter：

```markdown
---
id: configuration-triage
title: Configuration triage
summary: Diagnose setup issues by separating input, route match, delivery, and reply.
keywords: configuration, route miss, agent delivery, outbox
updatedAt: 2026-06-18T00:00:00.000Z
status: active
---
# Configuration triage

...
```

RabiRoute 在投递前只读取技能元信息：`id`、`title`、`summary` 和 `keywords`。技能正文不会默认进入每条 Agent 消息。

查询角色技能：

```http
GET /roles/:roleId/skills
GET /roles/:roleId/skills/:skillId
```

列表接口只返回元信息。单项接口返回完整正文。Agent 在 `[处理前上下文确认]` 里看到 `role_skill` 条目时，回复、更新计划/记忆或执行外部动作前应先按 GET 路径读取技能全文。

### 下载指定技能目录

`GET /api/roles/:roleId/skills/:skillId/download` 返回该技能的完整 ZIP；`GET /roles/:roleId/skills/:skillId/download` 是同权限别名。不接受查询参数、任意文件路径或批量角色导出。远端调用复用已登记节点凭据及准确 Agent 身份，不要求该角色另有 Route 绑定或逐技能授权；本机使用当前连接。

目录型技能保留所有普通文件、子目录和字节，包括 `scripts/`、`references/`、`agents/`、隐藏文件及二进制配套文件，ZIP 顶层为 `<skillId>/`。平面 Markdown 技能只生成 `<skillId>/SKILL.md`。按技能索引 ID 找真实入口，不假定 frontmatter `id` 等于目录名；重复 ID 返回冲突。不沿 Markdown 引用追踪根外路径或其他技能，需要另一技能时单独下载。下载的是当前 Manager 管理的技能内容，不会将其复制到公开 `resources` 或发布包。

示例（Bash；使用 Hook 给出的已安装连接程序路径，替换占位符，不在远端使用本机 Host 或猜端口）：

安装 launcher 会以当前不可变 release 目录作为工作目录，`./` 不指向用户 shell 或项目目录。请明确选择本机 Rabi Agent 安装目录外、已存在的父目录，并为 `--output` 提供绝对文件路径；最终文件必须不存在。以下 Bash 示例仅在你已选择并确认 `$HOME/Downloads` 存在且位于安装目录外时使用；否则替换为你选择的已有目录，不自动创建目录。`$HOME` 由 shell 展开为绝对路径。

```bash
node rabi-agent.mjs --api GET "/api/roles/<roleId>/skills/<skillId>/download" --agent-type codex --id "<FULL_SESSION_ID>" --output "$HOME/Downloads/selected-skill.zip"
```

连接程序从私有配置读取 `managerUrl` 和节点凭据，前后核对 `/meta` 的 generation 与实例身份，拒绝重定向。`--output` 仅用于上述 GET 下载；目标父目录须存在，不覆盖已有文件，不自动解压、安装或运行脚本。客户端流式校验 `Content-Length`、`x-rabiroute-content-sha256` 与 ZIP 签名后，以不覆盖方式完成本地文件；返回 `ok`、本地路径、字节数和 SHA-256。失败删除临时文件，不把 JSON 错误保存为 ZIP。普通 `--api` 的 JSON 输出不能用作二进制下载。原子非覆盖完成依赖目标文件系统支持硬链接；不支持的 Mac/NAS 文件系统明确失败，不自动降级为可能覆盖的复制或重命名。若目标已完成但临时文件清理失败，固定错误会以 `committed:true` 提示目标可能已经存在，应先检查现有文件并与可信 SHA-256 人工核对，不自动重下。下载失败保留固定的本地错误码及允许的 HTTP 状态，不回显服务端正文、传输异常或凭据。

响应为 `application/zip`，包含安全 `Content-Disposition: attachment`、`Content-Length`、`x-rabiroute-content-sha256`、强 ETag 和 `Cache-Control: private, no-store`；不承诺 Range/断点续传。服务端在有界交互工作进程中先完整生成并校验，再流式响应；IPC 不传整包 Buffer/base64。默认限单文件 16 MiB、原始累计 64 MiB、4096 个文件/目录条目、深度 32、ZIP 68 MiB。路径穿越、软链/junction、硬链接、非普通文件、不安全跨平台名称或大小写/Unicode 规范化名称冲突会使整包失败；超限也不截断或静默漏文件。读取期间源目录变化返回冲突。技能目录只能由受信本机拥有者维护；Node 的路径检查不等于抵抗拥有本机写权限者的任意并发替换。

| HTTP | 含义与处理 |
| --- | --- |
| 401 | 凭据缺失或无效；核对已登记连接配置，不公开凭据。 |
| 403 | 节点/Agent 连接已停用或来源证明失效，或技能路径/链接不安全；核对当前连接或由技能拥有者检查源目录，不要求追加角色绑定。 |
| 404 | 角色或技能不存在；刷新技能列表并核对 ID。 |
| 409 | 技能 ID/归档名称冲突或生成期间源内容变化；由拥有者解决后重新下载。 |
| 413 | 文件、条目、深度或包大小超限；明确缩小技能包，不接受残缺文件。 |
| 503 | 队列忙、超时或工作进程退出未确认；不当作空技能包，不自动反复重试。 |
| 500 | 内部生成或传输失败；保留错误码交 Manager 拥有者排查。 |

整个 Manager 最多同时持有 4 份下载租约，覆盖生成、慢客户端传输和退出未确认的隔离工件；超过上限在创建临时目录前返回 503。成包后的传输限时 30 秒，超时断流并清理，不让慢客户端无限占盘。客户端断连取消生成/传输并清理私有临时工件；退出未确认时保留隔离工件和名额至工作进程实际关闭；清理失败也不提前释放名额。Mac 上的 Node 可以下载 `.ps1`，但这不证明已安装 PowerShell、脚本路径适用于 Mac 或脚本已通过执行门禁。下载成功仅证明文件完整性，不是执行授权。本合同面向已登记 Rabi Agent 到配置 Manager 的连接；公网 RabiLink 大包转发和实际跨机下载仍须单独验收，不能以本地测试代替。

计划可选 `messageChannels` 列表，Agent 可在创建计划或 PATCH 时绑定；省略或 `[]` 均合法，不阻断建计划、执行或角色事件投递。每项为 `{channel, gatewayId, params}`，复用事件投递的 NapCat 群／个人 QQ 与语音参数。计划渠道只用于绑定 Codex 任务的最终结果；与角色规则共同匹配，同一任务、轮次、目标去重。Hook 自动通知不要求原始群消息编号，也不被旧引用式进度通知的失败阻断；Agent 主动回复仍尽量引用来源。


计划与记忆摘要搜索及自动增量缓存接口见 [搜索合同](knowledge-search.md)。

### 错误原因与语言

Manager 失败响应附带 `errorMessages`，包含 zh-CN 和 `en`，并保留原始 message、机器码、提交状态和请求编号。WebGUI 按当前语言显示。已登记的参数、附件、版本冲突和存储错误显示本地化原因；未登记的第三方异常保留诊断原文，不推断未知原因。

正式回传的 inReplyToRequestId 关联请求时可省略 prompt，result 与 nextAction 仍必填；普通发送仍要求 prompt。新回复不生成历史结束标记。

计划步骤资源记录及分批归档见[计划附件与步骤文件记录](plan-resources.md)。


## 桌宠移动 / Desktop-pet movement

Agent 使用 `POST /api/desktop-pet/roles/:roleId/motion`，并用
`GET /api/desktop-pet/roles/:roleId/motion/:requestId` 查询实际执行结果。
接口只控制桌宠，不改变应用窗口焦点或位置，不修改闲逛配置。
完整参数、幂等与运行限制见[桌宠移动接口](desktop-pet-agent-motion.md)。

## 可选的聊天发送前索引核对

此功能默认关闭。只有用户明确设置 `messageAdapterPolicies.<消息端>.conversationReview.enabled=true` 才执行下述核对；省略或设为 `false` 时，发送不读取聊天历史，也不因历史读取失败要求二次确认。WebGUI 的 Route → 消息端设置 →“发送前聊天核对”可开启或关闭。已配置的消息数量不隐含启用；原配置没有 `enabled` 的也按关闭处理。

读取 Worker 超时返回 HTTP 503、`status=failed`、`errorCode=MANAGER_READ_TIMEOUT`，错误含具体读取任务类别；不再误报 HTTP 400 无效请求。读取失败仍须核对原 deliveryId 回执，不自动重发。此分类修复和缺省依赖移除已有源码测试，不能代替原故障机器的验收。

显式启用后，各聊天渠道（QQ、企业微信、微信、飞书、RabiLink、语音、角色聊天面板）共用 `/api/agent/send` 的 `conversationContext`：

```json
{ "conversationContext": { "lastReadMessageIndex": "c1.<会话范围>.<账本序号>", "confirmationToken": "<需要确认时，使用本次返回的凭证>" } }
```

- 已读索引与目标会话当前索引相同，正常进入发送；不再有其它发送检查阻塞才会投递。索引是 Rabi 双向聊天账本序号，包含别人和 Agent 的消息，不是 QQ 等平台的消息 ID。AgentPacket 的已读索引只覆盖本轮已展示的消息。
- 请求未带索引时，优先读取同一 `sender.agentType + sender.sessionId + 角色/账号/会话` 的已核对缓存；缓存没有记录时返回最近 50 条并要求确认。缓存仅为当前 Manager 生命周期内的派生状态，24 小时不用即过期，重启后重新核对。不会把发出提示或发送期间新到的消息自动标为已读。
- 索引落后时返回其后的新增消息；默认最多 100 条。超过时返回索引后的最早 50 条和最新 50 条，说明省略数量及 `omittedRange`。配置为奇数时，前段多一条。错误会话索引或超前索引按重新初始化处理。
- 返回 HTTP 409、`conversation_context_confirmation_required`、`conversationContext.messages`、`latestMessageIndex`、`confirmationToken`、`expiresAt` 和搜索范围；此时未创建新的发送回执或 Outbox 项。Agent 应阅读消息，重新判断正文是否适合，必要时搜索省略内容；再次调用传最新索引和确认凭证，保留原 deliveryId。修改正文需要重新确认。凭证十分钟有效，并绑定 Agent、deliveryId、渠道、目标和正文；确认后又有新消息仍会再次阻止发送。
- 同一会话的发送按顺序核对并执行，不同会话可并行；不同 Agent 的缓存和确认凭证独立。同群另一个 Agent 的回复也会令旧索引过期。已有发送回执的重试按原幂等合同处理，不重发；回执返回当前索引或明确的 `conversationContextError`，不会因发送后的读取失败隐藏已提交回执。发送期间新增消息会随结果返回，并留待下一次发送核对。
- 每个消息端的 `messageAdapterPolicies.<消息端>.conversationReview` 可设置 `initialMessageCount`（1–500，默认 50）及 `maxIncrementalMessages`（2–500，默认 100）；WebGUI 在消息端设置的“发送前聊天核对”编辑同一配置。单条超长正文最多返回 6000 字并标记 `textTruncated`，全文可查询。
- 省略内容使用返回的 `search.path`（`GET /api/agent/chat-history`）：传 `routeId`、`channel`、JSON 编码的 `params`、`afterSequence`（不含）、`beforeSequence`（含）、`query` 和 `limit`（最多 200）。它按发送目标读取同一正式账本，不要求角色绑定；返回数量仍不代表全部历史。已有 `message-endpoint-history` 同样支持这两个序号范围过滤，不能用平台消息 ID 代替序号。
- 已初始化账本缺失 `conversation/current.jsonl` 或归档索引，或读取遇到损坏索引、损坏记录、缺失分卷时，历史查询与发送前检查返回错误；先恢复原账本，再重试。首次使用且尚无账本时仍可按空会话完成确认。已有发送回执保持原幂等处理。

计划审批反馈不使用聊天索引。旧 FenneNote 参数已迁移到 speech 渠道，是否核对由 speech 的上述配置决定。既有来源引用、图片、发送前事实核验、文风、长度和幂等检查继续生效；聊天索引核对不改变接口权限。

## 远端终端接口

主机 Agent 同样可调用。`GET /api/lan-agent/instances/:instanceId/terminals/:terminalId?after=0&waitMs=25000` 返回 `terminal`、`outputEvents`、`nextOutputSequence`、`truncated`；没有新输出时事件等待，最长 25 秒。文件互传、窗口查询和截图使用 `POST /api/lan-agent/instances/:instanceId/computer`，不依赖关联 Agent 后端；完整参数和限制见[电脑接口](remote-computer-client.md)。

现有已鉴权连接可使用以下接口；Windows 连接器 0.2.2 默认提供 CMD 和 PowerShell。

- GET /api/lan-agent/instances/:instanceId/terminals：返回 data.shells 和 data.sessions；会话含 terminalId、shell、cwd、state、pid、createdAt、nextInputSequence 和退出码。
- POST 同一路径：action 为 open、list、get、input、resize 或 close。open 需要稳定 UUID terminalId、shell=cmd|powershell，可选已有绝对目录 cwd；get/close 需要 terminalId；input 需要 terminalId、从 1 递增的 sequence 和最多 16 KiB 的 data；resize 需要 cols=20..400、rows=5..200。
- GET /api/lan-agent/instances/:instanceId/terminals/:terminalId/events?after=0：SSE 输出。事件含递增 sequence、type=output|exit|gap|disconnected，以及 data 或 exitCode。after 仅用于断线后补漏，不用于轮询；早于 256 KiB 有界缓存时先返回 gap。

同一 terminalId 的重复 open 只返回原会话，类型或目录不同拒绝。input 同序号同内容只返回原接收事实；不同内容、过期回执或跳号拒绝。接收成功仅表示输入已交给原终端，不表示命令成功执行。超时、5xx 或断线后使用 list/get 核对 nextInputSequence，不更换 ID、自动重建或重发。窗口关闭仅断开查看；close 结束会话及子程序。节点连接变化结束原终端和旧流。命令与输出不进入角色、计划或持久日志。容量与进程生命周期见 [连接器说明](../apps/rabi-agent/README.md)。

## 通用可靠 Agent 投递记录

`GET /api/agent/deliveries` 与 `GET /api/agent/deliveries/:deliveryId` 提供正式只读记录，nodeId 选择原电脑队列；`GET /api/agent/deliveries/caller/:callerDeliveryId` 查询当前可信来源的原键，不发送正文。客户端先持久受理明确的 Agent send，再自动恢复原 ID；此行为不改变其它 HTTP 写入的重放合同。[完整合同、GUI 和限制](reliable-agent-delivery.md)。


### Agent Hook 消息来源

自动Hook发起的Agent投递使用 `messageSource.type="agent_hook"`，统一显示为 `AgentHook`；普通Agent主动投递仍用 `agent`。两者共享真实来源处理端、完整会话ID与工作目录核验；`sourceAgentType`仍是原会话职责，不能填AgentHook代替角色。新类型经本机、已鉴权远端、端点持久投递和消息历史保留，不允许用它绕过来源或目标校验。旧记录继续按原类型展示，不追写历史。


### 查无原计划或会话时的只读恢复提示

确定的计划读取或历史查询 404 保留原状态码、`code` 和 `message`，并在既有 `nextAction` 中提示当前角色范围内的名称查询：`GET /api/roles/:roleId/plans?limit=20&query=<URL编码的名称>&sort=updated`。省略 `query` 可列最近更新计划，沿 `nextCursor` 分页；`limit` 必须保留，否则旧完整目录分支不应用该筛选。查无结果只表示本次范围没有匹配，不能据此新建计划或改绑。

确定 `resolution=missing` 的线程 404 返回只读提示：在原实例与 Agent 绑定内 `POST /api/agent/threads`，使用 `action:list`、原 `agentAdapter`、`query`、`limit:20`、`offset:0` 按名称查询。`query` 留空列出可发现会话，核对返回的 `updatedAt` 判断最近活动，沿 `nextOffset` 翻页；不保证每个 Adapter 的天然排序一致。核对完整 `threadId`、名称和工作目录后读取原任务。原 `deliveryId/actual` 保留，不自动创建替代任务或重发未确认消息。

此提示仅附加于确定的查无分支，不把线程读取的既有 400、管理超时、连接故障或未知回执改称 404，也不保证名称搜索能够修复底层存储或索引问题。
