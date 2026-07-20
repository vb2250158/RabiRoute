<!-- docs-language-switch -->
<div align="center">
<a href="./acceptance-report_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI 验收报告

更新时间：2026-07-16

## 验收结论

当前结论分为三层：

- **本地验收：通过。** record-first 连接对话、可选常驻转写入口、统一 JSONL、空闲审阅、触摸板引导、周期反思、持续下行流、无任务主动投递、AIUI 原生 ASR/TTS Adapter、TTS/ASR 交接、配置助手原生 `LanguageModel`/外层 Agent 双入口、双模式 UI、CXR 电量链路、Ink resize、启动安全和最终 AIX 均已通过自动化测试。
- **真实服务链路：历史闭环通过，当前实现待重验。** 公网 Relay、本机 RabiRoute 和真实 Codex 曾完成双向独立队列、无输入主动投递、observation 快速落盘、触摸板审阅、无任务主动回复、统一账本、去重及远程配置回滚。此后 record-first 常驻入口和审阅提示发生变化，旧 E2E 已因版本、AIX、实现摘要或时效不匹配被证据门判为 `stale-live-e2e`，不能证明当前代码。Codex app-server 暂时超时只会延后审阅并保留账本游标，不再使 RabiLink 路由进程退出。
- **1.0.23 云端与真机验收：待完成。** 1.0.17 增加眼镜云日志离线队列和双重隐私过滤；1.0.18 修正发布包 Relay 地址注入，避免包内保留示例域名；后续版本继续完善设备绑定、持续队列和启动稳定性。当前 1.0.23 仍需重新构建、上传并在真眼镜核验。

这里的“原生 AI”是 AIUI 页面内的 `LanguageModel`，属于灵珠提供的原生模型能力，但不是递归调用当前绑定灵珠智能体的完整 Agent Loop。它不会自动继承外层智能体的记忆、变量或插件；外层智能体仍可把已确认的严格 `intent` 传给页面。

不能用本地模拟 ASR、Craft 文字注入或此前 CXR 电量记录替代最终眼镜运行结论。

## 当前交付物

| 项目 | 当前值 |
| --- | --- |
| 云端智能体 | `RabiLink` |
| 本地待发布版本 | `1.0.23`（以 `craft-release.json` 为唯一真源） |
| 当前云端版本 | 未重新读取 |
| AIX | `dist/rabilink-aiui.aix` |
| AIX / Craft 共享 VERSION | 每次 `npm run delivery` 生成；以当前 AIX、`craft-upload/VERSION` 和安装清单为准 |
| AIX SHA256 | 以当前 `dist/rabilink-aiui.aix` 和 `dist/delivery/install-manifest.json` 为准 |
| 1.0.23 云端状态 | 尚未重新读取；不得自动执行外部发布 |
| 本地验收 | 21/21 通过 |

源码 AIX、`dist/delivery/rabilink-aiui.aix` 和 ASCII 临时镜像必须保持相同 SHA256。

## 原始需求逐项验收

