<!-- docs-language-switch -->
<div align="center">
<a href="./remote-persona-reference_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 本机路由使用远端人格

> 状态：0.3.19 实验实现。配置、受限读取、身份校验、消息投递包装和页面选择已有自动化测试；真实双 PC 的完整投递、断线恢复和长期运行仍需验收。两端复用同一 RabiLink 应用认证，自动交换并固定设备公钥，只开放人格读取；无需另行手工授予完整管理权限。来源 PC 必须提供新版 `persona-reference-v1` 能力，旧版需要升级。

本机消息路线（Route）可以使用另一台 PC 保存的人格正文、消息规则和最近消息额度。消息端、负责实际处理的 Agent、工作目录和消息审计仍使用这条本机 Route 的配置。选择远端人格不会把处理 Agent 自动换成远端 Agent，也不会导入或同步人格目录。

## 在页面中选择

1. 打开本机 WebGUI，进入目标 Route 的“人格配置”。
2. 在“人格来源 PC”中选择同一 RabiLink 应用内的来源 PC；“刷新远端 PC”重新读取设备状态。页面通过本机受管入口完成应用认证下的公钥握手。
3. 在“指向远端人格”中选择来源 PC 的人格，默认正文文件为 `persona.md`。
4. 确认正文摘要与只读配置已读取，再保存 Route。修改人格正文、头像、身份、自动化或知识时，在来源 PC 完成。
5. 按这条 Route 既有操作执行一次投递，检查本机诊断及目标 Agent 的实际收件。页面读取成功、配置保存成功和真实消息投递成功是三个不同结果。

来源选择器的本机项显示当前设备名称和 RabiPC 版本；其它 PC 显示其上报版本，旧设备未上报时显示“版本未知”。RabiLink 主页也标记本机并显示各台 PC 的版本。设备名称不是身份：与本机设备 ID 和 GUID 一致的条目属于本机，不另列为远端来源。如果两台电脑复制了同一份身份配置，先核对并分开两台的设备身份，再选择远端人格；不能只改显示名或取消本机过滤来绕过这个问题。版本文字不代替 `persona-reference-v1` 能力或鉴权检查。

离线、鉴权失败、需要升级和读取失败分别显示。已保存的远端引用会保留；读取失败会停止该 Route 的 Agent 投递，不使用本机同名人格。应用认证下的人格握手不会新增完整管理授权，也不会修改管理员已有的手工限权。

## 数据与执行归属

| 内容 | 拥有者与当前行为 |
| --- | --- |
| 人格正文、消息规则、最近消息额度 | 来源 PC 的人格；每次投递读取当次快照，不复制为本机人格配置。 |
| 消息端、实际处理 Agent、工作目录、入口开关 | 本机 Route；人格引用不改变这些选择。 |
| 本机收到的消息、最近消息上下文、投递与回传审计 | 本机 `data/route/<配置名>/`；不追加到本机同名人格目录。 |
| 远端计划、记忆、技能和历史资料 | 来源 PC；通过受限 peer `persona` 入口按需只读查询，不能凭远端路径直接读本机文件。 |
| 远端定时任务、脚本、计划秘书和记忆整理 | 不因引用而在本机启动；其运行仍由来源 PC 的配置和授权决定。 |
| Hook 与宿主权限 | 引用不会授予新权限，也不会把远端 Hook 设置变成本机宿主设置。 |

对外消息需要语言风格检查时，本机读取远端人格当前配置，调用来源 PC 的 `POST /api/roles/<RoleId>/persona-reference/language-style`，只提交 `{ "text": "待检查正文", "file": "persona.md", "revision": "当前快照 revision" }`。来源 PC 从已保存的人格配置取得风格地址并读取风格文件，拒绝调用方提供 `styleSkillUrl`；本机不解释远端文件路径。检查前后核对两端 Manager 身份和来源快照 revision，变化时拒绝结果。显式单次 `styleValidation=0` 保留现有规则，仍须成功读取远端配置，不绕过离线、身份或鉴权失败。人格预览不代表头像、声线或身份资料已在本机完整接入。

