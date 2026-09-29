# 眼镜知识写入确认方案

[English](knowledge-write-confirmation-plan_en.md) | 简体中文

**状态：纯确认策略已实现；页面、宿主适配器和写工具接线尚未实现。** 不代表眼镜已支持写入，不是设备验收报告。PC 知识 MCP 已提供受控写工具；眼镜当前单步工具层只广告只读工具，待补用户确认与不确定结果恢复后再开放写入。

## 依据与范围

- [现行工具 Schema](../../../packages/rabi-knowledge-contract/schema.mjs)：`recent_memory_create` 参数为 `{roleId,idempotencyKey,body}`，正文要求 `title`、`focus`、`keywords`、`content`，可选 `source`。服务端另校验 `focus` 单行。
- [单步工具合同](knowledge-single-step.md)：工具结果独立展示，不假造模型续轮。
- [模型工具合同核对](agent-tool-contract.md)：官方结果回传续轮 API 尚未证实。
- [设备 profile 应用合同](agent-profile-runtime.md)及[设备 HTTP 合同](../../../docs/aiui-agent-profile-http.md)：配置、模型应用、工具授权不是同一状态。
- [PC 知识桥](../../../docs/rabilink-knowledge-bridge.md)及[MCP 接口说明](../../rabi-mcp/README.md)：业务数据与回执仍由 Manager 拥有。

首版只设计 `recent_memory_create`。不开放计划创建或修改、记忆更新、归档、删除。不改通用 Manager 接口，不新增记忆业务真源。

## 草稿与确认

模型只调用本地草稿能力，例如 `prepare_recent_memory`，不能直接写入。模型不得提供幂等键、目标 PC、角色授权或来源凭据；角色由用户明确选择。眼镜可采用比服务端更窄的长度限制，例如标题 80、focus 120、正文 1000 字符、关键词 1–8 个；这些数值是待实现的产品限制，不是现行服务端限制。

页面完整展示有界草稿、目标 PC 与角色。**首版必须有物理控件或手机上的明确确认，不把语音短码视为足够安全的唯一确认。** 语音可作为辅助：挑战码仅显示，不由 TTS 念出；仅接受 TTS 结束后新 ASR 会话中的最终片段、精确确认短语，排除历史片段、工具输出和模型文本。现有回声抑制不能证明误确认不会发生，须真机验证。

建议草稿确认窗口为 60 秒。修改内容需重新确认。进入后台、切换设备凭据、角色、目标 PC 或 profile revision 后，未发送草稿失效。目录当前不保证提供授权版本，不能声称已实现 grant revision fence；发送前再次检查目录和授权，PC 执行时仍须做最终权威授权校验。

## 冻结意图与单次发送

建议状态：`draft` → `awaiting-confirmation` → `dispatching` → `confirmed` / `uncertain`，另有未发送的 `expired` / `cancelled`。

确认后先原子持久化客户端操作记录：设备作用域、profile revision、目标 PC、角色、冻结正文、指纹、稳定幂等键和 `dispatching` 状态。记录不包含 Token，不复制已保存记忆。持久化失败不得发送。安全随机能力需经过宿主验证；无法取得合格的随机操作键时关闭写入，不用时间戳冒充强随机。

同一次确认只能消费一次。重启遇到 `dispatching` 应进入待核查状态，不自动重发。草稿 TTL 不删除已发送的待核查记录。发送前取消可以终止操作；发送后取消只停止呈现，不得声称已撤销 PC 写入。

授权必须同时满足设备 grant、PC 本机策略、MCP 写入开关和真实目录中的工具可用性。profile 中启用 MCP 引用不是写授权；短码也不增加权限。

## 成功证据与不确定结果

仅当 MCP 结果没有 `isError`，且 `structuredContent` 同时满足以下条件，才显示写入成功：

- `ok === true`，`uncertain !== true`；
- `commitState === 'committed'`；
- `idempotencyKey` 与冻结键一致；
- 强 ETag 合法，`data.id` 非空。

