# 跨电脑连接信令与设备发现

[English](rabilink-peer-rpc_en.md) | 简体中文

状态：实验实现，现行源码合同。本页说明设备发现和保留的控制信令；全部业务读取、写入、流与第三台 PC 能力统一通过[通用连接](rabilink-peer-tunnel.md)。本机自动化不等于真实双 PC 或远程部署验收。

## 发现目标电脑

两端启用同一 RabiLink 应用。调用方通过当前 Host `status --json` 的 `managerBaseUrl` 读取 `/meta`，核对当前 application generation、Manager 实例和目标接口所需健康状态，再查询：

- `GET /api/rabilink/peer/list`：设备登记和 `summary` 分类计数，每项提供设备 ID、GUID、`deviceKind`、在线状态、能力及 LAN 地址。
- `GET /api/rabilink/peer/list?deviceKind=pc&online=true`：只返回明确上报为 PC 且在线的登记；计数对应筛选结果。
- `GET /api/rabilink/peer/servers`：当前连接状态、实际线路和 RTT，详见通用连接页。

PC 上报 `deviceKind=pc`；手机、眼镜及扩展设备保留自身类型。缺失或非法值为 `unknown`，不根据名称或能力猜测硬件；`summary.total` 是设备登记数。Relay 保留已登记类型，后续客户端省略字段不会清空它；历史登记须由设备重新上报。类型与版本只用于识别，不授予权限。

发现入口接受安全本机访问或 Manager ingress 已验证的连接。真实远端 Agent principal 优先，原始授权撤销后不能回退为回环访问；伪造身份请求头不建立 principal。独立 peer LAN 端口只提供加密协议及隧道握手，不直接提供完整 Manager 或 WebGUI 控制。

## 信令控制面

`peer-rpc-v1` 的业务入口 `POST /api/rabilink/peer/call` 已删除，返回 404。旧 `plans.list` / `persona.manifest` 注册、清单辅助模块和每业务调用新建 P2P 的调用端同时移除；业务不再有第二份分发表。

保留的加密 wire 只接受：

| 操作 | 用途 |
| --- | --- |
| `system.describe` | 确认目标设备、generation、Manager instance 和已启用的控制信令 |
| `transport.tunnel` | 应用握手、通用 WebRTC 或 Relay 隧道连接协商 |
| `transport.offer` | 受支持旧手机的控制 DataChannel 接收兼容 |

即使旧业务操作误加入注册表，分派器也不执行或列出它。应用停用后不接受连接分配；`system.describe` 中的连接分配操作标为控制面且不是只读操作。旧 `peer-access.json` 不再参与鉴权。

PC 信令通过既有 `/api/rabilink/peer/proxy` 发送密文到目标 `/api/rabilink/peer/receive`。先执行 describe，再发送绑定当前 generation/instance 的一次分配；凭据变化、取消、身份不匹配或实例切换后失败关闭。信令 HTTP 每次有五秒预算，不跨 LAN/P2P/Relay 重放结果未知的分配。请求有效期和包大小有界，明文最多 1 MiB；LAN/P2P/Relay 业务线路与连接复用由通用隧道负责。

请求与回复使用应用密钥派生的 AES-256-GCM；应用隔离、目标身份和 generation 校验不被本机或远端 Agent 的管理访问替代。Relay 固定转发目标，不接受任意本机 URL。插件停止关闭通道并等待已接受的 HTTP 操作。

## 调用全部业务接口

目标 PC 的公开接口通过 `manager` 服务执行，例如：

~~~text
GET /api/rabilink/peer/http/pc-b/manager/meta
GET /api/rabilink/peer/http/pc-b/manager/api/agent/help
~~~

新增 Manager API 或公开请求头不需要增加 Relay 分发代码。三线路共用加密、流复用与授权合同，优先 LAN，再尝试 P2P，最后 Relay；健康连接复用。第三台 PC 使用现有嵌套转发，最多四跳并拒绝重复或本机目标。HTTP/SSE/WebSocket/二进制、未知写入不重放及鉴权中途失效的具体规则见[通用连接](rabilink-peer-tunnel.md)。

角色与权限独立。资料仍由来源 PC 的既有角色、计划和聊天记录接口持有，跨电脑访问不创建同步副本；旧清单接口不是保留数据的必要条件。已有用户数据和历史冲突证据保留，视频继续遵守独立的禁止视频中转合同。

## 兼容退出与验收

旧 `transport.offer` 接收端只为仍受支持客户端保留控制 wire；正式业务只有通用 `manager` 路径。受支持客户端迁移到 `transport.tunnel`、旧信令使用清零且完成设备验收后，删除旧 DataChannel 接收端。`bootstrap-speech/resources/persona` 的签名兼容和角色页面 bootstrap 别名退出条件见通用连接页。

本轮 66 项传输测试通过，覆盖本机真实 WebRTC、隔离 Relay、三 Runtime LAN 转发、未知接口和业务头、流式撤权、取消及未知结果不重放。入口为 `src/rabiPeer.test.ts`、`src/rabiPeerClient.test.ts`、`src/manager/rabiPeerRoutes.test.ts` 和 `src/peerTunnel/` 测试。真实双 PC、跨运营商 P2P、持续运行及手机/眼镜升级仍需单独运行证据；本页不宣称这些验收或部署已完成。
