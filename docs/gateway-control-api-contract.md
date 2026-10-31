<!-- docs-language-switch -->
<div align="center"><a href="./gateway-control-api-contract_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 网关运行控制接口的可执行合同

> 状态：源码迁移及专属隔离验证；整包构建、安装版和真实跨机验收由总体验收分别确认。

`io.rabiroute.manager.gateway-runtime` 通过 `createGatewayControlOperations(context, managerReadOnly)` 发布 15 个业务操作。相同定义安装路由、校验请求与响应并进入 API 目录，替代原 exact/prefix 清单和 `handleGatewayControlApi` HTTP 分发。业务编排由 `createGatewayControlOwner()` 直接调用原配置事务、运行时、投递和进程拥有者，不另建 Route 状态或 Runtime。

## 操作

操作 ID 使用 `manager.gateway-runtime.` 前缀，均为公开接口。已鉴权远端连接默认使用相同拥有者，保留用户明确禁用项及原参数、对象、只读和事务规则。

| ID 后缀 | 方法与路径 | 原生结果 |
| --- | --- | --- |
| `list` / `replace` | GET / POST `/gateways` | 读取或整表修改 Route，修改返回提交回执 |
| `config.save` | PUT `/gateways/:id/config` | 单 Route 合并提交，独立报告持久化和运行激活 |
| `mutation.read` | GET `/gateways/mutations/:operationId` | 原事务队列屏障后确认 committed / not_committed |
| `start` / `stop` / `restart` / `delete` | POST `/gateways/:id/start`、`stop`、`restart`、`delete` | 原运行时请求或配置删除事务 |
| `weixin-login.request` | POST `/gateways/:id/weixin-login` | 原适配器二维码请求，接受返回 202 |
| `manual-trigger.request` | POST `/gateways/:id/manual-trigger` | 原手动进程接受或 already-running，返回 202 |
| `agent-delivery-test.request` | POST `/gateways/:id/agent-delivery-test` | 等待原目标的真实测试投递回执 |
| `delivery-replay.list` / `delivery-replay.request` | GET / POST `/gateways/:id/delivery-replay` | 原尝试流水读取或重放，重放接受返回 202 |
| `network-options.read` | GET `/network-options` | 原网络配置选项 |
| `reload` | POST `/reload` | 等待原重新加载与同步，返回 JSON 200 或空正文 303 |

生命周期的 `requested` 和手动进程的 `accepted` 不证明进程已经启动、停止或完成。测试投递和重放在真实运行中会产生真实消息；本模块隔离测试只替换原调用边界，不向真实 Agent、平台或进程发送请求。

## 输入、恢复与卸载

Route 修改和删除保留原 `Idempotency-Key` 与强 `If-Match`。准备阶段先校验原请求条件，再消费正文；不会创建替代 key。写入继续使用原 `writeConfig`、`writeGatewayConfig` 和 `removeGatewayConfig`，不复制原事务、CAS 或持久回执实现。

单 Route 保存即使运行激活失败，也保留 `receipt.state=committed`，通过独立 `activation` 报告失败。结果不确定时，用原 operationId 查询原队列屏障回执，不把暂时未收到响应解释成未提交。无请求级幂等的进程、投递、重放及 reload 操作，先读取原状态和回执再决定是否重试。

原生忽略正文的入口在合同中声明丢弃，不解析；JSON 入口保留空正文默认 `{}`、任意 Content-Type、未知字段、原生类型转换及原本未设置的应用字节上限。`managerReadOnly` 保留为执行模式，并在正文消费前拒绝写方法。

迁移后的协议解码统一由注册器负责：畸形 JSON 返回 400，替代旧手动触发、测试投递、重放把解码失败归为 500 / 502 的行为；原业务失败状态不变。已注册路径的不支持方法由同一注册器返回 405 和 `Allow`，包括原本 fallthrough 的 `/reload` GET、`/gateways` PUT；不再维护额外拒绝操作表。无关路径继续交给后续入口。生产既有的 `reason` 和双语 `errorMessages` 仍由共享错误表现层附加。

`/reload` 继续按原 Accept 字符串判断：包含 `application/json` 时返回 `{ok,gateways,routeCatalog}`；否则返回 303、`Location: /` 和空正文。目录中同时描述两种响应，远端不需新增专用映射。

插件保持原运行时租约。卸载先停止接口接收并等待已接受操作实际完成，再由原租约拥有者决定是否停止手动进程及全部网关。HTTP 断开不提前释放原操作；原 Node 撤权后通用边界隐藏业务数据，并保留提交可能已发生的不确定性。

## 验证范围

专属测试通过真实合同注册器和隔离 HTTP 服务执行。覆盖真实 Node 登记后的公开调用、原生业务结果、强条件先于正文、只读、单 Route 持久化与激活分离、队列恢复回执、303/Location、405/Allow、撤权后原 key 写入的临时文件读回及断连后的操作租约。运行时、平台及投递边界均为受控夹具；这些结果不证明真实进程或真实跨机投递验收。

总体验收见 [目标架构](api-contract-discovery-target-architecture.md) 与 [实施记录](api-contract-discovery-implementation-progress.md)。