只有远端 `automationRules` 中“消息触发 → 投递 Agent”的规则参与这条本机 Route 的消息判断；定时和脚本规则不在本机执行。远端没有匹配消息规则时，本机记录未命中，不补成本机同名人格规则。

人格正文会进入本次 Agent 上下文，相关消息和投递证据仍受本机日志与数据保留规则约束。“不复制人格”指不建立第二个人格资料、计划或记忆真源，不表示网络读取和本次上下文完全没有本机数据。

本机人格目录查询和 Route 消息诊断不会混入同名本机人格。当前本机跨人格投递、角色面板和计划反馈入口拒绝把远端引用当成本机人格；普通远端绑定及同一 Agent 混合本机、远端 Route 的旧绑定都不能执行本机人格 Hook。远端知识仅通过 `persona` 服务读取；需要修改远端数据或执行远端动作时，必须另走来源 PC 相应的受管接口和授权合同。

## 配置合同

本机 `adapterConfig.json` 保存引用字段：

```json
{
  "agentRoleDeviceId": "peer-b",
  "agentRoleId": "Example",
  "agentRoleFile": "persona.md"
}
```

这是字段片段，应合入既有完整 Route 配置。`agentRoleDeviceId` 是稳定设备 ID，不是显示名称或地址；为空或未设置时仍选择本机人格。非空时必须同时给出原样有效的远端 `agentRoleId`，不能从 Route 名称或本机人格推断；带首尾空白、路径片段或非字符串的 ID 会拒绝，不静默修正成另一个人格。

Gateway 进程使用 `AGENT_ROLE_DEVICE_ID`、`AGENT_ROLE_ID` 和 `AGENT_ROLE_FILE` 接收同一引用；Manager 负责传递。来源、ID 和文件名之外的既有人格规则、上下文额度、语言风格和 Hook 投影不会写入本机 adapter 配置。本机 Route 的变量、语音投递模式和入口配置保留。

远端引用下的 `roleDir`、`rolePath` 为空；本机运行数据和临时上下文使用 Route 目录。代码不能通过同名 ID 构造本机角色路径作为替代。

## RabiLink 鉴权与版本要求

两端需要启用同一 RabiLink 应用连接并支持 `peer-tunnel-v1`，来源 PC 还需声明 `persona-reference-v1` 并提供本页的新接口。已有 RabiLink 应用认证承载 `bootstrap-persona` 信令，交换并固定两端 Ed25519 公钥；之后的请求复用[跨电脑通用连接](rabilink-peer-tunnel.md)的 LAN、P2P、Relay 选路。首次握手需要当前应用认证可用，不能仅凭局域网发现建立新信任。

页面使用本机 `POST /api/rabilink/peer/persona/bootstrap`，请求体仅为 `{ "deviceId": "peer-b" }`。该入口沿用 Manager 的 WebGUI 访问鉴权，不接受公钥、服务列表或任意地址。实际投递也使用同一受管握手。自动记录中，本机 A 固定来源 B 的公钥作为客户端；来源 B 只允许 A 的 `persona` 服务，不新增 `manager`。自动握手记录绑定当前 Relay 地址和应用 token；应用停用或密钥变更时拒绝访问，凭据变更后不能沿用旧记录，须通过当前应用认证重新握手。

来源 B 中针对调用方 A 的已有手工 `trustedDevices` 条目如果既不允许 `persona` 也不允许 `manager`，仍然拒绝，不自动扩展管理员的限制。已有完整 `manager` 授权可使用受限人格读取，但这项功能不会新增或扩大完整管理授权。A 只把 B 当服务器的客户端条目仍可保留空的入站 `services`。需要调整手工限权时，由管理员核对后处理。

