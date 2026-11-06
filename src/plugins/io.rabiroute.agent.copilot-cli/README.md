简体中文 | [English](./README_en.md)

# Copilot CLI

本包拥有此 Agent 的配置卡片、扫描、会话操作和投递实现。Manager 与 Gateway 使用同一原生插件 profile；停用后拒绝新工作，已受理操作沿原租约完成，保留原会话与外部执行 owner。能力及成熟度由包内 agent-adapter.json 声明。

Web 入口在 manifest 中直接声明 `entries.web.module: "./web/client.mjs"`。完整 Web 构建生成该文件，将 `activate` 直接导出到本包独立的 `/assets/…` 模块；发布器据此将卡片资源固定到同一 Web 版本。无需额外的 `web.mjs` 转发文件。

Windows 的 `.cmd` / `.bat` 启动入口使用固定的英文取件指令；原始消息保存在本次投递原有的私有 UTF-8 提示词文件中，文件路径仅通过该子进程的 `RABIROUTE_COPILOT_PROMPT_FILE` 环境变量传入。Copilot 读取该文件执行原任务；消息中的引号、换行或命令符号不交给 cmd 解释。原生可执行文件继续接收独立参数。`COPILOT_CLI_ARGS`、工作目录和会话配置仍由用户管理；显式省略 `{prompt}` 的自定义参数保留 stdin 模式，脚本入口的 stdin 同样只接收固定取件指令。

配置切换、共享任务依赖和接入要求见 [Agent 接入规范](../../../../docs/agent-adapter-standard-requirements.md)，插件生命周期见 [SDK](../../../contracts/plugin-sdk/README.md)。
