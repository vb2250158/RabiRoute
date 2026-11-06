简体中文 | <a href="./README_en.md">English</a>

# io.rabiroute.manager.desktop

内置 Manager 插件，通过 `host.manager.desktop@1` 复用桌面设置与配置文件拥有者，提供 `manager.desktop@1`。原设置区、快捷键、系统命令和托盘菜单继续以插件贡献注册。

`createDesktopControlOperations` 从同一可执行合同安装 4 个公共操作：

| 操作 ID | HTTP 入口 | 结果 |
| --- | --- | --- |
| `manager.desktop.settings.read` | `GET /api/desktop/settings` | 原设置与是否存在明确的自启配置 |
| `manager.desktop.settings.patch` | `PATCH /api/desktop/settings` | 合并、归一化并保存设置 |
| `manager.desktop.settings.put` | `PUT /api/desktop/settings` | 保留与 PATCH 相同的原合并语义 |
| `manager.desktop.config.open` | `POST /open-config-file` | 准备管理的配置文件或目录，再调用原本机打开器 |

设置写入只对 `screenshot` 做嵌套合并，其他字段遵循原浅合并与共享归一化。保存经过原原子文件入口和变更审计，随后发布 `desktop_settings_changed` 的 `webTheme`。写入结果保留 `autostartConfigured=true`；它表示配置已保存，不能单独证明操作系统自启或桌面界面已应用。只读模式在读取写入 body 前拒绝设置修改。接口保留原宽松 JSON、空 body `{}`、任意 Content-Type 与无应用字节上限的行为。

打开配置使用 query 的 `type`、`gatewayId`、`roleId`，重复参数取首值，缺失为 `null`，body 被忽略。支持 manager、role/persona、role-folder、role-message-config、xiaomi-recordings/xiaomi-media/camera-clips、routes 和 route-folder。角色及路由选择继续使用原清理规则与文件事务；操作可能创建或写入配置。HTTP 成功只证明准备流程及原打开器调用返回，不证明应用窗口可见。原生事务错误保留 HTTP 状态和稳定错误码。

已鉴权远端遵循相同公共合同、现有用户明确禁用项与原对象规则，不增加本机来源要求。操作没有请求级幂等键；异常或断开后先回读原设置或文件，不能假定未执行并自动重放。插件退役停止接入并等待已开始的文件准备与打开器调用收尾，不关闭用户应用。
