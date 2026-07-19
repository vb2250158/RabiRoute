<!-- docs-language-switch -->
<div align="center">
<a href="./rabi-codex-context-plugin_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Rabi Codex Context 插件

> 状态：首个可测试版本。源码位于 `plugins/rabi-codex-context/`。

## 产品边界

Rabi Codex Context 是可独立安装的 Codex 插件。它让用户把某一个 Codex 会话显式绑定到 Rabi 人格，并通过 Codex 生命周期 Hook 注入紧凑的人格、计划、记忆和角色技能上下文。

它不要求 Rabi PC 常驻：

- 只使用 Codex 的用户可以注册任意符合 Rabi 角色目录结构的本地 `roles/` 目录。
- 使用 Rabi PC / RabiRoute 的用户注册其 `data/roles/`，继续由 Rabi PC 管理人格、计划和记忆文件。
- 插件只拥有“Codex session ID → RoleId + 角色根”的绑定，不复制人格知识，不成为第二个记忆真源。

## 安装与首次验收

仓库内置的是非默认的项目 marketplace。先从仓库根目录注册它，再安装插件：

```bash
codex plugin marketplace add .
codex plugin add rabi-codex-context@rabiroute-local
```

安装后新建一个 Codex 任务，让新任务加载插件与 Hook。未绑定时普通消息不应收到 Rabi 上下文；在目标任务发送 `[rabi:use <RoleId>]` 后，同一轮应看到绑定成功和人格工作集。Hook 命令仍需通过 Codex 信任审阅。

## 会话启用模型

Codex 的插件 Hook 随插件加载。插件无法在 Hook 运行前按未知会话动态增删 Hook 定义，因此采用逻辑启用：

```text
Codex SessionStart / UserPromptSubmit
  -> Hook 读取真实 session_id
  -> 没有显式绑定：无上下文输出
  -> 存在显式绑定：读取对应 Rabi 角色目录
  -> 注入人格工作集 + 计划/记忆索引 + 本轮高相关条目
```

普通自然语言不会修改绑定。用户在会话内使用严格控制标记：

```text
[rabi:use YeYu]
[rabi:status]
[rabi:refresh]
[rabi:off]
```

`UserPromptSubmit` 输入包含 Codex 提供的真实 `session_id`，所以插件不需要根据标题、工作目录或最近时间猜测会话身份。Rabi PC 后续接 UI 时也应调用 CLI 并传完整 session ID，不能用任务标题冒充身份。

## 注入策略

- `SessionStart`：在 `startup`、`resume`、`clear`、`compact` 时重新注入已绑定人格。
- `UserPromptSubmit`：处理控制标记；人格文件变化时刷新基础上下文；按当前 prompt 对计划/近期记忆的 ID、标题和 `keywords` 做轻量匹配。
- 基础上下文不会在每轮重复；本轮没有高相关条目时不输出额外上下文。
- Hook 单次模型可见输出限制在约 9,000 字符内。完整资料始终保留在角色目录。
- 加载失败时继续 Codex 会话，并明确要求不得补造缺失设定。

## 本地数据

默认本地状态目录是用户目录下的 `.rabi/codex/`，可用 `RABI_CODEX_HOME` 覆盖。它只保存：

```text
config.json             # 已注册角色根
session-bindings.json   # 显式会话绑定
hook-state.json         # 注入指纹和轻量运行状态
roles/                  # 可选的 Codex-only 本地角色根
```

不要提交这些本地状态；其中可能包含个人路径、会话 ID 和私有人格绑定。

## Rabi PC 对接合同

Rabi PC 对接时复用插件 CLI：

```text
source add --id rabipc --path <data/roles>
bind --session <完整 Codex session ID> --role <RoleId>
status --session <完整 Codex session ID>
unbind --session <完整 Codex session ID>
```

UI 应显示人格名与会话名，但持久化和调用必须使用完整 session ID。绑定、切换和解除都是显式动作；选择 Route 人格不应暗中污染同一 Codex 任务中的手动对话。

## 验收

1. 未绑定会话启动与提交普通 prompt 时没有 Rabi 上下文输出。
2. `[rabi:use <RoleId>]` 在同一用户轮次完成绑定和人格注入。
3. 新会话、恢复、清空与压缩后按原 session ID 重新注入。
4. `[rabi:off]` 只解除当前会话，不删除角色知识。
5. 两个会话可绑定不同人格，互不串线。
6. 修改 persona / 计划 / 记忆后，下轮按指纹或关键词刷新。
7. Hook 文件通过 Codex 信任审阅后才能运行；未信任时不得声称已注入。
