[English](api-reference_en.md) | 简体中文

# 接口参考与自动发现

面向接入开发者。查看当前运行服务实际公布的接口、请求与响应结构，以及执行和恢复条件。普通配置操作从[使用手册](user-guide/README.md)开始。

## 在文档页查看

1. 打开 RibiWebGUI 的“使用手册”，选择“接口参考（开发者）”。直接入口为当前 WebGUI 的 `/#/docs?view=api`，远端访问保留已有 `/manage/…/` 前缀。
2. 按名称、路径或说明搜索，按所属模块和 HTTP 方法筛选。
3. 选择一项操作，查看请求合同、响应合同、副作用、恢复规则与具名业务校验。
4. 需要接入时复制请求模板，或下载 OpenAPI。模板中的地址、路径参数、查询参数、正文和鉴权需要按当前连接补齐。

页面只读取目录，不执行列出的业务接口。接口描述保持所属插件声明的原文；界面标签支持现有语言选择。

## 数据从哪里来

所属插件维护一份可执行接口合同。实际 HTTP 分发、结构校验、帮助目录和 OpenAPI 都使用同一活动注册快照；页面不扫描函数签名，也不另存接口清单。

| 入口 | 用途 |
| --- | --- |
| `GET /api/agent/help` | 读取操作合同，支持 `operationId`、`method`、`path` 过滤和 `limit` / `cursor` 分页。 |
| `GET /api/agent/openapi` | 下载同一注册目录生成的 OpenAPI 3.1 文档。SSE、WebSocket 与原生代理保留其扩展字段。 |
| `GET /api/events` | 复用应用已有事件连接；目录变化或连接恢复后重新读取，不额外创建文档专用轮询。 |

接口参考读取版本 2 目录。分页完成后才更新展示；目录切换导致游标失效时显示错误，重新读取当前快照。最后成功读取的时间与目录缺口会在页面中显示。

## 发现地址并核对目录

本机源码环境使用以下 PowerShell 命令。先核对动态地址与运行身份，不写死端口：

```powershell
$managerInfo = node scripts/resolve-manager.mjs | ConvertFrom-Json
$managerBaseUrl = $managerInfo.managerBaseUrl
$meta = Invoke-RestMethod -Uri "$managerBaseUrl/meta"
if ($meta.applicationGenerationId -ne $managerInfo.applicationGenerationId -or
    $meta.managerInstanceId -ne $managerInfo.managerInstanceId) {
    throw 'Manager identity changed; resolve the endpoint again.'
}
$catalog = Invoke-RestMethod -Uri "$managerBaseUrl/api/agent/help?limit=20"
$catalog.data.operations | Select-Object id, method, pathTemplate
```

在源码根目录执行；其他目录使用解析器的已配置绝对路径。非本机访问复用已鉴权的 RabiLink / 远端电脑连接；访问令牌只保留在既有私有连接配置中。页面沿用 WebGUI 的地址前缀与鉴权，不增加第二套密钥。详见[连接与接口使用](connection-access.md)。

成功判据：读取返回 `code: 0` 与 `schemaVersion: "2"`；目录中的 generation / Manager 身份对应当前服务。`count` 是当页数量，`total` 是当前目录匹配数，存在 `nextCursor` 时还未读完。

## 怎样理解覆盖与错误

- `coverage.scope: registered-routes` 限定已纳入注册器的范围；`globalCoverage: not-proven` 表示全项目覆盖尚未证明。
- `coverage.gaps` 的每项是注册范围缺口，可能包含多个接口，不能直接换算为缺失接口数。
- Schema 展示已声明的字段与约束；开放对象、原生字节和透传代理不保证枚举全部业务字段。业务规则继续由所属接口执行。
- 操作出现在目录中说明可以发现其合同；账号、硬件、网络与真实业务验收状态仍查看[当前能力](current-capabilities.md)。

| 情况 | 处理 |
| --- | --- |
| `401` / `403` | 检查当前连接鉴权与用户明确配置的禁用项；目录不授予额外权限。 |
| `409` / `API_CATALOG_SNAPSHOT_CHANGED` | 丢弃未完成分页，刷新目录。 |
| `404` 或旧版目录 | 核对运行版本与公开能力，不用源码清单冒充当前在线接口。 |
| `502` / `504` / 超时 | 检查目标 PC 与现有中转连接；恢复后刷新，业务写入结果不确定时核对原回执。 |

## 文档维护边界

新增或修改接口时，在所属插件更新合同、描述与处理逻辑。参数、响应和恢复条件随目录生成；教程、业务示例与真实环境验收说明仍需同步维护中英文版本。本文不保存实时接口总数。

深入资料：[接口发现目标架构](api-contract-discovery-target-architecture.md)、[Rabi Agent 接口与业务约定](rabi-agent-interfaces.md)、[迁移实施记录](api-contract-discovery-implementation-progress.md)。
