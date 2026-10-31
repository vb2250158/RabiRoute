[English](platform-native-listeners_en.md) | 简体中文

# 飞书与 NapCat 原生监听协议

状态：源码与本机受控 HTTP／WS 回归。真实平台、安装版发布与跨进程目录汇总分别验收。本页面向维护者；用户配置见[飞书接入](feishu-integration.md)与[NapCat 管理](napcat-unattended.md)。

## 协议边界

| 入口 | 地址与请求 | 原有鉴权 |
| --- | --- | --- |
| 飞书 | 原 `feishuWebhookPort`，默认绑定 `127.0.0.1`；仅 POST，`URL.pathname` 与 `feishuWebhookPath` 精确比较 | challenge 使用 Verification Token；事件使用 Token、原始字节签名及五分钟时间窗，加密事件先验签再解密 |
| NapCat | 原实例 `gatewayPort`，始终绑定 `127.0.0.1`；NapCat WebSocket Client 连接 RabiRoute 反向 WS server，任意 upgrade path | 原入口无入站密码、verifyClient 或路径鉴权；Access Token 属于出站 OneBot HTTP |

保留独立地址，不搬入 Manager，不新增监听端口。Manager／节点 Bearer 不能替代飞书验签，也不会转发到平台；NapCat 不新增密码或功能许可。

飞书不归一化 path：大小写、重复斜杠、编码和末尾斜杠按原 pathname 比较，query 不参与。保留原始字节和任意 Content-Type；上限 1 MiB，超限 413；方法／路径错误 404，非法 JSON 400，Token／签名错误 401；正常、忽略和重复事件 200。challenge 返回原 challenge 对象。

NapCat 保留 ws 原生握手、帧解析、ping/pong、文本／二进制帧和默认 100 MiB maxPayload。普通 HTTP 仍为 426；非法握手保留 ws 原响应，不追加错误响应。group/private mapper、实例身份和实例出站 endpoint 保持原归属。

## 可执行 owner 与 binding

`feishuHttpOwner.ts` 接收 IncomingMessage／ServerResponse，复用原 handleFeishuCallback、appId／chat／message／event 身份、持久去重、状态与转发回调。`napcatWsOwner.ts` 持有原 loopback HTTP listener 与 noServer WS server，共享注册表的 upgrade handler 调用同一 server.handleUpgrade；adapter 继续拥有业务映射。

`platformNativeOperations.ts` 声明合同与地址 binding。实际请求通过既有 ManagerPluginRouteRegistry.registerExternalListener，不建立平行 registry。绑定发布实际监听端口、协议、鉴权说明、租约与合同摘要，不包含平台密钥或 handler。本地合同名为 `gateway.feishu.<实际端口>.callback` 与 `gateway.napcat.<实例摘要>.<实际端口>.events`；生产入口再经共享 Gateway runtime 添加原 Gateway 摘要命名空间，不同进程／地址互不混淆。

`/:nativePath` raw remainder 覆盖原服务 URL 空间；飞书精确入口仍由原生 owner 决定。生产默认直接调用 getGatewayListenerRuntime()，通过原 Gateway stdout／supervisor IPC 发布和撤回真实 binding。原 Gateway ID、generation 与 PID 来自宿主；缺失身份时失败，不创建临时身份或另一套 registry。受控测试可显式注入 apiOperations.registerExternalListener；publishListener 只用于观察绑定或测试。汇总由共享 runtime／supervisor owner 核验原进程与租约。两种平台都标注 discovery-only：目录准确说明协议，不把平台入口转为通用 Manager JSON 调用或绕过平台鉴权。

## 生命周期

飞书租约覆盖正文解析、已接收转发 Promise 和响应。关闭停止新接收、关闭真实连接并等待已接收工作；客户端断开不提前释放回调。

NapCat 租约覆盖真实 socket 关闭、已接受帧与资料刷新 Promise（包括启动刷新）。关闭停止 upgrade、终止 sockets，等待 HTTP／WS 实际 close 回调并等待全部工作。重复 dispose 等待同一 Promise。取消信号进入类型化帧上下文；不得自动重放已开始的效果。

## 受控验证

```powershell
node --test-concurrency=2 --import ./scripts/test-manager-runtime-env.mjs --import tsx --test src/adapters/feishuAdapter.test.ts src/adapters/napcatAdapter.test.ts src/adapters/platformNativeOwners.test.ts src/adapters/platformNativeGateway.test.ts
```

临时目录、随机本机端口、模拟签名和注入回调覆盖精确路径、raw signature、challenge、错误、字节上限、去重、绑定撤回、任意 WS path、文本／二进制帧、原握手错误、实例归属、断连后的在途回调、启动回收和端口重挂。不登录平台，不发送真实消息。

默认路径子进程回归不注入 apiOperations／publishListener，核对共享 runtime 的实际 stdout 协议、原 PID／generation、命名空间、双 listener binding，完成原飞书 challenge 与任意 path 的 OneBot WS frame，再核对退出前全部撤回。