| 需求 | 结论 | 权威证据 | 真机待验 |
| --- | --- | --- | --- |
| 首页使用左右双段滑轨 | 本地通过 | `Audit-AiuiDesign.mjs` 断言两处 `modeSwitch`、移动 thumb 和无 `<button>`；Ink 截图可见双段轨道 | 最终眼镜截图 |
| 左侧模式命名 | 采用 `连接对话`，通过 | 页面 Schema、HUD、卡片和 Agent 说明统一使用最终名称 | 无 |
| 右侧为配置助手 | 本地通过 | 同一 InkView 的右侧轨道为 `配置助手`；20 次往返不调用 `finish()` | 眼镜触摸板实测 |
| 重试、暂停低于模式切换层级 | 本地通过 | `utilityAction` 位于滑轨下方，无 border/background；配置助手不显示伪“说话”按钮 | 眼镜可读性确认 |
| 滑动直接切换，不再点击进入 | 本地 Ink/Craft 仿真通过 | Ink 0.13/0.14 从两个入口 resize；触摸事件走同页状态机 | 眼镜真实触摸板方向 |
| 左下时钟图标和时间 | 本地通过 | `clockIcon` + `HH:mm` 在沉浸式 HUD 和 448×150 卡片均完成像素渲染 | 眼镜本地时间核对 |
| 电量左侧显示发布版本 | 本地通过 | `craft-release.json` 构建注入 `v1.0.23` | 眼镜核对版本字样 |
| 无 token 首次设置 | 本地协议与运行时通过 | 无凭证时进入独立 Setup，显示 SN 与 `/manage`；后台绑定后一次性领取 `rbd_` 并写入 Agent 隔离的 `localStorage`，随后自动进入正常 HUD | 真眼镜核对 SN 与自动切页 |
| token 与队列隔离 | 本地通过 | 不在普通设置中读写主 token；设备凭证按 Relay + SN 隔离；cursor、observation 与待播 TTS 队列按不透明 token 指纹隔离 | 换绑后确认不继承旧队列 |
| 右下电量图标、百分比和充电标记 | 本地 CXR 链路通过 | 97% + charging fixture 完成 Ink 渲染；Relay 状态覆盖鉴权、持久化、过期清空；不接受浏览器或手机通用电量 | 最终 AIX 读取实时眼镜 CXR 电量 |
| 默认连接对话、配置助手直接可说 | 本地通过 | 模式控制语句由配置 ASR 直接执行；其他完整原话进入惰性创建的 AIUI 原生 `LanguageModel`，模型只能从 85 条动作中发出白名单 toolcall，澄清/TTS 后自动续轮；外层 Agent `intent` 保持严格匹配 | 眼镜连续说两条自然语言配置需求 |
| 连接对话不维护回答任务状态 | 真实链路通过 | observation 上行 `/input` 返回 accepted；PC 在 435ms 内写入统一账本并释放，触摸板审阅后绑定 `RabiActive` 的真实 Codex 约 68 秒才独立回复 | 眼镜长时间运行 |
| Codex 可随时通过 Rabi 主动下行 | 真实链路通过 | 没有任何前置输入的主动消息在 184ms 内进入持续队列；触摸板审阅回复同样无 `taskId`、`proactive=true`；两类消息重复数均为 0 | 真眼镜显示和原生 TTS |
| 眼镜离线时主动消息不丢失 | 本地与 Relay 集成通过 | Relay outbox 与 task 生命周期解耦并保留至少 48 小时；首次连接读取保留 backlog，不再 `tail=1` 跳过已有消息 | 断开眼镜后由 Codex 投递，再连接播报 |
| 页面隐藏或模式切换不吞掉未播完消息 | 本地通过 | 每批下行先按 token 的不透明指纹持久保存再推进同指纹 cursor；两条消息中途隐藏、重建页面后从第一条重播并继续第二条，成功 TTS 后才移出队列；换 token 不会误播。单条永久失败 3 次后保留待重试但让出队首，后续消息继续播报 | 眼镜真实隐藏/恢复与模式往返 |
| 页面重建后自动补传旧 observation | 本地通过 | 首次前台激活立即 flush 同 token 指纹的持久转写队列；断网失败后重建页面会沿用同一 `clientMessageId` 自动重试并清空已确认项，不需要用户再说一句触发；换 token 不会误传 | 真机断网、退出、恢复后核对账本 |
| 用户观察与 Agent 下行共用时间线 | 真实链路通过 | observation 为 `user_to_agent`，成功排队的主动回复为 `agent_to_user`，E2E 确认二者位于同一当前 JSONL；归档只机械切分 | 真眼镜连续使用后的归档核对 |
| 分卷不漏掉未审阅 observation | 本地通过 | 审阅器按归档与当前文件组成完整时间线；索引原子替换，损坏或缺失时会发现未登记的日期分卷；Codex 离线期间跨日期/空档分卷的旧记录仍位于 pending 范围 | 设备长时前台与跨日复测 |
| manager 与 gateway 并发写账本 | 本地通过 | `.rabilink-conversation.lock` 跨进程串行化去重、分卷、索引和 append；独立进程持锁回归通过 | 长时间双向高频写入 |
| 外部常驻转写进入同一 record-first 账本 | 本地通过 | 可选 `rabilinkRecordFirstSources` 将 FenneNote 或命名 Webhook 转写以稳定消息身份写入同一 JSONL；相同消息 ID，或相同生产端时间戳与正文的回调重试会去重且不逐段创建 Codex turn；默认关闭 | PC 常驻转写长时运行；它不代表眼镜后台录音 |
| 手机/手表等便携端复用双向队列 | 本地 Relay/Android 构建通过 | `/api/rabilink/devices/input` 默认 record-first；下行按设备 ID/类别过滤并让每个 cursor 越过不可见消息；目标变化复用 `deliveryId` 返回 409；Android SDK 可一次性上行/拉取，手机 CXR 服务改用 `connectedDevice` FGS | 真手机、真手表与眼镜跨设备验收；Wear Data Layer 尚未实现 |
| 网络不确定时安全重试 | 本地与 Relay 集成通过 | 上行完成、WebGUI 完成和下行 `deliveryId` 均幂等；PC 显示名变化可由稳定 GUID 继续认领 | 弱网真机复测 |
| Codex 暂时不可用时路由保持在线 | 本地与运行态通过 | 后台审阅的 startup、interval、wake 和 queued wake 均统一捕获 app-server 错误；注入 `thread/list` 超时后可再次审阅，重启 RabiLink 后持续运行 | 长时间断开/恢复 Codex 复测 |
| TTS/ASR 防回流 | 本地通过 | TTS 前 abort 当前 recognition；使用 `speak(utterance, "enqueue")`。宿主有生命周期事件时立即收尾，没有事件时由有界时长 watchdog 收尾并恢复下一轮 ASR，不再依赖官方未承诺的 `onend` | 眼镜扬声器、麦克风与实际播报时长实测 |
| 原生语音统一 Adapter | 本地通过 | `Smoke-RabiLinkVoiceRuntime.mjs` 和共享 DTO 单测验证 `aiui_native` capability、最终 ASR DTO、TTS accepted attempt、无 API key、无网络 fallback 和不可用时明确错误；页面不再直接构造 TTS utterance | 真眼镜确认原生 ASR/TTS 可用性 |
| 配置助手执行 RabiLink 配置 | 集成通过 | 页面内原生 `LanguageModel` 只负责选取白名单动作；页面或外层 Agent 的严格 intent 再直接分发到 Relay mobile/WebGUI API，未知需求不提交 task | 眼镜发出真实只读配置指令 |
| 非沉浸式入口卡也使用同一设计 | 本地通过 | 448×150 卡片与沉浸式 HUD共享模式状态；卡片截图和 safe-width 像素检查通过 | Craft/眼镜宿主最终显示 |
| 安装和使用问题形成文档 | 通过 | `installation-and-troubleshooting.md` 已覆盖五阶段发布、ADB、Craft、ASR、卡死、局部重绘、电量、UTF-8 与常驻边界 | 后续问题继续追加 |