超时、网络断开、5xx、身份切换或不完整回执均需保留原键和正文，不自动重发，不换键创建。模型回复不是执行证据。

旧冻结包 `e6e3709e82f8` 中的 Relay 写入意图只保存键与正文哈希，同键返回 `409 uncertain`。候选 `0.3.15-397c589c9e64` 已包含[只读操作回执查询](../../../docs/rabilink-knowledge-operation-receipts.md)实现，但尚未部署，历史 persist 超时原因仍未确定，不能假定现有安装支持恢复。**没有可用查询或查询仍为未知时，保持 `uncertain`、保留原键和正文，不自动重发，并人工在 PC 核查。** 搜索到相同标题或正文只能辅助调查，不能证明对应原操作键成功。

最小恢复扩展是 Relay 持久保存现有队列返回的真实 Manager 回执，并提供同设备归属、目标 PC、角色及原操作键授权的只读查询。它只保存转发操作证据，不成为计划或记忆第二真源。若 Relay 在获得回执前中断，查询仍只能返回未知；不能借重复 POST 或同键 409 伪造恢复成功。本方案不授权泛化 Manager 重构。

## 建议实现与验收

已新增未接入页面的纯 helper `utils/knowledge-write-confirmation.js`，使用必填依赖 `now/createKey/persist/send/validateReceipt`，没有默认 wx、crypto、HTTP 或物理事件实现。`capabilities` 的三个开关仅声明适配器的契约义务，不证明宿主安全随机、原子持久或真实用户确认已经验收；真实适配器必须独立通过设备验收才能接入。测试仅使用 mock send。模块暂未纳入 AIX、Check-Agent 或运行入口，六个只读工具不变。

纯策略限制标题 80、单行 focus 120、正文 1000、关键词 1–8 个且各 80 个 UTF-16 单元，确认窗口 60 秒。状态为 `awaiting-confirmation` → `dispatching` → `confirmed/uncertain`；确认时同步锁定，先持久化冻结原键正文，再最多调用一次注入发送；等待中取消、换作用域、后台或超时阻止尚未开始的发送。持久化异常保持未知并禁止重放。成功状态只在最终持久化完成且作用域再次一致后发布；之后取消不意味着回滚。重启恢复保守地将包括已存 `confirmed` 在内的记录降为 `uncertain`，当前没有恢复查回 API。`snapshot()` 含原作用域意图，只供内部恢复，不可在账号或作用域变化后直接显示给新作用域用户。后续需独立实现回执验证和恢复查询，不放宽只读 runtime。

实现范围不包括设计中的密码学指纹、宿主原子性、物理输入门禁或真实 Manager 回执校验；`validateReceipt` 当前只在测试中注入。`send` 适配器必须有界结束或拒绝，纯模块没有网络超时器；永不结束的 send 会保持待定且不重放，模拟异常仅证明拒绝路径，不证明真实超时恢复。

### 三项设备探针前置条件（未执行）

1. 仅记录事件序号、相对时间、tap/keydown/keyup 回调与 code/key/repeat/isTrusted 字段、可见性及 TTS 状态，不记录语音正文。核对单击、双击、长按、TTS 打断后释放与后台切换的顺序和重复；保持原 tap 打断和双击退出，不调用写接口。
2. 只探测 crypto/getRandomValues/randomUUID 的存在、调用结果长度和格式，不记录随机值。函数存在不证明 CSPRNG 质量，仍需对应宿主版本的官方合同。
3. 只读能力探测不能证明存储原子性。先核对 wx 存储 API；另行核准后才能用独立可丢弃测试 key 和合成版本/校验记录验证受控退出后的读回，不能写业务配置。单次成功仍不替代宿主持久化合同。

测试至少覆盖：错误／过期短码、TTS 回声、非最终 ASR 片段、重复确认、换凭据／角色／PC／profile、保存失败零调用、双击仅一次调用、超时零重放、错误幂等键、伪造成功回执、重启恢复、队列 lease 到期和回执丢失。模拟通过不能替代物理确认流程与真机误触测试。
