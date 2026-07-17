<!-- docs-language-switch -->
<div align="center">
<a href="./safety-and-data_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 安全、回传与数据

RabiRoute 把“Agent 能做什么”和“结果能否写到外部系统”分成两道边界。理解这点，可以避免把一次任务审批误当成长期外发授权。

## 两道权限边界

| 边界 | 控制什么 | 在哪里决定 |
| --- | --- | --- |
| Desktop 任务权限 | 命令、文件、网络、工具和沙箱 | 目标 Codex/ChatGPT Desktop 任务 |
| RabiRoute Action Gate | QQ、WeCom、RabiLink 等外部回传 | pipeline、replyContext 和消息端 policy |

Desktop 允许 Agent 读取文件，不等于允许把文件发到群里。RabiRoute 允许 QQ 文本回传，也不等于允许上传任意本地文件。

## Outbox 结果是什么意思

| 结果 | 含义 |
| --- | --- |
| `sent` | 请求的输出路径已成功完成；如果目标是 Agent 会话，也可能表示结果被保留在会话中 |
| `draft` | 结果保留为草稿数据，没有完成外部发送 |
| `blocked` | policy、消息类型或目标不允许执行 |
| `failed` | 已尝试执行，但平台或连接返回失败 |

当前没有通用、持久化、可在 WebGUI 中逐条审批的 Action Queue。`draft` 是结果和审计状态，不是一个等待处理的完整审批中心。

<div class="screenshot-placeholder">
  <strong>截图占位 14｜消息端接收与回传策略</strong>
  <span>建议画面：NapCat 或其他消息端的 policy 区域，接收、回传、输出类型和文件目录限制可见。</span>
  <span>标注重点：输入与输出分离、支持类型、允许文件目录、保存后生效。</span>
</div>

## 来源回复与主动发送

回复当前来源时，Agent 应使用 RabiRoute 注入的 `replyContext`。它包含 Route、消息端和来源目标信息，能减少发错群或发错账号的风险。

主动发送必须提供明确目标。目标不清、消息类型不支持或输出 policy 关闭时，Outbox 应返回 `blocked`，而不是猜测收件人。

## 本地文件上传

NapCat 群文件使用本地 `filePath` 时，路径必须位于配置的 `allowedFileRoots` 之一。RabiRoute 会检查真实路径、文件存在性和普通文件类型。

公开示例只使用占位目录。不要把个人目录、构建服务器路径、真实文件名或私有发布目录写进仓库。

## 哪些操作有真实副作用

- 保存配置会写本地配置，并可能同步或重载 Route。
- 启动、停止和重启会改变当前 Route 进程状态。
- “打开 NapCat”可能启动实例、选择 quick login 并修复 OneBot 配置。
- 手动触发会写日志并投递真实 AgentPacket。
- Outbox 允许时会向外部平台发送真实内容。
- 删除 Route 会移除对应配置，不能当作停止使用。

执行前看清当前 Route、目标平台和是否存在未保存修改。

## 数据放在哪里

常见本地数据：

```text
data/Config.json
data/route/<configName>/adapterConfig.json
data/route/<configName>/*.jsonl
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
data/roles/<RoleId>/plans/
data/roles/<RoleId>/memory/
```

Route 配置、消息历史、AgentPacket、Outbox 和运行日志通常位于 Route 数据目录。人格正文、规则、计划、记忆和技能位于角色目录。

## 不应进入仓库或反馈附件的数据

- QQ 号、群号、私聊内容和未脱敏截图。
- token、Cookie、密码、Bot Secret 和 WebUI 密钥。
- 真实本机用户名、私有绝对路径和发布目录。
- 运行期 `data/`、日志、录音、转写和附件。
- 处理端任务中的私有上下文。

反馈时保留字段名、状态、时间顺序和最小错误文本；用占位值替换身份与凭据。

## 备份与迁移

迁移前停止相关写入或关闭 Manager，备份需要保留的 Route 配置和人格目录。不要把构建产物、`node_modules` 和全部历史日志当成必要配置。

新版本启动前先阅读版本更新日志。配置 Schema 可能归一化旧字段；备份能让你比较保存前后的真实变化。

## 接下来阅读

- 排查外发失败：[运行、日志与排障](operations-and-troubleshooting.md)。
- 准备脱敏反馈：[常见问题与获得帮助](faq-and-support.md)。
