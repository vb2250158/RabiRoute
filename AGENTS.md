# RabiRoute 协作入口

RabiRoute 是消息网关和 Policy Router，负责消息接入、事件记录、路由、上下文模板、处理端投递、审批及回传。处理端负责回答、编码、工具与业务执行。

## 设计与执行

- 按 [Agent 接入规范](docs/agent-adapter-standard-requirements.md) 划分功能：共用业务、策略和状态由 Rabi 提供；宿主补充内部事件、权限执行和界面能力。
- 本机 Codex 正文投给 Desktop IPC 的目标 task owner；元数据操作可使用项目锁定的 app-server。owner 待就绪时恢复原 owner，再继续原任务。
- 已配置且鉴权的连接及资源默认可用。限制采用用户可查看、修改和取消的配置；命中配置时说明字段、范围和修改入口。旧默认值按来源核实。
- 用户已有指示沿原任务延续，必要调查、实施与验证直接执行。复用条件一致的上游校验，局部故障在所属边界处理。
- 按 [主动智能设计](主动智能设计思路.md) 理解目标、补齐信息、判断行动、验证跟进并吸收纠正。人格按关系与情境自然表达。
- 提示词使用简短的正向行动句，合并重复规则。修改冲突规则时同步实际加载版本。

## 阅读与文档

- 按任务查看 README.md、docs/README.md、docs/project-function-map.md、docs/code-architecture.md 和相关专题。
- 行为、配置、启动、架构、示例或排障方式变化时，同步相应 README、docs、examples、skills 与版本更新日志。
- 用户文档维护中文与英文版本，顶部提供语言跳转，校准事实后同步译文。Agent 指令、persona、prompt、memory 和 plan 按真实加载语言维护。
- README 说明定位、用途、首次成功路径、成熟度与进阶入口；getting-started 提供操作步骤；current-capabilities 记录验收；architecture 解释机制；docs/README 提供分层索引。
- 用户入口写用户目的、可见结果与操作，开发接口和维护元数据放对应分组。压缩时保留事实的权威位置与可达链接。
- 使用“聊天记录”“发送规则”等自然表达；技术词在帮助用户判断时就地解释。保留头图、Slogan 和产品叙事。

## 动态 Manager 与任务恢复

所有新增或修改的 Skill、工作流和脚本，访问 Manager 时使用下列动态发现与身份核对流程。

- 知识查询先读 `skills/rabi-knowledge-search/SKILL.md`，在线查计划与记忆，接口故障时按实际来源继续文件查询。
- 运行 `node scripts/resolve-manager.mjs`；其他工作区使用已配置源码根的绝对路径。取得 managerBaseUrl、applicationGenerationId、managerInstanceId，通过 `GET /meta`（`<managerBaseUrl>/meta`）核对当前身份。源码模式使用结构化 READY 地址，测试可显式注入 URL。
- 普通业务请求核对 health.live=true，接受 `healthy`、`degraded`；health.requiredReady 表示声明能力是否齐备，缺项由目标接口判断，不阻断无依赖功能。`/meta` 诊断只核对身份；写后按身份与原回执判断状态，待确认结果标记 uncertain 并查询原请求。
- 安装版使用 `RabiRouteHost.exe --command status --json`；Manager 地址始终由当前发现结果提供。Host status 空输出时使用解析器复核。身份变化后重新发现，应用生命周期由 Host 管理。
- 投递与回传先读 `docs/rabi-agent-interfaces.md`。目标接口故障时按原 ID 核对执行阶段，再使用原授权、同一目标的现有恢复入口。
- Rabi 故障按 `docs/rabi-maintenance.md` 交给长期维护计划的原 taskBinding；已有 Bug 沿原任务续接。
- 修改动态连接相关入口后运行 `node --test scripts/dynamic-manager-active-truth.test.mjs`。

## 开发、构建与运行

- Agent 适配器改动先读 `skills/create-rabiroute-agent-adapter/SKILL.md`；Rokid/CXR 改动先读 `skills/rokid-development/SKILL.md`，采用项目当前 CXR 技术路线。
- 新平台适配放 src/adapters；路由、模板和投递在 src/forwarding.ts；管理 API 与生命周期在 src/manager.ts。router 与处理端通过稳定接口协作。
- 公共实现采用通用配置、契约与插件。私有业务、凭据和运行数据保存在经 git check-ignore 与跟踪状态确认的本地私有位置；公开代码、示例、日志和产物使用通用标识与脱敏值。
- 功能改动运行匹配测试与 `npm run build`。Manager、WebGUI、插件及启动链先读 `skills/source-hot-patch-development/SKILL.md`，按支持矩阵使用原生热补丁；需要生命周期切换时交给 Host。
- 回读健康与目标行为。热补丁核对同一 Manager/PID 的代码版本和候选 hash，切换核对新 generation；页面核对根 HTML 及实际资源 hash。
- 清理本次调用链的过期代码、配置、路由和资源。确需兼容时记录用户、迁移路径、退出条件及验证。

## 目录与交付

- examples/data 保存可公开复制的配置与角色，examples/roles 保存人格示例，使用占位值、localhost 与模板变量。
- apps 保存独立客户端；packages 保存共享 SDK 和稳定契约；skills 保存复用流程。
- .env、data、dist、logs、node_modules 按运行期及本地文件管理。提交范围采用本次授权的源码与文档。
- 交付说明实际改动、匹配验证和运行证据；文档已满足当前行为时简述检查结果。
