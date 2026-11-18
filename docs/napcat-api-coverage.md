# NapCat 接口覆盖与调用

[English](napcat-api-coverage_en.md)

## 版本与覆盖

基线为 NapCat 4.18.4 发行文件，SHA-256 为 `66dfaa1b9e7530d493089c70d24810f4e23c31d129e1662949558ce30ce52a92`。上游版本变化后需重新核对发行物。

[原生合同矩阵](../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json)逐项列出 167 个基础动作、501 个含别名的名称、112 个 WebUI 方法与路径、25 个实例化事件和 6 个事件基类。[Rabi 覆盖矩阵](../src/plugins/io.rabiroute.endpoint.napcat/contracts/rabi-coverage-4.18.4.json)记录各项执行合同、参数、返回范围及残留原因。

| 范围 | 调用形态与边界 |
| --- | --- |
| OneBot | 固定动作目录包含读取、原账本写入、既有 owner 兼容入口和源绑定资源形态。逐项状态以覆盖矩阵为准。 |
| 消息外发 | 12 个原生发送形态、纯文本合并转发和来源消息快捷回复进入统一 `agent.send` 策略、Outbox 与回执。 |
| 文件与流 | 管理附件引用、原消息文件来源和所选原生文件引用分别沿原 owner 核验。下载帧转换为 SSE，内容流分块计算摘要并处理背压。 |
| WebUI | 104 个固定调用形态与 8 个宿主边界映射。包含配置、认证、文件、Reactive 生命周期及维护动作，逐项执行条件在合同中列出。 |
| 事件 | 原 WebSocket 入站处理生成类型化元数据。申请事件的原标记封存在本机保护对象中，调用者使用不透明引用。 |

任意 `send_packet` 原始协议转发及上游明确的测试专用动作保留具体不可用原因。Ark getter 等受限视图按其声明字段返回，完整原生形态仍待独立验收。`send_group_ark_share` 与 `send_ark_share` 的上游处理器获取卡片，按该行为提供合同。

## 发现和调用

先用 `GET /api/search` 查动作，再读取其帮助合同。固定原生入口为 `POST /api/agent/qq/onebot/<action>`。只读例子如下。

```json
{"routeId":"example-route","instanceId":"example-napcat","params":{"group_id":"100000001"}}
```

副作用动作携带稳定 `deliveryId`。相同编号与参数查询原持久记录，冲突返回 409。202 保持原结果待确认，沿 `GET /api/agent/qq/onebot-receipts/<deliveryId>?routeId=example-route&instanceId=example-napcat` 查询。`_async` 与 `_rate_limited` 是原同步 Rabi 合同的发现别名。调用者须读取实际合同，兼容形态的参数可能与上游原始 JSON 不同。

每次调用绑定已启用的 Route、明确实例与配置 QQ，并核对原生账号。现有连接权限、取消、超时与读取配额继续生效。外发调用提供实际 Agent 身份，由统一发送入口处理语言、长度、媒体策略和原回执。原生仅确认接收的动作返回 `acknowledged`，平台可见性另行核验。

管理上传文件使用原上传或计划附件引用。源消息媒体使用精确会话、消息 ID 与附件序号。Native 文件及目录使用其原 owner 生成的不透明引用。调用者传入的路径、URL、base64 或自造资源清单不能替代来源证明。公开资源仅包含经过投影的内容，内部路径、申请标记和敏感来源清单经过本机保护器封存。

快捷操作以精确原消息或申请事件引用为来源。回复沿 `agent.send`，删除、踢人、禁言和申请处理进入对应原生动作 owner。各子动作保留稳定编号与原回执，部分成功或未知时不自动重投。禁言时间由请求明确给出。

## WebUI 与生命周期

固定读取入口为 `POST /api/agent/qq/webui/<id>`，管理入口为 `POST /api/agent/qq/webui-management/<id>`。读写均携带 `routeId`、`instanceId` 与合同参数。写入另需稳定 `deliveryId`，原管理回执使用 `GET /api/agent/qq/webui-management-receipts/<deliveryId>`。

原 WebUI 会话 owner 管理鉴权并核对所选账号。敏感值仅进入具体原生配置或认证 owner，返回值按公开合同投影。文件管理绑定所选 Native 来源，Reactive 打开、关闭及退出由同一插件版本持有并等待清理。Token 更新经过原持久 Route CAS，保留原操作与结果不确定时的恢复入口。

镜像偏好通过 `mirror-custom.set` 接受完整 HTTP/S 前缀，空值清除偏好。原值在请求内存与原生配置 owner 中处理，公开回执保留摘要。该偏好影响原生进程内存，持久化和其他调用者后续选择分别核验。

## 加群与验证

4.18.4 注册表没有主动申请加入指定群的动作。`set_group_add_request` 处理已经收到的申请或邀请，原申请标记来自入站事件；`set_group_add_option` 修改现有群的入群设置。

实现验证使用私有端口、测试配置和 mock。覆盖矩阵、构建、隔离运行、安装采用及真实平台操作分别留证。真实 QQ、玩家群与在用 NapCat 服务不用于动作测试。安装后核对 Manager 与同一 Gateway 的 PID、generation、插件 hash 和 activationId。平台真实收发、媒体与管理变更按其具体授权独立验收。
