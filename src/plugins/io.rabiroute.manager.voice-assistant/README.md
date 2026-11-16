# 语音助手

Rabi PC 左侧「语音助手」，路径 `/voice-assistant`。插件自己拥有模型会话，不要求先启动 Codex、DSH 或角色路由。模型、语音和设置界面复用网页助手的公共实现；优先使用本机 WorkBuddy 官方国内登录。

识别示例使用随包附带的 Microsoft MIT 许可中文短句“今天天气怎么样？”，不依赖系统语音、PowerShell、Azure SDK 或运行时下载。来源、固定哈希及完整许可见 [诊断资源](../../../apps/desktop-assistant/assets/diagnostics/README.md)，并随插件的 `diagnostic-assets` 分发。示例使用当前选择的 ASR，模型需要支持中文；示例失败时仍独立测试对话模型与播报，语音链路保持未测试。正常麦克风识别不依赖该样本。

## 归属和持久化

插件通过公开 `ownAgentAdapter` 注册 `voice-assistant`，Web 页面和 Agent 投递使用同一会话。插件拥有模型客户端、唯一录音/播放器、设置、加密凭据与聊天上下文。宿主提供当前 Manager 身份、人格目录、既有语音服务和公开工具。停用释放资源与注册；工具拥有者已接纳的任务保留原收据，不自动重派。退出助手不退出 Rabi PC。

每个人格的聊天历史与模型上下文分别加密保存在宿主状态目录 `data/voice-assistant/sessions`。切换前结束语音，正在处理的模型任务完成后才能切换。切回原人格恢复原历史；刷新和重启不清除记录。人格正文来自完整公开文档，原人格及角色路由配置不被改写。

## 语音与桌宠

ASR、TTS 分别选择「本机服务」或「自定义」，允许混用。本机服务复用 `manager.speech@1` 当前服务和人格声线，TTS 只合成（`play:false`），由同一共享设备播放。自定义服务沿用共享提供商、模型、能力和私有凭据设置。没有本机声线的人格仍可文字聊天和使用自定义播报。

`apps/desktop-assistant/src/runtime.mjs` 负责共享装配，`packages/assistant-runtime` 负责模型工具循环与模拟双工，`packages/desktop-voice-service` 负责协议、真实播放和字幕。识别到首个有效文字才打断播报，模型与工具继续。流式 ASR 显示临时文字，整段识别显示波形。

桌宠订阅插件呈现事件，按人格、插件 owner、response/playback 和单调 revision 显示真实状态，不再次录音、合成或播放。ASR 与完成的 TTS 段通过原 transcript 接口保存。

## 工具和 Agent

复用统一 OperationSdk 与通用工具适配器：分类、分页、搜索、输入/结果 schema、调用及原生流会话。不维护固定业务 API 名单，新增公开插件操作进入当前目录。远端电脑由 RabiLink 原有连接与授权决定，工具保留原目标、generation、权限、幂等键与不确定结果。

公开可选能力 `nativeThreadOperations` 把线程请求交回相应 provider 的 `threads.request`，不回落到 Codex。此插件允许列出、读取、定位自己的会话；投递走原 Manager service endpoint 和持久化接纳收据。

## 构建和验收

完整仓库构建先在根目录运行 `npm ci`，再运行 `npm run build`。仓库不是 npm workspaces；Web 构建所需 React、React DOM 与 Vue/Vite 一样由根 `devDependencies` 和根锁文件提供，版本与本插件声明一致。插件自己的 `dependencies` 保留独立包依赖归属，不能用已存在的本机 `node_modules` 代替根锁文件安装验证。

沿仓库官方插件/Web 流程构建 `1.1.9` 候选。包内带共享模块闭包、设备脚本和 `koffi/ws`。WorkBuddy/Electron 启动路径只在本机私有 host-options 配置，不进入公开源码，不复制官方令牌，不依赖独立测试服务或固定端口。

`runtime.test.mjs` 覆盖持久化、人格、Agent 归属和工具回执；`voice-sources.test.mjs` 通过受控设备执行四组合 ASR→自动提交→模型→TTS→唯一播放器→资源释放。夹具不等同真实麦克风、扬声器、回声、远端电脑或安装版验收。正式安装切换沿原发布 owner，活动状态未知时不能重启共享 Host。
