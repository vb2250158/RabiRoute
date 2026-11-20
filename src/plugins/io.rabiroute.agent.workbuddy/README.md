简体中文 | [English](./README_en.md)

# WorkBuddy（腾讯 AI 办公工作台）

通过公共 `POST /api/agent/threads` 指定 `agentAdapter: "workbuddy"` 与 `agentTargetId: "local:workbuddy"`，可直接列出任务、读取任务详情，并按完整 `threadId` 查询原生聊天记录。查询使用 `action: "read"` 和 `history: { limit: 200 }`，续页原样传回 `history.cursor`。记录按文件顺序返回，保留原始事件，坏行及未写完的尾行在 `coverage` 和 `warnings` 中报告。查询与指定 ID 投递可独立使用，角色绑定用于默认路由。

投递使用 `action: "send"`，携带目标 `threadId`、任务实际 `cwd`、`prompt` 和稳定 `deliveryId`。Windows 在首次扫描或投递时自动发现原 owner 的回环监听地址，并以该进程的临时凭据完成鉴权。探测核对 WorkBuddy 进程、PID 和创建时间，凭据通过私有子进程管道进入内存缓存。系统需允许 Manager 读取目标进程信息，例如目标 WorkBuddy 已提升权限时，Manager 也需具备相应的系统访问权限。此流程保持实验性。旧版可继续使用已配置的本地凭据。新版 CodeBuddy HTTP 请求携带官方要求的 `X-CodeBuddy-Request: 1`。接口依据见[官方 HTTP API](https://cloud.tencent.com/document/product/1831/137064)。

0.1.6 候选使用原任务进程的 `POST /api/v1/sessions/{完整任务ID}/reply`，由宿主在进入原生队列前检查当前会话 ID。不匹配返回 409，不尝试其它发送入口。此调用链不设置或修改权限模式；工具审批仍由原生任务执行。HTTP 200 的 `data.delivered: true` 表示调用被接收，也可能仅进入原生队列，不表示回答完成或桌面已即时显示。

本机截图沿用宿主原有的文本附件引用格式，向原任务列出供 Read 工具读取的绝对路径。发送前检查文件，正式投递保存并复核图片哈希；本地图片路径不跨电脑传输。路径引用不代表图片已被读取。

通过 `POST /api/agent/threads` 的 `action=create` 指定 `agentAdapter=workbuddy`、项目 `cwd`、`title`、首条 `prompt` 和稳定 `deliveryId`。请先在 WorkBuddy 登记目标工作区。连接器在填写首条消息前和点击发送时校验原生选中项的完整路径。无法验证路径时，接口会报错。创建回执返回实际原生标题和完整 ID，标题由 WorkBuddy 生成。返回 `202` 时用原编号与原参数查询，已提交的意图只查原生记录。

从 0.1.10 开始，创建和向已卸载的原聊天续投可在 Windows 桌面已登录、WorkBuddy 已安装并完全退出时，自动以当前用户身份启动最小化客户端。已有连接器会直接复用。0.1.12 续投会等待 WorkBuddy 加载原聊天，并在发送前重新核对完整会话 ID 和工作区。回执待确认时沿用原编号查询。Windows 本地可在 RabiRoute 配置中设定 RABI_WORKBUDDY_RESTART_UNMANAGED=1。向原聊天投递时，Rabi 会重启同一 Windows 用户独立打开的 WorkBuddy，等待它以最小化方式接入后继续原消息。该选项可能中断正在运行的 WorkBuddy 任务。查询历史和核对已登记的原创建编号可以在连接器离线时完成。没有接收会话的定时任务运行仍可查看历史。要追问结果，请在普通 WorkBuddy 聊天里继续。

0.1.9 的 Manager 插件直接读取已登记的创建意图和原生聊天记录。即使桌面连接器暂时离线，也可用同一编号和原参数查询。已有记录的请求只查原结果。第一次提交仍由桌面连接器执行。

支持布局合同 v1 的连接器按每次请求读取插件提供的类名和组件名。同一连接可接收不同版本的布局，仍会在填写和提交前核对实际工作区。旧连接器可使用默认布局。首次采用 v1 连接器需要一次桌面生命周期切换，兼容的后续布局调整由 WorkBuddy 插件单独交付。

使用 `action=send`、`workbuddyDeliveryMode="steer"` 和独立的 `deliveryId`，可向本机普通聊天请求引导。桌面连接器核对完整会话 ID、工作区和派发时的活跃状态，再调用 WorkBuddy 的单条消息「立即发送」选项。WorkBuddy 决定消息插入或排队。缺少接收回执时按原编号核对原生历史，已停止派发的编号保留作查询。

重命名由 WorkBuddy 客户端处理。0.1.5 的通用网关会优先使用原进程主会话并临时选择 `BypassPermissions`。网络中断、5xx 或缺失原生回执时保留原投递 ID，按原会话核对。

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../plugins/contracts/plugin-sdk/README.md)。
