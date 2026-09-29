<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI - Rokid AR 眼镜智能体与灵珠协同框架

RabiLink AIUI 将语音识别、宿主模型、语音播报和透明 HUD 放在同一个眼镜应用页面中，用于随身对话、查看结果和受控配置。应用不绑定特定预设角色。默认由 **AIUI 宿主 `LanguageModel`** 处理对话，PC 通过受控 HTTP 提供工具，不替代眼镜应用的模型。

> **成熟度**：手机设备配置与知识工具接入正在实施和验收中。源码、模拟测试或本机构建不代表已安装或通过真机验收；不承诺任意灵珠平台 Agent 绑定、物理离线推理或完整自动多步工具循环。

---

## 当前实现与边界

- 默认运行方式为 `local-aiui`。领取设备凭据、连接 Relay 或 PC，不会自动切换模型执行归属。
- “本地”表示由 AIUI 页面调用宿主模型，并不保证推理物理运行在眼镜上或可以断网使用。当前调用 `LanguageModel.create(options)`，会检查模型可用性并拒绝已知离线状态。
- 口语“设置／绑定智能体”仅修改**本地显示名称**，不绑定灵珠平台 Agent。`agentId` 不是已验证的平台调用路由。名称变更先保存完整 `{id,name,prompt}`；保存失败保留当前名称和模型，晚返回的旧模型不会替换新会话。
- 手机设备 profile 可设置名称、系统提示、Skill 指引和 MCP 服务引用。已保存、模型已应用、工具已连接是不同状态；执行接线和端到端验收仍在进行。设备 profile 生效后，由手机管理名称，不再通过口语另写一份配置。
- 官方工具文档支持函数声明与 `toolcall` 事件，但尚无已证实的工具结果回传续轮接口。不能用普通 prompt 文本冒充工具响应，或据此承诺完整 Agent 闭环。

## 核心设计理念

1. **统一页面与明确执行归属**：
   - 对话、状态和配置入口位于同一页面。保留历史 `mode=transcription` / `configuration` 页面操作状态，不把它们当成模型执行者选择。
   - 日常对话由宿主模型处理；配置动作受白名单约束，不能把配置命令数量当作通用 Agent 工具数量。
2. **可配置而不硬编码人格**：
   - 启动参数可提供 `agentId`、`agentName`、`systemPrompt`；名称和提示用于本地页面配置，不保证调用对应平台 Agent。
   - 手机设备 profile 提供版本化设置；Skill 是受限指引，MCP 引用不是连接、授权或实际调用成功的证明。
   - 顶部 HUD 展示当前配置名称与“思考中”“回复中”“就绪”等状态。
3. **不要求 Rabi Token 的基本对话路径**：
   - 基本宿主对话不要求配置 Rabi Token 或保持 PC 在线，但仍依赖设备宿主提供可用的 ASR、模型和 TTS，以及它们所需的网络与权限。
   - `SpeechRecognition` → `LanguageModel.create(options)` → `speechSynthesis`；模型不可用时显示错误或提供有界保底提示，不把保底文本当作模型成功结果。
4. **语音打断与回声抑制**：
   - TTS 开始前释放 ASR 麦克风占用，播报结束后受控恢复监听。
   - 过滤自身 TTS 回声和快速重复 ASR，处理新的用户语音打断。实际噪声环境中的识别与打断效果仍需真机验证。
5. **AR 极简透明 HUD**：
   - 使用绿色高对比度字幕、顶部名称/状态/时钟/电量，尽量保留中央视野。
   - 单触用于打断播报，显式旧远端模式下可请求审阅；双触返回或退出。不同尺寸下的可读性以布局与设备验收为准。

---

## 运行架构与兼容路径

```text
RabiLink AIUI：同一页面，默认 local-aiui
  用户语音 → 原生 ASR → AIUI 宿主 LanguageModel → 原生 TTS / HUD
                          ↑
  手机设备 profile → 校验与保存 → 当前轮结束后、下一轮应用
  （名称 / 系统提示 / Skill 指引 / MCP 引用）

  AIUI → 受控 HTTP → RabiPC 工具 → 真实工具结果
  （接线与验收中；不等于已验证模型工具结果续轮）

仅显式 agentRuntimeMode=legacy-remote-observer：
  ASR → 旧远端观察队列 / 审阅 → 远端回复队列 → TTS / HUD
  与本地模型投递互斥；仅有 Token 不启用此路径
```

### 1. 默认宿主模型对话

适用于宿主能力可用时的随身对话，不承诺无网络使用。

```text
用户说话
→ AIUI SpeechRecognition 采集
→ 回声与重复过滤，必要时打断正在进行的播报
→ LanguageModel.create(options)，通过 promptStreaming() 或 prompt() 生成
→ 分句交付 speechSynthesis，并在 HUD 显示
→ 播报收尾后受控恢复 ASR
```

默认模式不发送旧远端语音推理队列、不启动旧回复长等待、不调用远端审阅或播报旧远端回复，避免双投与双回复。旧记录保留，不自动删除；设备状态、配置读取和日志沿各自合同运行。

### 2. 显式旧远端观察模式

仅为既有消息端调用者迁移保留：启动参数必须显式设置 `agentRuntimeMode=legacy-remote-observer`，并具有有效远端凭据。缺凭据时显示未连接，不静默切换到另一执行者。此模式不同时调用本地模型。

