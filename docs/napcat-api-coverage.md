# NapCat 接口覆盖与调用

[English](napcat-api-coverage_en.md)

## 当前范围

本次基线为 NapCat 4.18.4 发行文件，SHA-256 为 `66dfaa1b9e7530d493089c70d24810f4e23c31d129e1662949558ce30ce52a92`。上游仓库当前只保留 README，后续版本能力需要重新取得发行物核验。

[逐项原生合同](../src/plugins/io.rabiroute.endpoint.napcat/contracts/napcat-4.18.4.json)包含 167 个已注册基础动作及 501 个含别名的名称、112 个 WebUI 方法与路径、25 个实例化事件和 6 个事件基类。[Rabi 覆盖矩阵](../src/plugins/io.rabiroute.endpoint.napcat/contracts/rabi-coverage-4.18.4.json)记录本版调用状态、参数、公开返回字段和具体依赖。

| 范围 | 本版状态 |
| --- | --- |
| OneBot 动作 | 32 个读取、55 个使用原持久账本的副作用动作 |
| 既有入口 | 20 项兼容形态，按原操作合同调用 |
| 待实现或所属宿主限制 | 60 项，逐项保留具体原因 |
| WebUI | 17 个固定读取或摘要入口，其他管理动作沿原 owner 与逐项依赖 |
| 事件 | 类型化元数据进入原 NapCat 存档；原群聊和私聊触发规则继续生效 |

目录可发现全部基础动作。调用缺少执行能力的动作会返回 `QQ_API_OWNER_DEPENDENCY_UNAVAILABLE`；兼容入口返回 `QQ_API_USE_EXISTING_OWNER` 并在合同提供原操作名称。目录覆盖率和实际执行覆盖分别计算。

## 调用

先用 `/api/search` 找到动作，再读取其帮助合同。固定动作入口为 `POST /api/agent/qq/onebot/<action>`。

```json
{"routeId":"example-route","instanceId":"example-napcat","params":{"group_id":"100000001"}}
```

副作用动作另需稳定 `deliveryId`。同号同参数只核对原持久记录，参数冲突返回 409。202 表示原结果仍不确定，按 `GET /api/agent/qq/onebot-receipts/<deliveryId>?routeId=example-route&instanceId=example-napcat` 查询，不重新发送正文。`_async` 和 `_rate_limited` 是同一 Rabi 合同的发现别名，本版统一使用其同步语义。

每次实际调用绑定正在运行的 Route、明确实例及配置的 QQ 账号，并核对 `get_login_info`。已有连接权限、取消、超时、读取配额与作用域继续生效。已配置多实例时仍需明确 `instanceId`。

头像、群头像、OCR 和语音转文字通过原消息附件 owner 取输入。使用 `attachment={kind,targetId,messageId,attachmentIndex}`，按精确会话与消息选择附件。调用参数中的 URL、宿主路径或任意 base64 无法替代附件身份。

WebUI 固定读取入口为 `POST /api/agent/qq/webui/<id>`，同样携带 `routeId`、`instanceId` 与 `params`。原 WebUI 会话 owner 保管凭据，独立核对 WebUI 登录 QQ 与 OneBot 目标账号相同。证书只返回安全状态摘要，日志、页面和图标只返回受限摘要，SSE 只读取有界样本。私钥、凭据、任意代理、宿主路径和插件代码不会通过该读取入口返回或执行。

## 加群能力

4.18.4 的注册表没有主动申请加入指定群的动作。`set_group_add_request` 处理已经收到的申请或邀请，需要原事件标记。`set_group_add_option` 修改现有群的入群设置。上述事实仅覆盖本版已注册 API，其他版本与客户端界面需另行核验。

## 验证与剩余范围

验收使用私有端口、测试配置和 mock。实际在用 QQ、玩家群与 NapCat 服务不参与测试。旧入口的形态限制保持原合同，转发、卡片、闪照、在线文件夹等缺少外发 producer 的动作继续列为待实现。凭据、宿主文件、插件管理与原生协议分别由其原 owner 管理，矩阵提供逐项原因。

插件可按稳定宿主合同独立构建和回滚。发布前必须用已安装宿主验证原生与 Web 完整闭包、冷启动、接口和正常退出，再通过原插件目录 CAS 选版回读实际运行版本。源码版本、包哈希、安装采用与真实平台操作分别留证。