## 自动化结果

以下命令已在最终 AIX 上通过：

```powershell
npm run check
npm run acceptance:local
npm run delivery:verify
```

关键结果：

- `npm run check`：85 条白名单配置动作、record-first ASR、文本重复/TTS 回声过滤、无 utterance 生命周期回调时的 TTS watchdog/ASR 恢复、坏消息 3 次后让出队首与触摸板重试、配置模式语音切换不等待 `LanguageModel`、完整配置原话进入原生 `LanguageModel`、严格外层 Agent intent、持续主动下行、token 指纹队列隔离与旧存储迁移、20 次同页模式往返，以及配置 HUD 1.2 秒稳定采样的黑帧 0、局部帧 0。
- `npm run acceptance:local`：21/21 项通过；主动智能核心项直接运行 record-first 分类、任务外主动下行、统一账本恢复、空闲/周期审阅和触摸板引导测试，原生语音项验证 AIUI Adapter 无付费 API 或隐藏 fallback，常驻转写项另行验证 FenneNote/命名 Webhook 写入同一账本、带稳定 ID/生产端时间的重试去重且不直接转发。
- `Smoke-RabiLinkRelayMobileWebgui.mjs`：广播、watch 定向、legacy glasses 过滤、phone 过滤、独立 cursor、目标幂等冲突和 portable record-first task 全部通过。
- Android `:app:assembleDebug`：便携设备 SDK DTO/上行/下行方法与 `connectedDevice` 前台服务声明完成编译打包；这不是手机或眼镜真机运行证据。
- Ink 0.13/0.14：从连接对话和配置助手两个入口执行卡片到沉浸界面 resize，均完成 20 次模式往返。
- 启动安全：预览不抢占 ASR；连续快速失败在第 5 次停止自动重试。
- 字体压力：使用 125% 字体夹具渲染沉浸式和 448 x 150 卡片，标题、滑轨、状态、正文和底栏均未重叠。
- Delivery：最终 AIX 9 个文件；AIX、同批 `craft-upload` 目录和安装清单复用同一个 UUID，发布版本、VERSION、全部包内文件和 SHA256 与当前源码构建一致。
- 设备 readiness：`-RequireGlass` 只接受 10 分钟内的手机 CXR/编译页证据或当前直连 ADB；历史电量报告不会再被误报为“当前检测到眼镜”。运行证明只接受当前发布版本、20 分钟内、同一 session 的启动事件加 Relay/配置操作，旧包事件不能冒充当前包。
- 历史真实服务 E2E：无输入主动消息 184ms；observation 落盘并释放上行 435ms；触摸板审阅后绑定 `RabiActive` 的真实 Codex 回复约 68 秒；回复无 `taskId`、`proactive=true`，同一 JSONL、重复数 0；远程配置精确回滚。当前证据门会同时核对发布版本、AIX SHA256、实现摘要和默认 60 分钟时效，因此该历史报告已被正确拒绝。
- 历史 Relay 部署健康检查：`ok=true`，outbox 独立保留 `172800000ms`（48 小时）；它只说明当时部署状态，不替代当前实现的授权 E2E。
- RabiRoute 回归：151/151 项通过；后台审阅的 app-server 超时、分卷后 pending observation、损坏/遗漏索引恢复、原子审阅游标、重复分卷索引替换、跨进程账本锁和外部常驻转写 record-first 去重均已加入回归测试。

