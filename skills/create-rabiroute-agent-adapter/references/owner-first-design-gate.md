# Agent Adapter Owner-first 设计门

把本文件用于任何带 Runtime、session、桌面可见性或工具注入的新 Agent 端。先完成设计门，再写正式 adapter。

## 目录

- [历史教训](#历史教训)
- [设计门模板](#设计门模板)
- [停止条件](#停止条件)

## 历史教训

RabiRoute 的 Codex 接入曾依次经历：Desktop IPC 启发式修补、默认 app-server fallback、隔离 stdio Runtime、共享 4510 Runtime。每个阶段都通过了当时的局部测试，但仍反复返工，原因是没有冻结同一份用户合同。

最危险的错误等价关系是：

```text
同一 session ID ≠ 同一 live task owner ≠ 同一实时事件流 ≠ 同一工具集合
连接成功 ≠ 目标任务已接收 ≠ 用户界面可见 ≠ 结果由正确 owner 执行
```

不要从某个错误码直接设计 fallback。先确认错误是否说明目标 owner、身份或生命周期尚未满足。

## 设计门模板

在相关设计文档、任务记录或 PR 说明中填写以下内容。

### A. 用户可观察合同

| 要求 | 必需/可选 | 唯一真源 | 验收证据 | 禁止替代 |
| --- | --- | --- | --- | --- |
| 消息出现位置与时限 |  |  |  |  |
| 运行状态和结果位置 |  |  |  |  |
| 模型/工具/权限来源 |  |  |  |  |
| 新建与续投语义 |  |  |  |  |
| Agent 缺席时行为 |  |  |  |  |
| RabiRoute 缺席时行为 |  |  |  |  |

要求必须能由真实目标端观察。数据库存在记录、普通协议 client 收到通知或 mock 返回成功不能替代 UI/CLI/service 的真实证据。

### B. Owner 与生命周期

| 对象 | Owner | 谁启动/停止 | 权威状态 | RabiRoute 可读/可写 | 故障影响 |
| --- | --- | --- | --- | --- | --- |
| Host/UI |  |  |  |  |  |
| Runtime |  |  |  |  |  |
| Transport |  |  |  |  |  |
| Session/task |  |  |  |  |  |
| Turn |  |  |  |  |  |
| Tools/approval |  |  |  |  |  |

若 RabiRoute 停止会让外部 Agent 无法冷启动，默认判定为所有权倒置。除非这个 Agent 本来就是 RabiRoute 内建 Runtime，否则不得继续。

### C. 产品形态

明确选择一种：Desktop owner、独立 Runtime、CLI、服务/机器人、人工跳转、远程无人值守 bridge。若同一名称下存在两种 owner 或生命周期，把它们拆成不同 adapter/profile；不要添加“模式切换 + fallback”。

### D. 唯一真实消息路径

用一行写清：

```text
RabiRoute event -> adapter -> transport -> exact session/task owner -> turn -> observable result
```

列出所有可能执行真实 prompt 的代码路径。数量必须为 1。只读发现、健康检查和创建空任务不算执行路径，但必须在代码和测试中禁止它们携带真实 prompt。

### E. 身份与能力

- 用 owner 返回的完整 opaque ID 持久化绑定。
- 用名称、最后时间和 cwd/project 供人识别与交叉校验，不用它们代替 ID。
- ID 必须由扫描、创建或受控迁移自动产生，不能让用户或 AI 手填。配置 resolver 的固定顺序是：有效 ID → 精确绑定；非法/失效 ID → 名称 + 规范化 cwd；唯一匹配 → 重绑；零匹配 → 按用户输入创建；多个同名 → 等待选择。
- 从执行该 turn 的 Runtime 探测工具和权限，不从 session 文本或另一客户端推断。
- 精确 ID 存在但 cwd 冲突、名称重名未消歧或 owner 未加载时失败关闭；配置恢复不能变成实际消息的 fallback。

### F. 最小纵向探测

在实现完整 UI 前完成：

1. 发现一个真实目标并记录 owner 返回的 ID。
2. 验证任务总数超过默认页大小时，分页/搜索仍能访问全部结果；路径别名不能隐藏任务。
3. 验证直接输入名称时的唯一匹配、零匹配创建和多匹配消歧，不要求手改 ID。
4. 投递第一条唯一标记消息，观察目标端中的用户消息和结果。
5. 向同一 ID 投递第二条消息，证明没有新建任务。
6. 验证该轮实际拥有预期工具/权限。
7. 关闭 RabiRoute 冷启动 Agent；关闭 Agent 启动 Manager。
8. 让 owner 缺席、精确 ID cwd 冲突，确认没有第二执行路径。

### G. 必测负例

| 场景 | 必须证明 |
| --- | --- |
| owner 未加载/服务离线 | 可行动失败；不 fallback |
| 旧 endpoint 或环境变量残留 | 不形成隐藏依赖 |
| 非法、归档、失效 ID | 唯一名称 + cwd 可受控重绑；多匹配不模糊选择；零匹配只按明确名称创建 |
| 超过 100 个任务、路径别名 | 全部可访问；UNC、映射盘和 extended path 归一比较 |
| cwd/project 冲突 | 拒绝并显示差异 |
| active turn | steer 或显式排队，不并发 start |
| 两个 gateway/bridge | 不重复消费 |
| Runtime/Manager 分别退出 | 不拖死另一端 |
| 工具缺失 | 先证明执行 owner 正确，再报告能力缺失 |

## 停止条件

出现以下任一情况时停止编码并重新审查设计：

- 需要第二个 Runtime 才能隐藏首选路径的错误。
- 需要写用户级环境变量、注册表或外部应用启动配置。
- 测试只能证明记录可读，不能证明目标端真实可见。
- 同一 adapter 同时服务交互式 Desktop 和无人值守 remote 两种 owner。
- 无法指出真实 prompt 的唯一执行位置。
- 只有完整 UI 或安装包启动后才能验证第一条消息。

设计门未通过时，将 maturity 保持为 `experimental` 或 `stub`，只提交探测、诊断和明确的能力缺口。
