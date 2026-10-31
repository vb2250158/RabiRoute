<!-- docs-language-switch -->
<div align="center"><a href="./xiaomi-home-api-contract_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# Xiaomi Home 接口的可执行合同

> 状态：源码迁移与隔离 HTTP、原生服务测试。整包构建、安装版、真实跨机与家居设备验收分别确认。

`io.rabiroute.manager.xiaomi-home` 通过 `createXiaomiHomeManagerOperations()` 注册 53 个精确入口：48 个 JSON 操作、1 个 HTML 操作、1 个 SSE 操作和 3 个原生字节代理。相同定义用于请求执行与活动目录；原 `home:METHOD:路径` 发现 ID 从定义派生为别名，不创建第二条路由。旧 bool HTTP handler、手写 exact/prefix 清单和专属 HTTP Tracker 已移除。

## 入口与拥有者

下列路径都以 `/api/agent/xiaomi-home` 开头。数量按方法与路径组合计算；没有通配 prefix dispatcher 或新增 WebSocket 入口。

| 原功能 | 方法与路径 | 数量 |
| --- | --- | --- |
| 健康、设置 | GET `/health`；GET/PUT `/settings` | 3 |
| HA 部署 | GET/PUT `/deployment`；POST `/deployment/start`、`/deployment/install`；GET `/deployment/events`（SSE） | 5 |
| HA 凭据 | GET/POST/DELETE `/auth`；POST `/auth/refresh` | 4 |
| 资源与设备 | GET `/resources`、`/resources/:resourceId`、`/devices`、`/devices/:deviceId`、`/entity-actions`、`/capabilities` | 6 |
| 动作与事件 | GET/POST `/action-requests`；POST `/events` | 3 |
| 录像文件 | GET/POST `/artifacts`；GET `/artifacts/lifecycle`、`/artifacts/:artifactId`、`/artifacts/:artifactId/content`（字节） | 5 |
| 远程驾驶 | GET `/vacuum-remote/capabilities`、`/vacuum-remote/status`；POST `/vacuum-remote/start`、`/pulse`、`/stop`、`/exit`（后 3 项同前缀） | 6 |
| 米家云账号与设备 | GET `/vacuum-cloud/status`、`/vacuum-cloud/devices`；POST `/vacuum-cloud/login`、`/vacuum-cloud/login/poll` | 4 |
| 云文件与地图 | GET `/vacuum-cloud/plugin-package`、`/plugin-information`、`/map`、`/path`、`/trajectory`、`/feedback`、`/position`、`/telemetry`（同 `/vacuum-cloud` 前缀） | 8 |
| 云视频 | GET `/vacuum-cloud/video/network`、`/status`、`/password`、`/stream`（字节）、`/frame`（字节）；POST `/vacuum-cloud/video/start`、`/stop`、`/password/forget`（同 `/vacuum-cloud/video` 前缀） | 8 |
| 云地图页面 | GET `/vacuum-cloud/connect`（HTML） | 1 |

`createXiaomiHomeOperationsOwner()` 直接调用原 `XiaomiHomeRuntimeController`、HA 部署、设备客户端、动作回执、受保护凭据、artifact、云会话、远程驾驶及视频服务。接口层不复制业务存储，也不另建账号或设备状态。JSON 写入由原服务校验 DTO、revision、资源约束和幂等意图；目录中明确标识原生校验边界，没有把开放 Schema 冒充完整业务字段枚举。

已鉴权且启用的远端连接可以访问全部公开入口，部署操作也适用；实际安装和启动仍发生在 Manager 所在电脑，并遵守原系统管理员交互与安装归属约束。人格、计划、Skill 和设备发现不提供第二层功能许可。原 HA 地址策略、受保护账号归属、资源路径约束、设备状态版本、生命周期围栏及稳定幂等键继续生效。

## 身份、写入与恢复

请求在读取正文前捕获原 ingress 身份，并检查原生命周期围栏和该操作所需的原幂等键。异步业务返回前继续复验原身份；撤权后重新启用 Node 不使旧请求重新有效。原服务接受 authority 的业务阶段继续在实际外部派发和本地提交边界复验；云会话等未接收该参数的原服务没有因此新增逐阶段取消保证。

设置与部署保留原 revision。凭据变更保留原认证 revision、候选地址与令牌同次验证、受保护保存和持久认证 mutation 回执；日志、响应与目录不包含明文凭据。设备动作使用原状态版本和原动作回执。发生超时或结果不确定时，查询原 key/session/action，不生成替代键，不自动重放家居动作或安装操作。原服务未提供通用幂等的写入，不因注册合同而获得新的幂等承诺。

读取操作声明忽略正文。JSON 操作保留原空正文 `{}`、任意 Content-Type 与无新增应用正文上限的读取规则；畸形 JSON 改由公共解析器返回 400，原生字段校验继续由原业务拥有者执行。已注册路径的不支持方法统一为 405 与 `Allow`。

## HTML、SSE 与原生字节

云地图 HTML 保留每次请求的随机 nonce、原 CSP、同源连接、无缓存及禁止引用来源泄漏策略。部署 SSE 订阅原 `HomeAssistantDeployment.subscribe()`，传递原部署快照；有界队列防止慢消费者无限增长。客户端关闭或插件退役时取消订阅，并等待正在执行的原生 inspect；不改成 HTTP 轮询。

artifact 内容使用原 descriptor、文件边界、读取审计和单段 HTTP Range，保持 200/206/416、Content-Range、Content-Length 与原 MIME。视频 stream/frame 继续从原 supervisor 所拥有的 sidecar 读取 MP4；不是 MJPEG，也没有新增摄像头启动通道。三条字节代理直接使用新提取的原生 `open()` / `openStream()`，没有转调旧 HTTP 分发器。

字节读取在插件退役或客户端断开时取消并等待原文件或上游 reader；视频在等待上游响应头时也接收同一取消信号。取消某个观看者只关闭其读取，不等于停止原摄像头会话。插件 disposer 同时停止新接纳、退役两组注册并停止原 runtime，等待它们结束后释放插件。

## 验证范围

专属测试使用真实合同注册器、临时持久文件、真实空 Node 登记、受控 HA HTTP 与 MP4 sidecar。验证原凭据连接、设备/资源目录、dry-run 动作及原键回执读回、Range 字节与头、HTML nonce、SSE 退役、pending read 撤权、上游打开前后取消和原生订阅等待。测试不调用真实 HA、云账号、家居设备、进程安装或 Agent 消息投递。

这些证据不证明真实摄像头可用、地图定位实时、设备已经执行动作或正式安装版已更新。功能成熟度与实际使用见[插件说明](../plugins/builtin/io.rabiroute.manager.xiaomi-home/1.0.0/README.md)；整体迁移见[目标架构](api-contract-discovery-target-architecture.md)。
