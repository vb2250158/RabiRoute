[English](README_en.md)

# HTML 分享

此插件把完成消息明确选择的 HTML 附件保存为本机不可变快照，并提供带内容密钥的分享链接。它包含完整 PC owner、Relay helper、浏览器 viewer 和插件生命周期代码。

HTML 功能使用既有 RabiLink 连接。浏览器按通用局域网 → P2P → 加密 Relay 顺序连接；Relay 保存目录并转发握手/密文，不保存 HTML 或内容密钥。完整链接的 fragment 包含解密密钥，获得完整链接的人可以查看；PC 需在线。

私有快照、intent 与密钥位于宿主的 `pluginStorageRoot(pluginId, instanceId)` 稳定目录，与源码版本无关。停用插件只退役此功能的接口/连接，不删除快照，不影响原 Relay、MD、图片或普通消息。

本插件声明 `host.peer-transports@1`。旧 Host 缺少该扩展点时，只有此插件等待依赖，不执行不兼容工厂。宿主其他端口仍沿原合同，不使用兼容 fallback。

通过公开 `@rabiroute/plugin-sdk` 构建：安装 package 声明的依赖后执行 `npm run build`。`./relay` 导出唯一 Relay helper；`relay/`、`assets/`、`src/` 均属同一源码包。生产数据和凭据不进入源码包。