```text
上行：ASR 观察 + clientMessageId → POST /rokid/rabilink/input
     → 远端会话记录 → 远端 Agent 审阅
下行：远端回复 / 通知 → 持久下行队列
     → /rokid/rabilink/messages?stream=1 受控前台长等待
     → 本地持久队列 → TTS
```

该模式不意味着可自动绑定任意云端智能体。旧调用者迁移及旧队列经确认处理完毕后，才可移除兼容入口。详见[模型执行归属](docs/agent-runtime-mode.md)。

---

## 如何配置眼镜 Agent

### 方式 1：手机设备设置

在 Relay 管理页中选择所属应用和绑定眼镜，打开“Agent 设置”，编辑名称、系统提示、Skill 指引与 MCP 引用。设备使用自身凭据读取 profile，当前对话期间只暂存，保存成功后在下一轮重建模型。

请分别核对“已保存”和“眼镜已应用”。MCP 引用未连接时不能显示工具已可用；当前接线和真机验收仍在进行。手机 profile 生效后，口语改名会提示回手机管理。详见[设备配置 HTTP 与手机设置](../../docs/aiui-agent-profile-http.md)及[配置应用生命周期](docs/agent-profile-runtime.md)。

### 方式 2：本地显示名称的口语设置

未启用设备 profile 时，可说“设置灵珠智能体为 星河”或“切换灵珠智能体为 助手”。这只改显示名称，不切换平台 Agent，也不自动改写系统提示。只有完整保存成功后才更新 HUD 并播报确认；失败保留原设置。

### 方式 3：启动参数

在 AIUI Studio 或支持页面调用的入口中传入：

```json
{
  "agentId": "local-assistant",
  "agentName": "自定义智能体名称",
  "systemPrompt": "你是一个幽默风趣的科技助手，回答简洁聚焦。"
}
```

`agentId` 是本地配置标识，不是平台绑定凭据。旧本地配置和启动参数保留兼容，已应用的设备 profile 优先。当前 `app.json` 的 Relay 设置不等于一个已实现的默认平台 Agent 配置入口。

---

## 官方 API 契约与参考文档

- **语音识别 (ASR)**：[SpeechRecognition API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=0.18.0)
  - 前台单轮状态机与受控续轮；启动前检查可交互状态，TTS 开始前中止 ASR。
- **语音合成 (TTS)**：[speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
  - 使用 `speak(utterance, "enqueue")`，结合 `onend/onerror` 和基于文本长度的有界超时管理生命周期。
- **宿主模型**：[LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
  - 使用 `LanguageModel.create(options)` 传入初始提示及工具声明，不是零参数契约。
  - 使用 `promptStreaming()` 或 `prompt()`；同一会话同时只运行一个活跃请求。
  - `toolcall` 可提供结构化调用事件；结果回传续轮仍未证实，详见[工具合同核对](docs/agent-tool-contract.md)。

## HUD 视觉与交互

- 顶部显示配置名称、状态、时钟与电量；底部显示主字幕和配置状态，尽量不遮挡中央真实视野。
- 字幕采用绿色高对比度设计；实际字号、边缘安全和小尺寸布局以当前实现及验收为准，不承诺所有光照下可读。
- **单触（Tap / Enter）**：打断播报；显式旧远端模式空闲时可请求审阅。
- **双触（Double Tap）**：返回上一级或退出。

---

## 本地检查、构建与部署

以下命令在**本机磁盘的完整源码快照**中运行，不从 NAS 构建或启动。测试、打包、上传、安装和真机运行是不同验收阶段。

### 1. 本地代码检查与烟测

`npm run check:agent` 固定运行九项 Agent 回归脚本与接口、配置、设备状态合同负向测试。`npm run check` 先运行该入口，再运行原有完整跨应用审计链，不跳过缺失依赖或失败。真实 Ink 渲染、长文本压力和真机验收分别报告。
```powershell
# 运行完整静态与动态契约检查
node .\scripts\check-rabilink-aiui.mjs

# 运行语音运行时与打断机制烟测
node .\scripts\Smoke-RabiLinkVoiceRuntime.mjs

# 运行启动安全与防崩溃测试
node .\scripts\Smoke-RabiLinkAiuiStartupSafety.mjs

# 运行全指令集运行时模拟测试
node .\scripts\Smoke-RabiLinkAiuiRuntime.mjs
```

### 2. 准备上传至 Rokid AIUI Studio (Craft)
```powershell
# 生成自包含上传暂存目录 dist/craft-upload (不自增版本号)
pwsh -NoProfile -ExecutionPolicy Bypass -File .\scripts\Prepare-RabiLinkAiuiCraftUpload.ps1 -NoBump

# 生成本地 AIX 打包文件
npm run package:aix
```

按打包脚本要求提供有效 Relay 配置；示例地址测试包不代表可用于实际设备连接。

### 3. 上传与真机同步
1. 打开 [Rokid AIUI Studio (Craft)](https://aiui.rokid.com)；
2. 选择“导入本地文件夹”，指向生成的 `apps/rabilink-aiui/dist/craft-upload` 目录；
3. 检查 Studio 预览，再按平台当前流程执行真机调试或发布提审；
4. 若平台审核、账号及设备条件均满足，在 Rokid 手机 App 智能体中心添加并同步到眼镜，分别核对同步与实际启动结果。

这些是操作步骤，不是本次上传、安装或验收已经完成的证明。
