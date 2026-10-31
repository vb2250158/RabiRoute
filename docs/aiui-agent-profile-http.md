# AIUI 设备 Agent 配置 HTTP（实验）

[English](aiui-agent-profile-http_en.md) | 简体中文

设备配置由明确登记的 RabiPC 保存，Relay 只保存鉴权和固定连接归属。新版采用公共 Manager 接口；旧 Relay 配置、知识授权和配置编辑器入口已退役，所有客户端必须更新。旧业务数据不自动导入新配置。

## 身份与数据归属

手机入口为“全天记录 → 设备 → 眼镜 → 眼镜设置 → 当前使用的角色”。AIUI 绑定角色后使用该角色身份、指引、Skill 和聊天记录，模型仍由乐奇配置。未绑定角色也能调用公共接口；绑定不限制权限、工作区或其它角色操作。启用 remoteAgent 后，已鉴权 Agent 可调用目标 PC 的全部公共 API，后续新增公共 API 沿同一通用传输使用。

设备凭据登记时必须明确 `connectionTargetDeviceId`，它是该绑定固定的配置 owner PC。切换 PC B 的角色时，配置仍由 owner PC A 保存，工具与聊天记录默认调用角色来源 B；其它同应用 PC 可显式选为调用目标。配置归属只决定数据保存位置，不授予或限制调用者权限。

Relay 的 `GET /api/rabilink/devices/connections` 返回连接目录，不包含角色或 Skill。应用级公共设置首次通过 `PATCH /api/rabilink/mobile/connection` 的 `{connectionOwnerDeviceId}` 明确登记固定 owner，不从默认消息目标推断。已有固定归属不能通过修改默认目标或重置同一绑定凭据改变。

PC 首次确认连接归属后持久缓存元数据，已确认设备可在公网不可用时通过 LAN 继续使用；未知设备须先发现，不能猜 owner。同一应用作用域下发现相同设备的归属冲突时失败关闭。更换连接作用域隔离配置和缓存。

身份来自经过验证的本地隧道或 Relay worker。Manager 仅在真正 loopback、本代 `x-rabilink-tunnel-local` 和受管传输成立时信任注入的设备 ID；正文和客户端自报头不能建立身份。应用管理凭据可保存指定设备配置，不能冒充眼镜确认应用；设备自身回执须来自原设备绑定。

## 可执行合同与自动发现

六个操作由同一组定义同时安装 HTTP 路由和发现目录：`manager.rabilink.agent-devices.list`、`manager.rabilink.agent-devices.profile.read`、`manager.rabilink.agent-devices.profile.save`、`manager.rabilink.agent-devices.profile.receipt.record`、`manager.rabilink.agent-devices.profile.operation.read` 和 `manager.rabilink.persona-template.read`。模板入口不再依赖其它路由的 prefix 声明。

请求与响应 DTO 复用 `packages/rabilink-agent-contract/profile.mjs` 的 `PROFILE_SCHEMAS`，原生校验器继续负责 UTF-16 长度、唯一 ID、正文总量、版本及幂等语义。读取正文前捕获原连接与 PC 拥有者；等待人格来源后再查设备归属，写入和返回前复核原上下文。连接业务上下文尚未配置返回 `503 PROFILE_CONTEXT_UNAVAILABLE`，不解释为额外功能许可。伪造来源及已撤销连接仍被拒绝。

设备保存结果与实际应用回执分开。管理连接不能代签设备的应用确认。保存已发生而后续确认失败时，响应标记 `uncertain=true`；先用原 `deviceId` 与正文 `idempotencyKey` 查 `/profile/operations/{key}`。未找到返回 HTTP 200 和 `receipt:null`，不能据此断定请求从未执行。这里没有启动 Agent、发送 prompt、下载模型或执行 MCP。

## 公共 PC 接口

