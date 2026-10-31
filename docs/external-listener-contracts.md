[English](external-listener-contracts_en.md) | **简体中文**

# 独立监听器的公开合同

独立 HTTP / WebSocket 监听器沿用原端口、原处理器和原鉴权，并参与统一 API 发现。公开原生 HTTP 操作可由已建立的 Manager 连接访问；Manager 按真实监听器租约映射原 HTTP 交换，原业务仍由原监听器处理。

## 注册与调用

原监听器成功启动后，由其运行拥有者调用 `ManagerPluginRouteRegistry.registerExternalListener(instanceId, definition)`。插件可使用 `ManagerApiOperationsService.registerExternalListener(definition)`，身份来自当前插件激活。

```ts
const listener = registry.registerExternalListener("native-owner", {
  listenerId: "callback.listener",
  address: { protocol: "http", port: actualPort },
  protocol: "native-callback",
  invocation: "native",
  authentication: { kind: "none", description: "Original listener admission." }
});
listener.registerHttpProxies(nativeDefinitions);
// 原 HTTP 回调委托 listener.handle(request, url, response)。
// 原升级回调委托 listener.handleUpgrade(request, url, socket, head)。
```

`registerOperations`、`registerHttpProxies`、`registerUpgrades` 复用已有合同编译、校验、请求跟踪和关闭规则。需要保留原正文解析、非 JSON 错误、未知查询参数或原始状态码时，使用正式 HTTP passthrough 合同和原处理器。不能改用通用 JSON 解码器后声称行为相同。

`address` 只描述已经存在的监听器，不启动服务。指定 `hostname` 时必须是主机名或 IP，不能是带凭据的 URL、路径或 `0.0.0.0` / `::` 绑定通配地址。Manager 接收端采用原租约的地址；省略主机名时使用接收电脑本机回环。客户端无需扫描、配置逐接口端口或开放 NAT 端口。保留直连连接器的协议采用原显式地址，回环地址只能由本机直接访问。

每个监听器拥有独立路径空间。同一个 `POST /callback` 可以存在于 Manager 和多个监听器上，操作 ID 与别名仍须唯一。发现条目的 `binding` 含地址、协议、鉴权说明和非秘密 `leaseId`，地址或监听器代际变化需要原拥有者重新注册。

`invokeOperation()` 优先使用同一目录中的 `access.kind: "manager-native-http"`。地址由 `/api/native-listeners/<原lease>` 加原合同路径生成，不能选择任意 URL 或未登记监听器。Manager 接收端固定目标 authority，拒绝原路径前导 `//`，保留内部双斜杠和查询字节。原始正文只在原拥有者处解析；HEAD、原状态码、重复公共标头及同源重定向的租约路径保留，跨域 Location 原样返回，连接器不自动跟随重定向。

连接器在调用前确认经鉴权的 Manager 身份、当前绑定、访问映射和合同摘要。外层 Manager 传输合同与原生业务合同使用不同标头；原监听器只收到其原合同摘要和 `x-rabiroute-listener-lease`，不会收到节点 Bearer、Cookie、Agent 身份或 Manager 代际标头。接收时捕获 Manager 双身份，跨 await、响应披露与流块复核；原 Gateway lease 不变的插件投影切换不撤销已接收调用。HTTP 完成后客户端再次核对绑定。失效 lease 在新业务派发前拒绝，写后切代标记不确定并禁止自动重放。

当前 Manager 映射覆盖 `invocation: "native"`、无额外原生鉴权的公开 HTTP 合同，因而可复用原 Manager 的 LAN / P2P / Relay 连接。原生 WS 及额外原生鉴权仍使用直连连接器；不宣称所有 WS 已映射至 Manager。显式 `nativeHeaders` 可提供原目标 Authorization / Cookie 等凭据，与 Manager Bearer 分离；禁止将节点凭据复用为原生凭据。该字段不会写入目录，也不会通过当前 Manager HTTP 映射转发。

调用不会自动重放。HTTP 派发后绑定核对失败时返回 `bindingChanged: true`、`uncertain: true`，保留原请求键并核查原结果。流、文件输出和 WebSocket 沿用通用连接器的显式消费者、背压与取消合同。

## 跨进程发布

