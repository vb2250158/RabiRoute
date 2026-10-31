[English](persona-plan-api-contracts_en.md) | 简体中文

# 人格计划辅助 API 的可执行合同

这组合同覆盖计划绑定 Agent 状态与定位、工作区推进策略及附件读取。原计划存储、状态服务、推进策略存储和附件解析器继续拥有业务状态；可执行定义提供统一 HTTP 分发与远端发现。

| 操作 ID 后缀 | 方法 | `/api/roles/:roleId/` 下的路径 |
| --- | --- | --- |
| `agents.status` | GET | `plan-agents/status` |
| `agents.open` | POST | `plan-agents/:planId/open` |
| `advance.settings.read` | GET | `plan-advance/settings` |
| `advance.settings.save` | PUT | `plan-advance/settings` |
| `advance.check` | POST | `plan-advance/check` |
| `advance.run` | POST | `plan-advance/run` |
| `attachment.read` | GET | `plans/:planId/attachments/:attachmentId` |
| `attachment.head` | HEAD | `plans/:planId/attachments/:attachmentId` |

完整操作 ID 使用 `manager.personas.plans.` 前缀。状态读取与附件 GET 保留原 `persona:GET:路径` 别名。已鉴权远端默认可以调用全部公开操作，不增加人格或逐功能许可。

## 原对象和执行边界

状态读取保留重复 `planId` 查询、缺失 ID 列表及完整会话名称和 ID。打开操作只定位原计划绑定，或按 `historyId` 读取服务端保存的历史 actor；调用者附带的 actor 不能替换它。定位不会执行真实 prompt，也不会创建替代 Runtime。

推进设置保留工作区归属、原修订号 CAS 和历史快照。检查保留每页 20 条、最多 20 个显式计划、最多 20000 个会话，以及原状态配置、审批、反馈、步骤、冷却和次数限制。推进必须携带检查所得指纹；执行前重新读取计划与原会话状态，同一会话的计划合成一次投递，交给原绑定 DSH 会话。

推进使用原持久 reservation 与 receipt：未尝试投递时撤回本次 reservation；已尝试但结果未确认时保存 uncertain，后续不能把它当作未执行重新发送。断开或取消会等待原工作返回并完成清理；部分 reservation 后取消的测试确认没有遗留占用。HTTP 成功只表示对应读取、定位或推进结果，不能替代 Agent 任务完成证据。

附件继续由原计划元数据选择文件，保留 managed 目录、运行根迁移后的内容 hash 校验、MIME、下载文件名、私有缓存、GET/HEAD 与单段 Range（206/416）。下载沿用原有限字节读取，不把上传上限添加到既有附件下载上。

每次请求读取当前人格目录并捕获原目录、连接和 Manager 身份；等待后、披露前、导航与写入前均复核。目录切换后的新请求使用新目录，旧请求不能继续使用已失效目录执行后续动作。

## 验证与剩余范围

隔离测试覆盖八项定义、已鉴权空节点成功调用、原会话定位、CAS、检查到推进、重复指纹、未确认 receipt、部分 reservation 取消清理、附件字节/HEAD/Range，以及原有存储等待期间健康接口可响应的回归。使用临时原生计划/推进存储和受控宿主，未投递真实 Agent prompt；不代表安装版或物理设备验收。

这八项不包含计划 CRUD、工作流、记忆、反馈、Skill、健康或录像接口。其余接口迁移完成前仍保留原 prefix 分发。
