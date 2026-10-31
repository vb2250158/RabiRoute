[English](peer-lan-listener-discovery_en.md) | 简体中文

# Peer LAN 监听发现

面向接入开发者与维护者。源码 helper、监听接缝及受控回环测试已实现；Manager 总接线与运行包验收分别核对。

Peer LAN 使用一个原有 HTTP / WebSocket 监听器，承担两类原生传输协议：

|方法与路径|原协议拥有者|
|---|---|
|POST `/api/rabilink/peer/receive`|原 Peer 加密分发器；应用加密包、目标、期限、generation 与传输控制校验|
|GET Upgrade `/api/rabilink/peer/tunnel/socket`|原 Peer tunnel；应用 bootstrap、公钥握手、连接与 socket 生命周期|

统一发现的 `listeners[]` 为该物理监听提供一条 `protocol: "rabilink-peer-lan"`、`invocation: "discovery-only"`、原生鉴权的记录。它提供 **0 项公开业务 operation**。该标签用于发现，不改变线上协议；Node Bearer 不代替原 Peer 握手。已鉴权远端仍按既有合同使用 Manager 全部公开接口。

`peerLanListenerMetadata.ts` 只管理这条元数据记录，复用正式 `registerExternalListener`。它没有消息处理器、升级处理器或新的 RPC 分发器。HTTP 接收、WebSocket 握手、socket 所有权和停止逻辑继续由原 Peer 代码执行；OpenAPI 的独立监听项保留空 `paths`。

`PeerLanServer.boundAddress()` 返回实际已监听 socket 的地址和端口，未监听时返回 `undefined`。它与 `peerUrls()` 的候选地址分开，端口零必须采用操作系统最终分配的端口。通配绑定地址不作为可连接的 hostname 发布；明确的回环绑定保留回环地址。`subscribeStatus()` 只增加观察者，取消订阅不会关闭监听器。

## 接入生命周期

每个 Peer activation 构造一个 helper，传入原 `PluginIdentity`、原 `PeerLanServer`、正式 operations 服务与目录刷新回调。

1. 候选阶段只构造 helper。
2. 正式发布且 `previousRetirement` 完成后，在原 `peer.start()` 调用 helper 的 `start()`。它订阅状态，并立即读取当前 socket；跨插件替换继续存在的监听器也会取得新 activation 的元数据 lease。
3. 地址变化或监听停止时，先撤回旧 lease，再清理自己的注册。状态回调使用捕获的原 activation 注册，避免旧 socket 的异步上下文误绑旧代。
4. 原 Peer 的 `stopAccepting()` 同时调用 helper 的同名方法；原 `stop()` 等待 helper 的 `stop()`。重复停止加入同一个清理 Promise。

helper 停止只取消自己的订阅和元数据租约，不关闭原监听或另一个 activation 的记录。元数据注册失败通过诊断回调报告，保留原 Peer 接收行为；清理失败由 `stop()` 返回。

受控测试覆盖真实回环端口、端口零、跨代复用 socket、旧异步上下文、失败候选、取消启动、停止后撤发现，以及真实注册清理尚未完成时的等待。原 HTTP 分发与升级连接排空测试保留。测试不调用真实 Peer 或平台。

正式 binding 的发现结构见[独立监听器公开合同](external-listener-contracts.md)；全局覆盖状态仍以[接口合同架构](api-contract-discovery-target-architecture.md)及对应验收为准。
