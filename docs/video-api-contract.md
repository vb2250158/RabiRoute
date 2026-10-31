<!-- docs-language-switch -->
<div align="center"><a href="./video-api-contract_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 媒体工作台接口的可执行合同

> 状态：源码迁移和隔离测试。整包构建、安装版、真实跨机、模型安装与实际生成分别确认。

`io.rabiroute.manager.video` 通过同一组可执行定义注册 35 条合同：34 个固定方法与路径，加 1 条原生动态模型代理。固定入口包含 23 个 JSON 操作、2 个 SSE 操作和 9 个原生 HTTP exchange；动态代理另外占 1 条 exchange。入口执行和活动目录复用这些定义，旧 bool/prefix 大分发、项目 HTTP wrapper 和专属 HTTP Tracker 已删除。

插件的正式 manifest 声明 `manager.core@1`、`host.manager.http@1`、`host.manager.video@1` 与 `host.manager.operations@1`。HTTP 服务仍负责原生 JSON 读取与 Manager 事件发布；operations 服务负责注册上述合同。生命周期回归直接读取该 manifest，由真实 kernel 检查依赖和 `context.services.require()`，并验证遗漏声明被拒绝、恢复声明后 35 条合同可用，以及缺少提供者时不恢复任务、不发布合同。

## 入口与原生拥有者

下表路径都以 `/api/video` 开头，数量按方法与路径组合计算。

| 功能 | 方法与路径 | 数量 |
| --- | --- | --- |
| 项目 | GET/POST `/projects`；GET/PUT `/projects/:mediaId` | 4 |
| 工作台状态与运行 | GET `/status`；POST `/runtime/start`、`/runtime/stop` | 3 |
| 工作台任务 | GET/POST `/jobs`；GET `/jobs/:mediaId`；POST `/jobs/:mediaId/cancel`；GET `/jobs/:mediaId/image`、`/video`（同一任务前缀） | 6 |
| 本机素材 | POST `/assets`；GET `/assets/:mediaId`（原媒体或 `metadata=1`） | 2 |
| 模型 | GET `/models`、`/models/initialization`；POST `/models/initialize`；GET/PATCH `/models/settings`；POST `/models/runtime`、`/models/:modelId/download` | 7 |
| 算力状态与运行 | GET `/compute/status`；POST `/compute/runtime/start`、`/compute/runtime/stop` | 3 |
| 算力临时素材 | POST `/compute/assets`；DELETE `/compute/assets/:mediaId` | 2 |
| 算力任务 | POST `/compute/jobs`；GET/DELETE `/compute/jobs/:mediaId`；GET `/compute/jobs/:mediaId/image`、`/video`、`/events`（同一任务前缀，events 为 SSE） | 6 |
| 算力变化通知 | GET `/compute/events`（SSE） | 1 |
| 动态模型代理 | 任意实际 HTTP 方法，原始路径以 `/models` 开头，选择 `computeDeviceId` 后调用原远端 JSON owner | 1 条动态合同 |

`VideoService` 继续持有队列、任务文件、幂等键、生成状态和结果归属；`VideoModels` 持有模型目录 revision 与安装/下载任务；`VideoAssets` 持有素材与检查状态；`VideoProjects` 持有项目 ID、内容与 revision；`RemoteVideoCompute` 持有选定电脑的原协议、临时输入和回执恢复。进程仍使用原 `createVideoRuntime()` 与 process leases。

候选激活只读取任务与模型设置快照，不创建共享目录、不改写未完成任务，也不覆盖媒体检查脚本。正式发布后，`lifecycle.mjs` 先等待上一激活的实际请求、任务和进程租约清理完成，再重新读取最新记录、恢复未完成状态及准备共享组件。等待期间这 35 条入口返回原生 503；它是启动状态，不是额外权限。失败候选的清理不会持久化其只读任务副本，旧激活仍可服务。模型配置在旧 owner 排空后重新读取，避免候选快照覆盖旧 owner 的最后回执或配置修订。

插件在当前激活的模块内创建 functional owner，再交给 `createVideoOperations()` 生成合同。公共工厂不静态加载另一份插件实现，避免热更新时错误类型或 owner 模块身份分叉。原 `video:METHOD:/api/video/...` 发现 ID 从固定定义派生为别名，原 `:mediaId` 参数名保留；动态代理原来没有该发现 ID，不虚构旧别名。

## 字段合同与兼容校验

`contracts.mjs` 是任务参数、项目规则及模型配置字段的唯一插件定义源。原 `workflow.validateCommand` 直接复用该模块的同一函数；项目 owner 读取其 ID、卡片类型、数量与标题规则；模型 owner 读取其字段集、revision 与布局规则。当前 activation 将这组定义交给公共工厂，目录与 OpenAPI 展开项目、任务、状态、模型目录、安装任务和空间预算字段；不再用统一空 Schema 代替这些稳定 DTO。

输入 Schema 描述字段、默认与限制，具体拒绝仍由同源原生校验执行：它保留项目 ID 的原隐式字符串转换、标题裁剪、任务数值的 null 默认、项目扩展字段保存，以及模型配置未知字段或 revision 错误的原 409。解析器不额外做类型转换、删字段或注入默认，也不提前把原生错误改为框架 400。目录中的具名 validator 明确这些条件；这不宣称全部限制都由 JSON Schema 单独验证。

