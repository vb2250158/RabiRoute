<!-- docs-language-switch -->
<div align="center">
<a href="./agents-and-sessions_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Agent、项目与任务

消息端决定事件从哪里来，Agent 端决定任务交给谁处理。处理端负责回答、写代码、调用工具和维护自己的任务状态。

## 当前处理端

| 处理端 | 状态 | 真实边界 |
| --- | --- | --- |
| Codex | 已验证 | 通过 Desktop IPC 投给所选 Codex/ChatGPT Desktop 任务 |
| Copilot CLI | 实验 | 调用本机 CLI，并使用独立会话名和工作目录 |
| AstrBot | 实验 | 绑定 Dashboard / ChatUI 项目与会话，需真实环境验收 |
| Marvis | 人工接力 | 写 prompt、复制剪贴板并打开应用，不会可靠自动发送 |

选择器中的成熟度来自当前扫描结果。安装成功不等于登录成功；登录成功也不等于已绑定正确项目和任务。

## Codex 的三个必要条件

Codex 主链需要同时满足：

1. Codex/ChatGPT Desktop 正在运行。
2. Route 保存了正确的项目工作目录。
3. Route 绑定了该目录中的准确任务 ID。

RabiRoute 不通过隐藏 CLI、共享端口或备用 Runtime 执行真实消息。Desktop 是实际任务 owner，消息会出现在用户可见任务中。

## 扫描项目和任务

在“消息适配器”的“Agent 端”区域选择 Codex，然后点击扫描或重新扫描。

扫描会列出可用项目目录和未归档任务。任务选择器显示名称与最后活动时间，不用内部 ID 让用户辨认。

<div class="screenshot-placeholder">
  <strong>截图占位 09｜Codex 扫描与任务绑定</strong>
  <span>建议画面：Codex Agent 卡片展开，环境检查、成熟度、项目目录和任务选择器同时可见。</span>
  <span>标注重点：已验证、Desktop 状态、工作目录、任务名与最后时间、重新扫描。</span>
</div>

## 选择工作目录

工作目录用于：

- 校验已保存任务是否属于预期项目。
- 区分同名任务。
- 决定新任务创建在哪个项目。
- 防止消息投到另一个仓库的同名任务。

没有候选时输入绝对路径并保存。不要把本机私有用户名或目录写进公开示例、Issue 或截图。

## 选择已有任务

优先从下拉选择已有任务。选择后，RabiRoute 保存完整任务 ID，并采用任务自己的工作目录。

只要 ID 与目录仍有效，下面变化不会自动创建新任务：

- Desktop 中修改任务标题。
- 本地索引标题暂时滞后。
- 任务 goal 已完成。
- 后续重新扫描看到更新后的名称。

如果目标任务已删除、归档、换账号或移动项目，重新选择并保存。

## 创建新任务

在选择器中输入一个不存在的新名称，然后保存配置。RabiRoute 只用项目锁定的 app-server 创建和命名空任务；真实 prompt 仍由 Desktop owner 接收。

多个同名同工作目录任务时，RabiRoute 会自动绑定最后活动时间唯一最新者；如果最大时间并列，使用下拉中的最后时间和工作目录确认，或者先在 Desktop 中整理名称。

## 自动初始化人格

如果界面提供“自动初始化会话”，它会先保存稳定绑定，再通过正式 AgentPacket 链把人格资料交给同一个 Desktop 任务。

初始化失败不会创建第二个任务。先检查绑定和 Desktop 状态，再重试。

## 模型、工具和审批归谁管

目标 Desktop 任务拥有模型、工具、沙箱、文件和网络权限。兼容字段 `agentModel` 不覆盖这些设置。

Desktop 的命令审批只授权 Agent 执行；它不自动授权向 QQ、文档、设备或外部 API 写入。外部动作仍由 RabiRoute 的 Outbox policy 控制。

## 处理端没有收到消息

按顺序检查：

1. `agent-packets.jsonl` 是否有对应投递；没有则先查规则。
2. 日志诊断是否显示 Codex Desktop IPC。
3. Desktop 是否打开并能进入目标任务。
4. 工作目录与任务是否匹配。
5. 最后错误是否为 `no-client-found`、任务不存在或目录冲突。

完整流程见[运行、日志与排障](operations-and-troubleshooting.md)。

## 接下来阅读

- 配置角色行为：[人格与消息规则](personas-and-rules.md)。
- 理解权限和回传：[安全、回传与数据](safety-and-data.md)。
