<!-- docs-language-switch -->
<div align="center">
<a href="./faq-and-support_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 常见问题与获得帮助

这一页回答首次使用中最常见的问题，并给出能让维护者快速复现的反馈格式。

## 我必须先配置 QQ 吗？

不需要。先用“定时触发 + Codex”跑通第一条 Route，再接 NapCat。这样可以把处理端问题和 QQ 登录问题分开。

## 为什么 Manager 已连接，消息还是没到？

Manager 已连接只表示 WebGUI 能访问控制面。继续检查 Route 是否运行、消息端是否连接、规则是否命中，以及处理端任务是否绑定。

## 为什么普通群消息没有转发？

普通群消息不会默认全量转发。添加 `group_message` 规则，并使用聚焦的 regex。直接 @、回复链和私聊使用各自的 route kind。

## 为什么保存后没有立即看到效果？

先确认顶栏未保存提示已经消失。某些配置会同步或重载 Route；外部平台配置还需要在 NapCat、WeCom 或 Relay 一侧生效。

## 为什么 Codex 任务改名后仍能收到？

RabiRoute 使用完整任务 ID 和工作目录作为稳定绑定。标题只是显示信息；改名或 goal 完成不会让有效任务失效。

## 为什么模型或工具不是配置里写的那个？

Codex Desktop 任务拥有模型、工具、沙箱和审批。RabiRoute 的兼容字段不会覆盖目标任务设置。

## `draft` 会在哪里等待审批？

当前没有通用 WebGUI 审批队列。`draft` 是 Outbox 结果和审计数据。需要查看返回内容和日志，再按业务流程明确处理。

## 手动触发安全吗？

它适合受控验证，但不是无副作用预览。它会写日志、构造 AgentPacket 并开始真实处理端投递。

## 可以把整个 `data/` 发到 Issue 吗？

不可以。里面可能有真实消息、账号、token、任务上下文和私有路径。只提供本次启动后的最小日志，并完成脱敏。

## 如何确认当前版本？

侧栏品牌区会显示运行版本。也可以查看根目录 `package.json`。反馈时同时说明当前源码或安装包的来源。

## 提交问题前的最小检查

1. 重新构建并重启 Manager 与目标 Route。
2. 用最小 Route 复现，避免同时启用多个实验入口。
3. 记录本次启动时间和第一条错误。
4. 确认消息记录、AgentPacket 和 Outbox 分别是否存在。
5. 删除真实身份、token、Cookie、私聊和绝对私有路径。

<div class="screenshot-placeholder">
  <strong>截图占位 15｜适合提交的脱敏诊断截图</strong>
  <span>建议画面：侧栏版本、当前 Route、诊断摘要和最后错误；所有账号、token、任务隐私和路径已遮挡。</span>
  <span>标注重点：版本、Route 类型、消息端、处理端、错误时间；不要包含秘密。</span>
</div>

## Issue 模板

复制下面内容，并替换占位值：

```markdown
### 环境
- RabiRoute 版本：
- 启动方式：源码 / 安装包 / 托盘
- 操作系统：
- Node.js 版本：

### Route
- 消息端：
- Agent 端：
- 人格：有 / 无
- 外部平台版本：

### 复现步骤
1.
2.
3.

### 预期结果

### 实际结果

### 证据
- 是否有消息记录：
- 是否有 AgentPacket：
- Outbox 结果：
- 本次启动后的最小日志：

### 脱敏确认
- [ ] 没有账号、群号、token、Cookie、私聊和私有路径
```

## 去哪里获得帮助

- 使用问题先搜索本手册和[排障指南](../troubleshooting.md)。
- 功能是否已经实现，查看[当前能力与成熟度](../current-capabilities.md)。
- 可复现的 Bug 或文档问题，提交到 [GitHub Issues](https://github.com/vb2250158/RabiRoute/issues)。
- 需要扩展代码时，从[项目文档索引](../README.md)进入开发者资料。

提交安全漏洞时不要公开密钥、账号或可利用细节。先通过仓库提供的私密安全渠道联系维护者；如果没有明确渠道，再发不含敏感细节的询问。
