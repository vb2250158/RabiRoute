简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.rabilink-relay

内置 Manager 插件。实例 `manager:rabilink-relay` 提供 `manager.rabilink-relay@1`。实现只通过 `@rabiroute/plugin-sdk` 和清单声明的版本化能力访问宿主资源。

候选只准备自己的 Peer、视频接收器与路由。正式发布使用 SDK 的 `context.publication.add`：`publish/rollback` 同步切换或恢复同一 Manager 内的 Peer 指针和同步回调；发布后等待上一实例完整退役，再启动 LAN 发现与 Relay 同步。准备或指针提交失败保留原实例；发布后的启动失败按 kernel 运行失败流程处理。

旧实例退役只撤销自己的路由和原生会话，并等待已接收的请求、流、连接尝试和实际 HTTP/WebSocket producer 关闭。只有当前同步回调的拥有者可以停止共享 Relay/LAN 服务，旧实例不会关闭新实例。此生命周期不改变已鉴权远端的公共接口能力。

隔离验证：`node --import tsx --test --test-concurrency=1 src/peerTunnel/pluginRuntime.test.ts` 覆盖候选失败、提交回滚、成功替换、旧慢请求排空、原生 HEAD 和真实取消清理；不连接真实远端。安装版运行验收由统一发布流程另行完成。
