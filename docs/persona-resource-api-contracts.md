[English](persona-resource-api-contracts_en.md) | 简体中文

# 人格资源 API 的可执行合同

这组合同负责原人格目录中的头像、Markdown 文档和可校验的人格引用。合同、HTTP 分发和远端发现使用同一组 executable definitions；文件选择、头像保存与删除、引用修订号和语言风格校验仍由原生 owner 执行。

| 操作 ID 后缀 | 方法 | 路径 |
| --- | --- | --- |
| `avatar.read` | GET | `/api/roles/:roleId/avatar` |
| `avatar.save` | PUT | `/api/roles/:roleId/avatar` |
| `avatar.remove` | DELETE | `/api/roles/:roleId/avatar` |
| `document.read` | GET | `/api/roles/:roleId/persona-document` |
| `reference.read` | GET | `/api/roles/:roleId/persona-reference` |
| `reference.language-style.validate` | POST | `/api/roles/:roleId/persona-reference/language-style` |

完整操作 ID 以 `manager.personas.resources.` 开头。文档和引用保留原 `persona:方法:路径` policy 别名。已建立并通过鉴权的远端连接可以调用这些公开操作；人格选择、语言风格绑定和 Manager 身份用于确定执行对象和阻止串线，不构成功能授权。

## 原生行为与资源生命周期

- 头像上传保持 PNG、JPEG、WebP、GIF 签名检查及 5 MiB 上限。相同内容使用原内容寻址文件，保存与删除沿用原配置更新、审计和头像变更事件；无关配置保持原值。
- 头像 GET 流式读取原配置选中的文件，保留 MIME、Content-Length 和私有缓存。原先已配置的大图片不会因为上传上限而无法读取。每帧最多 64 KiB；读取、断开或取消都关闭并等待原文件流结束，包含尚未开始消费的流。
- 文档只接受人格目录内的单个 Markdown 文件名，默认 `persona.md`；真实路径必须仍在该目录内；正文额度由 `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES` 配置，默认 0 表示无应用层额度。成功返回原字节和 Markdown MIME，错误保持文本响应。
- 人格引用保持 SHA-256 修订号。正文、配置、远端响应额度分别由 `RABIROUTE_PERSONA_DOCUMENT_MAX_BYTES`、`RABIROUTE_PERSONA_CONFIG_MAX_BYTES`、`RABIROUTE_PERSONA_RESPONSE_MAX_BYTES` 配置，默认均为 0；显式额度按实际原始字节计数，非法值仅使依赖该字段的操作返回 503 `READ_SETTING_INVALID`。详见[远端人格引用](remote-persona-reference.md)。引用语言风格校验需要调用者提交当前修订号；只使用人格 owner 配置的规则地址，复用全局语言风格校验器与响应 schema。校验后重读引用，配置或修订号变化会拒绝旧结果。
- 每个新请求使用当前人格根目录。owner 在读取正文前捕获原目录、连接和 Manager 身份；等待后和流帧之间复核。上传超限、取消或身份改变时，不进行后续原生写入。原生写入后发生失败时保留结果不确定标记，调用者应读取当前头像核对。

## 验证与迁移边界

针对性测试覆盖六项定义注册、已鉴权空远端节点成功读写、头像字节与配置保留、声明长度及实际上传上限、原有大图下载、Markdown 限制、引用及语言风格修订校验、身份变化与流关闭。测试使用隔离临时人格目录和受控校验器；不代表安装版或真实设备验收。

本页只描述这六项资源操作。计划、记忆、Skill、知识查询、记录等其余人格接口仍需按各自 owner 迁移；在全部覆盖前，不能删除它们依赖的旧 prefix 分发，也不能把本组完成视为整个人格 API 已完成迁移。
