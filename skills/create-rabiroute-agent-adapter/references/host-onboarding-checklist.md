[English](host-onboarding-checklist_en.md) | 简体中文

# Agent 宿主接入检查清单

本页是维护者核验清单，不是宿主当前版本已通过验收的证明。先加载 [统一接入技能](../SKILL.md)，再按当前宿主文档、实际源码和隔离夹具核对。能力和会话真源由宿主拥有；Rabi 维护配置、路由、绑定及正式投递合同。

## 1. 先探测，后声明

- 先检查宿主 CLI 帮助与正式程序化接口，不先选 CDP、逆向或模拟 UI。读取帮助不授权执行其中的创建、投递或修改命令。
- 核对 Hook 事件、输入 JSON（会话 ID、cwd、工具名等）、输出结构、matcher 适用事件和加载时机。生命周期事件不可套用仅工具事件支持的 matcher。
- 从当前进程或受管配置解析实际 Home、插件根和环境变量名；不从宿主名字推断，也不沿用另一台机器的目录。
- 只有获得最小实验授权后才安装临时探针。改配置前备份，只记录必要的非敏感字段，试验后恢复；不得记录凭据或完整私人 prompt。
- 记录宿主版本和验证证据。没有安装项不能证明 Hook 不存在，配置已写入也不能证明 Hook 执行成功。

## 2. 会话与投递身份

- 找到正式 session 数据库或描述文件；用户命名和自动标题分别处理。按名称定位时采用宿主合同允许的字段，名称 + ID 一起展示。
- 正式消息必须走同一条、能够精确指定既有会话 ID 的受管路径。参数明确不等于绝无误投风险：仍需核对 owner、工作目录及回执。
- 不同入口可能将输入标记为 `SYSTEM`、`USER_EXPLICIT` 或其它来源。只能按实际 transcript 说明来源，不把系统注入说成人类输入。
- 需要活跃 owner 的宿主，按现有合同同时检查进程、心跳、已发布端点和会话类型；未发布端点或预热进程不可冒充可投递会话。
- Desktop 是真实消息 owner 时，未加载或不可达须失败关闭。不得改投备用 Runtime、当前 UI 会话，或为了绕过失败自动启动 CDP。
- 只在有受管发现合同的情况下获取端点和凭据；不扫描端口猜测服务、不向未经信任确认的新地址转发凭据。
- 凭据只保存在受保护、未跟踪的本机状态中，不写入日志或源码。回执不确定时先权威回读，不自动重发。

## 3. 实现落点

1. `src/shared/agentAdapterCapabilities.ts`：声明类型、manifest、成熟度和已验证能力；一次 HTTP 成功不是 `deliveryReceiptRecovery` 的充分证据。
2. `src/shared/gatewayConfigModel.ts`、`src/config.ts`：定义绑定字段、归一化和环境配置；端点接受范围遵守现行信任合同。
3. `src/<agent>SessionStore.ts`：读取宿主真源；Windows 路径按平台语义比较，过滤必须在分页前。
4. `src/<agent>SessionBridge.ts`：唯一真实投递路径；区分明确拒绝、未送达与结果未知。
5. `src/agentAdapters/builtinAgentAdapters.ts`、`<agent>ManagerApi.ts`：注册扫描和诊断，分别展示安装、凭据、端点、项目、会话状态。
6. `src/shared/agentInstance.ts`：使用类型与能力查询，避免手写适配器白名单或 A/B 二元回退。
7. `plugins/rabi-<agent>-context/` 与 `src/agentAdapters/hookInstallation.ts`：Hook 声明保持唯一来源。配置合并仅替换自身指纹条目，保留其他键和 Hook，非法配置拒绝写入，重复执行幂等。
8. WebGUI：核对 `RouteConfigPage.vue`、`QuickSetupDialog.vue`、相关 store/types 及 manifest 导出；不能只改一个面板。显示名来自能力定义，不能默认回退成另一宿主。
9. `ribiwebgui/src/i18n/catalog.ts`：同步中文 key 与英文文案，先查重。
10. 中英接入文档、能力说明与版本日志：只写已经实现并被相应证据支持的能力。

## 4. Hook 排障与验收

- 查受管日志区分「未执行」「已执行无上下文」「Manager 不可达」；诊断应有事件、结果、耗时及受限的身份线索，不记录秘密或完整消息。
- 安装器和夹具应共用明确的自检输出合同。非空字符串可能只是 fail-open 错误说明，不能用 `Boolean(output)` 判定连通；采用当前实现的结构化 verdict 或准确成功标记。
- 区分宿主插件安装与用户配置安装。WorkBuddy 等宿主可能在会话进程启动时加载配置，必须按当前实现列出需重开的具体任务，不默认重启整个 Desktop。
- Manager 通过 Host 的 `managerBaseUrl`、`applicationGenerationId`、`managerInstanceId` 或源码 READY 动态发现，再核 `/meta`。普通调用接受 `healthy` 或 `degraded`，要求 `health.live=true`、`health.requiredReady=true`，具体依赖由接口决定。身份不符重新发现，禁止凭固定端口判断。
- 真实投递只有在明确授权时验收：目标会话出现预期来源的输入及同会话回复，并确认没有额外创建任务。若宿主提供终态回执，优先按其权威合同核对。不能用“没有新任务”判失败。
- 报告配置路径、事件列表、脚本位置、自检结果、需重开的会话与未验证项；安装完成、配置加载和真实交互验收分开报告。

## 5. 隔离测试

测试必须显式隔离宿主 Home、数据库、会话描述符、凭据与日志。WorkBuddy 夹具按实现设置 `RABI_WORKBUDDY_HOME` 等入口，不能读运行者的真实会话。覆盖无端点、过期 owner、错误 cwd、同名会话、权限拒绝、非零退出伴结构化错误、未知回执、Hook fail-open 和幂等安装。后端及前端类型检查、受影响回归与构建分别记录；headless 结果不替代真实交互会话验收。

## 参考

- [统一接入要求](../../../docs/agent-adapter-standard-requirements.md)
- [接入经验](../../../docs/agent-adapter-integration-lessons.md)
- 仓库内 `rabi-codex-context`、`rabi-workbuddy-context` 等当前实现可作对照，不把某台机器的历史探测输出当跨版本合同。