| 方法与路径 | 结果 |
| --- | --- |
| `GET /api/rabilink/agent-devices` | 当前应用连接作用域内的已保存配置列表 |
| `GET /api/rabilink/agent-devices/{deviceId}/profile` | `{code:0,data:{profile,applied,savedRevision}}` |
| `PUT` 同路径 | 保存 `{expectedRevision,idempotencyKey,profile}` |
| `GET /api/rabilink/agent-devices/{deviceId}/profile/operations/{key}` | `{code:0,data:{receipt}}`，按原键读取历史回执 |
| `POST /api/rabilink/agent-devices/self/profile/receipt` | 原设备确认 `{idempotencyKey,appliedRevision,status,errorCode?}` |
| `POST /api/rabilink/persona-template` | `{roleId,skillIds}`，读取被请求 PC 的角色模板 |

Android 使用通用加密 Manager Tunnel，顺序为 LAN → P2P → Relay。当前 AIUI 宿主只有 `wx.request` 时使用 `/api/rabilink/device/api` 的 buffered HTTP Relay 降级；这条降级不宣称已支持 LAN/P2P。请求固定 `targetDeviceId`，Relay 不读取 `personaRef` 或 `profileRevision` 来决定路由。见[通用接口传输](../apps/rabilink-aiui/docs/generic-api-transport.md)与[Relay 合同](rabilink-relay-server.md)。

profile 为 `{revision,id,name,systemPrompt,skills,mcp,personaRef?}`。`personaRef` 为 `null` 或 `{roleId,sourceDeviceId}`；保存时核对该来源 PC 确实存在该角色。Skill 为 `{id,title,content,enabled}`；MCP 为 `{id,label,enabled}` 引用，不能包含 Token、URL 或执行命令。引用不是授权，保存也不代表连接或工具执行成功。

限额由 `packages/rabilink-agent-contract/profile.mjs` 唯一定义：ID/名称 128 字符，系统指引 8000 字符，Skill 最多 16 项、单项正文 8000、正文总量 24000，MCP 最多 16 项。模板读取支持 Manager 的原始 JSON envelope 或一次解包回调，前后核对来源 application generation。

## 写入与回执

profile revision 从 1 递增，首次 `expectedRevision` 为 0。CAS 冲突返回 412，同键异意图返回 409，同键同意图返回原回执。每设备保留最多 128 个操作回执，容量满时失败关闭，不淘汰原键。客户端同时保留通用请求 `operationId` 与 profile `idempotencyKey`，不能在超时后换键重放写入。

结果不确定时回读原操作回执和资源。`receipt:null` 不能证明原写入失败；更高版本覆盖当前配置后仍可按原键核对旧回执。设备应用回执的 `status` 为 `applied` 或 `failed`，失败须带受限 `errorCode`；不得确认未保存版本或倒退已应用版本。已保存、设备已应用、实际 Skill/工具执行和硬件唤醒是不同证据。

PC 按应用连接作用域保存配置和回执。异步来源读取后、写入前再次核对 scope 与来源身份。文件写入使用同目录临时文件、fsync、旧文件快照和完整回读，失败恢复快照。这是单次写入的恢复机制，不是长期备份。没有宣称多进程共享文件写入或跨平台断电事务保证。

## 损坏配置的隔离

配置按设备隔离。列表返回健康设备，并在 `coverage.invalidDeviceIds` 中列出无法读取的设备 ID；访问这些设备的配置或操作回执返回 `503 PROFILE_RECORD_INVALID`。其他设备仍可正常读取、保存与核对原回执。保存只更新目标设备，其他设备的原始记录（包括坏记录）继续保留，不用空配置覆盖，也不自动删除。

若损坏涉及整个文件或连接作用域的结构，无法确认其中设备归属，则拒绝该存储范围的操作。此限制不扩大到其他独立模块。

## 验证状态

隔离测试启动真实 Relay 与 PC owner，仅使用临时账号、凭据和文件，覆盖通用 HTTP、固定目标、管理保存、设备自身应用回执、冒领拒绝、CAS、原键查询、重启恢复和旧入口退役。公网部署、真实眼镜按键唤醒、ASR/TTS 并行与引导、乐奇登录和未发布版本上传须单独验收，不能由 fixture 代替。完整流程见[验收清单](aiui-agent-acceptance.md)。