`persona` 服务固定只允许 `GET /meta`、`GET /api/personas`、`GET /api/agent/help`，以及人格正文、知识搜索、计划、记忆和技能的规定只读列表与详情路径；另允许上述无数据修改的语言风格检查。它不允许 WebSocket、重定向、任意 Manager 路径、人格配置或知识写入、定时任务、脚本、消息投递和宿主 Hook。加入同一应用是此受限读取的信任范围，不能把应用 token 分享给不应读取人格资料的设备。

安装版每次从 `RabiRouteHost.exe --command status --json` 取得当前 `managerBaseUrl`、`applicationGenerationId` 和 `managerInstanceId`，再核对 `/meta`。源码模式使用当前结构化 READY 地址。不要保存端口、扫描端口或复用旧代地址。隧道的 LAN、P2P 和 Relay 选择与设备身份校验复用通用连接合同。

## 接口与身份围栏

来源 PC 的公开受管接口：

```text
GET  /api/roles/<RoleId>/persona-reference?file=persona.md
POST /api/roles/<RoleId>/persona-reference/language-style
```

`file` 只接受人格目录内的单个 `.md` / `.markdown` 文件名；拒绝路径跳转和指向目录外的链接。正文限制为 2 MiB，`personaConfig.json` 限制为 256 KiB；配置缺失可使用默认投影，损坏 JSON 会拒绝读取，超限文件不会截断后冒充完整人格。

成功响应为 `{ "code": 0, "data": ... }`，`data` 包含 `schemaVersion: 1`、真实 `roleId`、`file`、`document`、规范化 `personaConfig`、正文与原配置的 SHA-256 `revision`，以及来源 Manager 的 `applicationGenerationId`、`managerInstanceId`。

本机通过 `/api/rabilink/peer/http/<设备>/persona/...` 查询远端人格目录和配置。实际 Gateway 的内部解析入口只接受本机连接、当前 Route capability 和当前本机 Manager 身份，并以已保存引用为准；不能用调用参数换另一个设备、人格或文件。解析会核对远端 `/meta`、隧道 generation、快照身份和读取后的 `/meta`，还会复核本机身份与 Route 绑定。返回给 Gateway 的结果分别保留本机和远端身份。

Manager 的远端 HTTP 读取有 20 秒预算和 4 MiB 响应上限；Gateway 的完整请求另有 25 秒超时。页面预览也有 25 秒超时和 4 MiB 总响应上限，正文仍受独立 2 MiB 限制，并校验 SHA-256 revision。预览和独立正文页在读取前核对来源 `/meta` 身份与 `healthy` / `degraded` 就绪状态，读取后只核对身份；单纯健康变化不是切代。预览还要求快照身份与前后身份一致。快照仅用于当次请求，不作为持久人格缓存。

## 失败与验收

| 情况 | 结果与检查方向 |
| --- | --- |
| 来源 PC 离线或连接失败 | 保留引用，停止投递；检查设备运行状态及通用连接。 |
| 应用鉴权失败、密钥变更或手工条目明确限权 | 拒绝访问；核对应用连接、设备身份与已有手工限制，不自动扩大完整管理权限。 |
| 远端缺少新接口或返回旧格式 | 显示需要升级；升级来源 PC 后重新读取。 |
| 人格或文件不存在、JSON 损坏、超过限制 | 报告读取错误；修复来源资料，不用本机同名文件替代。 |
| 任一 Manager 切代、Route 绑定变化或身份不匹配 | 拒绝当前结果；重新发现当前地址并读取。 |
| 远端规则未命中消息 | 记录未命中；检查来源人格的消息规则，不默认投递。 |

自动化测试覆盖保存重载、同名本机隔离、路径限制、远端配置投影、身份变化、权限失败与页面迟到响应。真实双 PC 验收还需记录两端版本与身份、实际线路、授权拒绝、同名人格隔离、源配置更新后的再次读取、目标 Agent 收件和断线后的失败关闭；本机模拟测试不替代这些证据。

继续阅读：[路由与人格](routing-and-personas.md)、[路由配置](routing-configuration.md)、[人格同步退役](persona-data-sync.md)、[跨电脑通用连接](rabilink-peer-tunnel.md)。
