[English](README_en.md) | 简体中文

# QQ 收藏表情名字兼容插件

新版 NapCat 已提供 `fetch_custom_face_detail` 时无需安装。本插件为旧版补充同名只读 OneBot 接口，返回当前登录账号收藏表情的 MD5、原生描述和媒体引用。Rabi 将描述作为表情名字，并提供 ID、名字和受保护的预览接口。

将本目录复制到目标 NapCat 的 `plugins/napcat-plugin-rabi-stickers/`，在 NapCat 插件管理中启用。接口沿用该实例现有 OneBot 鉴权，不新增口令或访问白名单。它只读取原生收藏，不保存第二份图册、不发送消息、不修改名字。QQ 中新增、删除或改名后，下一次读取即更新。未命名收藏返回空名字，可通过 Rabi 预览后选择。

Rabi 接口与发送示例见 [QQ 表情](../../docs/rabi-agent-interfaces.md#qq-表情)。插件卸载只移除自身注册；上游已存在的同名接口保持原样。
