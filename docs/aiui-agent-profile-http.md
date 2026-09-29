# AIUI 设备 Agent 配置 HTTP（实验实现）

[English](aiui-agent-profile-http_en.md) | 简体中文

Relay 复用应用 `deviceBindings` 保存设备配置，不保存模型或 MCP 凭据。源码与本机隔离 HTTP 测试已完成，尚未部署或真机验收。

## 管理账号

`GET /manage/api/apps/:appId/devices/:bindingId/agent-profile` 返回 `{code:0,data:{profile,applied,savedRevision}}`。要求管理账号已认证且为该应用 owner。

`PUT` 同路径，JSON 正文为 `{expectedRevision,idempotencyKey,profile}`。要求 `Content-Type: application/json`、`X-RabiLink-Profile-Write: 1`；拒绝 `Sec-Fetch-Site: cross-site`，提供 Origin 时必须与请求 Host 同 host/port。自定义头触发浏览器预检；该合同不授予凭据 CORS。反向代理必须保留公开 Host，不能靠伪造转发头绕过。管理认证沿既有账号会话/Basic 合同，不能使用设备 token 写配置。

profile 为 `{revision,id,name,systemPrompt,skills,mcp}`；revision 从 1 递增，expectedRevision 首次为 0。skills 为 `{id,title,content,enabled}`，mcp 仅 `{id,label,enabled}` 引用，不接受 token、URL 或执行命令。具体限额由 `scripts/rabilink-agent-profile.mjs` 校验。

CAS 失败返回 412，同键异意图 409；同键同正文返回原回执。每设备最多保留 128 个操作回执，满后失败关闭，不淘汰幂等键导致旧意图重放。生产长期运行前需补充受控回执生命周期，当前不可宣称无限配置更新。

## 手机管理界面

手机浏览器登录 Relay `/manage`，在应用的已绑定眼镜列表点击“Agent 设置”。ID、名称和系统提示使用表单；Skill 使用可视化条目编辑 ID、标题、指引内容与启用状态，可添加和删除；最多 16 项，每项内容 8000 字符、总内容 24000 字符，按钮至少 44px。JSON 高级模式与可视模式互斥，切入时同步草稿，返回或保存时必须通过同一 profile 校验；错误 JSON 保留原文本且不发送，不另建配置真源。MCP 提供固定 `rabi-knowledge` 的启用开关及显示名称表单；无引用时仅在明确开启后添加，关闭保留条目与名称。未知引用按原顺序和启用状态只读保留，并说明此应用不支持；只有高级 JSON 明确编辑才改变或删除。已有 16 项且没有已知引用时禁止追加，不淘汰原项。高级 JSON 与表单共用一个草稿且互斥，无效文本保留并阻止发送。授权请另开设备“知识授权”；不接受 URL、Token、command，不安装第三方服务或扩展权限。页面分别显示已保存版本、模型应用回执和“MCP 未验证”，不把引用保存当作连接成功。

初次回读、保存中及待确认时冻结全部字段和 Skill 操作。保存前校验完整 profile。迟到响应若账号已改变，不清原待确认正文、不更新版本，也不将旧面板重新加入新账号的阻塞集合。网络失败或不完整回执会冻结原正文和幂等键，只允许回读，不自动重发或换键；发送前先将精确正文和幂等键保存到当前标签页 `sessionStorage`，按已认证账号 ID、应用 ID 和绑定 ID 隔离，存储失败则不发送；不保存 Token。硬刷新后只有同账号通过设备归属 GET 校验才恢复待确认请求，不自动重放。成功回执须通过完整 profile 规范化比对及 applied 字段校验，只有键和版本相同不足以确认。待确认写入按原键查询 `GET /manage/api/apps/:appId/devices/:bindingId/agent-profile/operations/:key` 的历史回执（`{code:0,data:{receipt}}`），因此当前配置被更高版本覆盖后仍可确认旧写入；`receipt:null` 不代表失败，不触发重发。确认成功或明确拒绝后清理记录，退出账号隐藏原编辑器，其他账号不能恢复它。关闭标签页或清除浏览器数据仍可能丢失记录，因此页面会提示离开风险，并阻止应用列表刷新覆盖编辑器。412 必须回读最新配置再确认；128 条回执容量满时明确提示维护，不通过换键绕过。回读会覆盖未保存的编辑，请先自行保留草稿。

管理页实际 JavaScript 的 Node 内置最小 DOM 模拟测试（非浏览器布局测试、无外部依赖）覆盖安全文本渲染、双击去重、写入头、刷新恢复、跨账号隔离、存储失败拒发、异常回读、412 和容量错误；本次相关测试 18/18 通过；真实 Chrome 320/390/768px 下可视化添加 Skill、保存与 GET 回读一致，错误高级 JSON 零写入且文本保留，无横向溢出，按钮至少 44px。未知回执和迟到账号隔离由实际页面 DOM 测试覆盖。后续 MCP 选择器相关纯测试与实际页面 DOM 测试 13/13 通过；Chrome 320/390/768px 开启引用、修改名称、保存并 GET 回读一致，同时保留原 Skill；无效高级 JSON 零 PUT 且原文保留，无横向溢出或页面错误。未知启用项保留、16 项边界、字段校验与冻结由纯测试覆盖。尚未部署或手机真机验收；MCP 选择器新增第 14 个 Relay 模块，已冻结的 13 模块候选 `0.3.15-d1ae4d594048` 不含此后续界面，原版本证据不能替代新界面验收。

## 设备

设备凭据通过现有 `x-rabilink-token` 请求头携带，仅接受已启用绑定的独立设备凭据；应用 token 拒绝。

- `GET /api/rabilink/device/agent-profile`：仅自身配置。
- `POST /api/rabilink/device/agent-profile/applied`：正文 `{idempotencyKey,appliedRevision,status,errorCode?}`。status 为 `applied` 或 `failed`，失败必须带受限 errorCode。不得确认未保存版本或倒退已应用版本。

已保存不等于眼镜已应用；设备应用回执也不能替代真实 MCP 连接或工具执行证据。

## 存储与验证

现有单 Relay 进程内同步读改写，无 await 间隙；完整文件写到同目录独占临时文件，fsync 后 rename。读取或已存配置校验失败时拒绝继续，不以空数据覆盖旧文件。未声明多进程共享文件写入安全或跨平台断电事务保证。

隔离 fixture 启动真实 Relay，仅使用临时账号、设备和文件，验证身份、CSRF、CAS、幂等、重启恢复及损坏存储失败关闭。不操作公网 Relay 或真实用户配置。
