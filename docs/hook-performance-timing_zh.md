# Agent Hook 性能计时

简体中文 | [English](hook-performance-timing.md)

`POST /api/codex-hook/context` 成功响应可包含 `data.timings`，每项为 `{ name, startMs, durationMs }`。时间使用单调时钟，相对于 Hook 拥有者入口，单位为毫秒。标签不含请求正文、会话身份、文件路径或凭据。计时只是可选诊断，不代替业务回执；缺少计时不表示业务操作被跳过。

`context-build` 覆盖上下文排队、读取与整理。Stop 按实际执行返回 `plan-followup`、`chat-history`、`agent-request-stop`、`file-change-reminder`、`plan-completion` 和 `completion-delivery`。改动提醒后延期执行的后台工作不计入已完成请求，不显示为已完成的服务端处理。错误响应保持原有语义，不保证包含内部计时。

DSH 的 Rabi 适配器 0.13.42 将连接与服务端计时写入可忽略的 hook-result 事件，性能统计 0.1.10 可在对应生命周期事件下逐层查看。服务端上报耗时归入所属接口请求，传输、排队及其他未测部分单列。旧日志保留已采集总量，不补造内部计时。Manager 接口由 Codex 等端共用，但可选计时字段不表示 Codex 已提供同样的统计界面。

Stop 只读取完成钩子已启用且属于当前会话的计划流程配置，不初始化或校验无关角色的流程。托管任务通信策略只在 `PreToolUse` 查询；人格归属和 Stop 计划恢复检查仍在原入口执行。

已认证的远程 Agent 每次连接检查仍核对电脑凭据，但不再额外执行 WebGUI 网卡枚举。浏览器凭据、Relay 代次和作用域仍由原拥有者核对，不跨异步工作缓存授权结果。

NapCat WebUI 配置发现按优先级逐项读取，目录扫描使用异步文件接口。已配置文件匹配后即结束查找，不再先扫描无关安装目录；健康与账号归属检查也通过异步接口读取 WebUI 和 OneBot 文件，账号归属检查仍按需查询后备安装。已发现的路径不缓存凭据内容，下次读取仍能发现 token 变更、文件删除和 WebUI 禁用。后备目录较慢时，不再通过递归同步目录读取阻塞 Manager 事件循环。

Manager 操作日志在每个已测 Stop 阶段开始、完成或失败时记录 `agent_hook_stop_stage`，包含会话、轮次和 HTTP 请求 ID。只有开始、没有结束的阶段用于定位未完成的工作，不代表业务成功。响应完成前连接关闭会记录 `http_request_aborted`；正常响应仍只记录 `http_request_completed`。这些诊断不含提问、回复、工具参数或凭据，也不会重试、取消或跳过业务操作。