Gateway 等独立进程通过原生命周期或 IPC 发布 `listener.publication()`，其数据包含 `active`、binding 和来自真实可执行注册的 `{ contract, contractDigest }`。监听器停止接收后发布 `active: false`，即使 Gateway 进程仍活跃，也会从目录移除。

Manager 的原运行拥有者调用：

```ts
const unregister = managerRegistry.registerExternalListenerSource("gateway-owner", {
  isCurrent: () => existingGatewayLeaseIsCurrent(),
  read: () => verifiedGatewayPublications()
});
```

`isCurrent` 与 `read` 是可信本机运行代码提供的回调。接线核对原 child 对象、PID、Gateway ID、原 generation 和递增发布 revision；不能把任意 HTTP 请求、静态配置或未验证状态文件当作活跃发布。Manager 验证字段、重新编译合同并比对摘要；无效发布留下明确覆盖缺口。stdout 解析、UTF-8 半行和可信缓存归 Manager 长期持有，插件 activation 只投影缓存。替换、失败候选及回滚不重启 child，也不伪造或重播 publication。

源退休后移出目录并刷新发布；撤源拥有者等待 `drainRetiredNativeListenerHttp()`，只加入被移除绑定的原交换。Manager 最终停机先停止入口，再等待 `disposeNativeListenerHttp()`。关闭和重复失败均复用同一最终关闭 Promise，不能用 HTTP 已断代替原 producer 已关闭。正常 stopAccepting 保留原拥有者已经接收的业务清理，结果未知时不重放。

该 API 提供跨进程发布边界。具体 Gateway 的 IPC / 状态接线和运行验收仍由对应拥有者实现；单独注册一个内存目录不证明跨进程接线已完成。

## 外部协议与发现格式

需要平台签名、URL challenge、OneBot 反向帧或 Peer 控制握手的监听器使用 `invocation: "discovery-only"`，除非已经有适配原协议的连接器。目录与帮助明确发布协议和原鉴权说明；普通节点鉴权不会替代外部协议鉴权。通用调用遇到该成熟度会明确说明需要原生协议连接器，且不访问目标地址。

公开 Rabi 业务 API 应使用实际支持的 `native` 调用合同，不能借平台协议分类遗漏业务入口。现有权限模型不变：鉴权后的远端连接默认拥有公开 Manager 能力，目录是发现和定位信息。

帮助和能力目录在每项操作中返回 `binding`，并在 `listeners` 中保留显式监听清单，包括没有公开业务操作的内部传输控制监听器。内部合同不会转为公开业务能力。OpenAPI 的 Manager 操作仍位于顶层 `paths`，独立地址空间位于 `x-rabiroute-external-listeners` 的 `{ binding, owner, paths }`，从而保留不同监听器的同方法同路径。HTTP wildcard、原始后缀和升级合同继续使用已有扩展。

帮助中的 `help.coverage` 分别说明路径、查询、标头、正文和响应的 Schema 结构精度，以及原始字节、开放 provider 数据和流帧的边界。`auditLevel: "runtime-schema"` 只表示执行所声明的 Schema。`exactRequestSchema` / `exactResponseSchema` 保守保持 false，`completeness: "not-proven"` 明确完整原生 DTO 尚未证明；业务校验始终由原拥有者负责。字段开放性不因报告精度而被收紧。

原生路径中的内部 `//` 会原样匹配和调用；前导 `//` 仍拒绝，不能转成跨域地址。需要最终静态资源兜底时，在原 `registerHttpProxies` 合同中声明 `httpProxy.dispatch: "final-fallback"`、`method: "*"`、`pathTemplate: "/:suffix"` 和 `request.pathRemainder: "suffix"`。普通操作、原生 wildcard、旧路由、升级检查和已知路径的 405 均优先执行；同一监听器只允许一个该兜底拥有者，目录不据此宣称未登记业务已覆盖。

## 验证范围

测试覆盖真实子进程 stdout 发布、Manager-only 访问、实际加密 TunnelSession、原始字节、路径空间隔离、失效租约、SSRF 目标 authority、双身份响应围栏、未完上传时原生早响应、原 producer 关闭门控、显式原生凭据和重复关闭。它们不发送真实平台消息；LAN / P2P / Relay 的具体网络连通性与生产 Supervisor 接线仍需各自运行验收。