项目画布的 drafts 和扩展内容、catalog/provider 扩展、原始素材上传及选定远端的模型 JSON 仍按原 owner 处理。远端结果使用显式开放分支，不能被本机模型设置 DTO 收窄；本地与远端响应的字段完整度分别表达。清理后的 compute 回执可省略 prompt、进度与其他已清理字段。

## 动态模型代理

第 35 条合同使用 `method: "*"`、`/api/video/models:suffix` 与显式 `pathRemainder: "suffix"`，表示原 `startsWith('/models')` 语义，包括 `/modelsXYZ`、空后缀和多级路径。通用客户端必须显式提供实际方法。相同方法的固定合同优先，动态合同在已知路径返回 405 前处理剩余请求；OpenAPI 通过 `x-rabiroute-any-method` 表达该能力。

选定 `computeDeviceId` 后，直接调用同一 `RemoteVideoCompute.json()`；路径使用原始 pathname，不把代理重写成另一个功能清单。POST/PATCH 沿原 4 KiB 读取器解码 JSON，其他方法忽略正文。原远端 JSON 结果保持完整，包括名为 `metadata` 或 `frames` 的普通字段；不将其误识别为本机素材或文件流。原远端错误继续由该 owner 处理；没有选定电脑时保留本机未知模型操作的 404，不转用本机算力。

原入口的路径正确性限制继续生效，例如已鉴权 Agent 仍不能用编码分隔符绕过请求目标检查。这是原资源约束，不能把它改成逐功能授权。所有已鉴权且启用的连接默认使用全部公开接口；人格、计划、Skill 和模型发现不提供第二层许可。原只读模式、固定磁盘、模型目录、进程、队列和资源归属限制继续生效。

## 正文、状态与恢复

项目创建保留 4 KiB 正文上限，项目保存为 64 MiB，任务提交为 25 MiB，模型 JSON 为 4 KiB。原始素材按类型保留 PNG 9 MiB、MP4 64 MiB、WAV 16 MiB 的上限及原检查流程。上传不先转换成 JSON/base64，也不要求已经存在本机推理环境才能选择原远端检查流程。

项目按原 revision 保存，模型配置按原 expectedRevision 校验。任务使用原 8–128 字符 `Idempotency-Key`，同键同意图读回原任务，不同意图冲突；计算目标属于原意图。计算回执仍与工作台历史分开，输出清理后保留原最小回执，不重跑推理。原 compute 读取触发的有限保留清理继续由同一服务执行。

固定 JSON 正文改由公共解析器解码，畸形 JSON/超限返回公共 400/413；原字段与业务校验继续由 native owner 执行。动态模型与两条条件正文 exchange 保留原读取器行为。本机 POST `/models/runtime`、`/models/:modelId/download` 原来忽略正文，选择远端时才读取 4 KiB JSON，因此保留为原生 exchange。目录明确区分这些边界，不宣称枚举了所有模型工作流或 provider 动态字段。

请求在正文前捕获原连接，继续在原队列、文件、进程和网络边界复验。撤权后重新启用 Node 不使旧请求恢复。已派发写入的原 access owner 可通过公共错误的 `mutationOutcome: "unknown"` 保留可信派发证据；尚未派发为 `not_started`，不附原业务结果，也不承诺回滚。已接受的生成、安装或下载仍归原插件生命周期，不捕获发起请求的权限。恢复时查询原项目、key、工作台任务和远端回执，不自动重投或更换电脑。

## 媒体、SSE 与退役

媒体读取直接打开原 owner 确认的本机路径，保留 MIME、文件名、单段/后缀 Range、200/206/416、Content-Length 与 Content-Range。素材支持 PNG、MP4、WAV，任务输出按原模型类型选择 PNG 或 MP4，不限定为视频字节。客户端断开、背压等待或插件退役时取消并等待原文件关闭；stat 尚未完成时取消，不再创建原始读取流。

两条 SSE 继续使用原 publish 通知和任务 view。模型变化发送 `compute` 事件；任务发送 `progress`，终态结束，保留原 20 秒 heartbeat 与注释帧。合同用原始 SSE 字节表达，不将注释变成新的业务事件。订阅数量与原一致，新增有界等待队列防止慢消费者无限占用内存。退役取消订阅与计时器，唤醒并结束迭代；创建后未披露的订阅也在拒绝时取消。

插件同时退役两组注册、关闭订阅与原媒体检查/模型/服务拥有者，等待原请求和后台清理结束。远端 JSON 在等待响应头时也接收该请求的取消信号，退役等待原上游关闭，不留下脱离租约的 HTTP 工作。

## 证据边界

测试使用原项目/任务/素材临时文件、受控媒体检查和运行驱动、真实合同注册器、空 Node 登记及受控 HTTP 上游。覆盖项目重开与 CAS、原键重放/冲突、三类素材及 Range、计算输出归属和清理、SSE 终态/取消、Node ABA、背压退役、动态方法与路径、条件正文、原错误类型及未确认写入证据。

测试不执行真实推理、模型下载、安装、真实外部服务或消息投递。源码和这些隔离证据不等于 GPU、画面、正式安装包或真实跨机验收；实际使用与成熟度见[媒体工作台说明](video-generation-plugin.md)，整体迁移见[目标架构](api-contract-discovery-target-architecture.md)。
