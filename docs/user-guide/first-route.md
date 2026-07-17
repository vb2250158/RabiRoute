<!-- docs-language-switch -->
<div align="center">
<a href="./first-route_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# 跑通第一条 Route

这篇教程用“定时触发 + Codex”完成最短闭环。它不依赖 QQ 登录，适合第一次确认 RabiRoute、RibiWebGUI 和处理端能否正常协作。

> 完成标准：日志诊断页显示链路没有明显断点，手动触发成功，并且所选 Codex/ChatGPT Desktop 任务收到一条 RabiRoute 消息。

## 开始前准备

- RabiRoute 已安装并构建，Manager 可以启动。
- Codex/ChatGPT Desktop 已打开。
- 你知道目标任务所在的项目目录。
- 目标任务可以正常进入，不处于已删除或不可访问状态。

如果还没有启动 Manager，在项目目录运行：

```powershell
npm run start:manager
```

然后打开 `http://127.0.0.1:8790/`。

## 第 1 步：打开快速配置

点击左下角“快速配置”。如果当前还没有任何 Route，首次打开 RibiWebGUI 时也会自动显示这个向导。

在“选择消息入口”中选择“定时触发”。先不要同时接入 QQ、Webhook 或实验适配器；第一轮只验证一条最短链路。

<div class="screenshot-placeholder">
  <strong>截图占位 02｜快速配置：选择消息入口</strong>
  <span>建议画面：快速配置第一步，选中“定时触发”，保留三步进度条和入口说明。</span>
  <span>标注重点：定时触发、会话工作中时跳过心跳、下一步。</span>
</div>

## 第 2 步：绑定 Codex 任务

在“绑定 Agent 处理端”中选择“Codex Agent”。扫描结果应显示“已验证”；这表示项目内主链已实现，不代表 Desktop 可以关闭运行。

依次完成：

1. 在“项目目录”选择目标任务的工作目录。没有候选时输入绝对路径。
2. 在“会话名 + 最后会话时间”选择已有任务。
3. 如果需要新任务，输入一个新名称；保存时才会创建空任务并完成绑定。

RabiRoute 内部保存完整任务 ID。任务在 Desktop 中改名或完成 goal 后，只要 ID 和工作目录仍有效，就会继续复用，不会因为名称变化重复创建。

<div class="screenshot-placeholder">
  <strong>截图占位 03｜快速配置：绑定 Codex</strong>
  <span>建议画面：Codex Agent 已选中，扫描状态、项目目录和任务选择器同时可见。</span>
  <span>标注重点：已验证、项目目录、任务名与最后会话时间、重新扫描。</span>
</div>

## 第 3 步：确认人格

人格可以先使用已有示例，也可以留空。无人格 Route 会生成基础规则；有明确角色行为需求时，再进入“Rabi 人格”配置正文和规则。

点击“保存配置”。保存会写入本地 Route 配置，并可能启动或重载当前 Route。

## 第 4 步：检查运行状态

返回“控制台”，确认：

- 顶栏显示 `Manager 已连接`。
- 当前 Route 处于启用或运行状态。
- 当前链路包含“定时触发”和“Codex”。
- 顶栏没有“有未保存的修改”。

如果 Route 已启用但显示“已停止”，先到“日志诊断”点击“启动”或“重启”。

## 第 5 步：手动触发

打开“日志诊断”。在“手动触发”中找到 `heartbeat` 或 `manual_trigger` 规则，然后点击“触发”。

手动触发会进入真实投递链，不是预览。它会写运行记录，并向已绑定处理端开始一次真实投递。

<div class="screenshot-placeholder">
  <strong>截图占位 04｜日志诊断：首次成功投递</strong>
  <span>建议画面：诊断摘要、运行状态、Codex Desktop 任务和手动触发结果处于同一画面。</span>
  <span>标注重点：链路正常、Codex Desktop IPC、最后成功时间、触发成功。</span>
</div>

## 如何判断成功

同时满足下面四项，才算第一条 Route 已跑通：

1. 诊断摘要没有明显断点。
2. 手动触发返回成功。
3. Codex 区域显示目标任务和最近成功时间。
4. Desktop 中同一个任务出现了 RabiRoute 投递的消息。

只看到“配置已保存”不代表投递成功；只看到 Desktop 打开也不代表消息已经进入目标任务。

## 第一次失败时看哪里

| 现象 | 先检查 |
| --- | --- |
| 顶栏显示 Manager 未连接 | Manager 进程和 `127.0.0.1:8790` |
| Route 已启用但未运行 | 日志诊断中的启动按钮和最近日志 |
| 没有可触发规则 | 人格页是否有 `heartbeat` 或 `manual_trigger` 规则 |
| Codex 显示未绑定 | 工作目录、任务选择和重新扫描结果 |
| 出现 `no-client-found` | Desktop 是否已启动并能加载目标任务 |
| 触发成功但任务没消息 | 最后投递协议、任务 ID、工作目录和最近日志 |

详细判断顺序见[运行、日志与排障](operations-and-troubleshooting.md)。

## 下一步

- 接入 QQ：阅读 [Route 与消息端](routes-and-adapters.md)。
- 让消息进入固定项目任务：阅读 [Agent、项目与任务](agents-and-sessions.md)。
- 设置群消息、私聊或定时规则：阅读 [人格与消息规则](personas-and-rules.md)。