`npm run readiness`、经授权的当前实现 live E2E、`npm run runtime:proof` 和 `npm run goal:evidence` 用于最终证明。当前 `goal-evidence` 明确保留 `stale-live-e2e`、手机/Craft/审核/安装、眼镜连接和真机运行缺口；在这些证据完成前，不把总目标标记为完成。

## 证据索引

- `dist/local-acceptance.json`：21 项本地验收矩阵。
- `dist/live-relay-codex.json`：脱敏的公网 Relay + 本机 Rabi + 真实 Codex 双向队列和配置回滚报告；报告绑定发布版本、AIX SHA256、实现摘要与生成时间，过期或不匹配时只作历史记录。
- `dist/config-rollback-e2e.json`：独立配置写入、读回和精确回滚报告。
- `dist/craft-render-acceptance.json`：历史 AIX 的 Craft 模式/ASR 像素采样；其 VERSION/SHA256 与当前 1.0.23 不同，当前包上传后必须重做，不能作为本次云端证据。
- `dist/craft-upload-status.json`：云端上传、工具 Schema 和版本可见性。
- `dist/craft-review-status.json`：云端绑定、提审按钮和未提交状态。
- `dist/goal-evidence.json`：完整目标的已证明项与外部状态缺口。
- `dist/ink-runtime-smoke.png`：沉浸式连接对话 HUD。
- `dist/ink-runtime-tools-page-1-charging.png`：配置助手与充电状态 HUD。
- `dist/ink-runtime-compact-smoke.png`：非沉浸式连接对话卡片。
- `dist/ink-runtime-compact-configuration-charging-smoke.png`：非沉浸式配置助手与充电状态卡片。

## 设备回来后的最终验收

1. 手机和眼镜可用后，把本地 `RabiLink 1.0.23` AIX 上传到 Craft；上传和提审都需要账号所有者明确授权。
2. 审核通过后，在 Rokid AI App 智能体商店添加/更新 RabiLink，并确认智能体管理中可见。
3. 手机连接眼镜，启动 RabiLink AIUI，并先确认电量左侧显示 `v1.0.23`；不要用 ADB 把 `.aix` 当 APK 安装。
4. 真实触摸板后滑到配置助手、前滑回连接对话。
5. 连续说话验证真实 ASR 与普通回复 TTS；断开或隐藏页面后从 PC 主动投递两条无任务提醒，再恢复连接对话，确认两条都按顺序播报且中途再次隐藏仍可续播。
6. 在配置助手连续说“帮我看看现在用的配置”和“把路由信息读给我”，确认原生模型理解、白名单动作或澄清、TTS watchdog 和下一轮 ASR 顺序完成；故意等待一次完整播报后确认不会停在“正在播报”。再让外层 Agent 以 `intent=读取配置` 调起，核对严格入口仍可用。
7. 核对左下时间、右下眼镜电量和充电状态。
8. 运行 `npm run runtime:proof`，再运行 `npm run goal:evidence`；只有 runtime proof 和所有外部阶段都通过，才把总目标标记为完成。
