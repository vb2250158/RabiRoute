<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI - Rokid AR 眼镜智能体与灵珠协同框架

RabiLink AIUI 将语音识别、宿主模型、语音播报和透明 HUD 放在同一个眼镜应用页面中，用于随身对话、查看结果和受控配置。应用不绑定特定预设角色。默认由 **AIUI 宿主 `LanguageModel`** 处理对话，PC 通过受控 HTTP 提供工具，不替代眼镜应用的模型。

> **成熟度**：手机角色绑定、通用 HTTP 接口、聊天记录与语音引导已接入源码，安装与硬件验收未完成。源码、模拟测试或本机构建不代表已安装或通过真机验收；应用多步循环已有源码与夹具证据，完整路由及真实宿主验收仍待完成；不承诺任意灵珠平台 Agent 绑定或物理离线推理。

模型请求与页面交互分开：一个任务在同一模型会话中串行推理，实际工具结果作为应用观察交回模型，再决定下一步。触摸打断会停止当前模型并屏蔽迟到结果，工具超时不自动重发。高级设置同时保留角色来源电脑 ID，避免保存远端角色配置时遗漏来源。通用调用、实际连接路径和 QuickJS 的能力限制见[接口传输](docs/generic-api-transport.md)。详见[对话运行层](docs/agent-turn-runtime.md)与[角色、通用接口及语音引导](docs/persona-agent.md)。


---

## 当前实现与边界

打包时，启动脚本与页面版本统一取自 `craft-release.json`；归档校验检查两者一致。原生 ASR 创建失败或返回错误时，模拟器日志会保留脱敏后的原因，供区分应用错误与宿主能力问题。

- 默认运行方式为 `local-aiui`。领取设备凭据、连接 Relay 或 PC，不会自动切换模型执行归属。
- “本地”表示由 AIUI 页面调用宿主模型，并不保证推理物理运行在眼镜上或可以断网使用。当前调用 `LanguageModel.create(options)`，会检查模型可用性并拒绝已知离线状态。
- 口语“设置／绑定智能体”仅修改**本地显示名称**，不绑定灵珠平台 Agent。`agentId` 不是已验证的平台调用路由。名称变更先保存完整 `{id,name,prompt}`；保存失败保留当前名称和模型，晚返回的旧模型不会替换新会话。
- 手机设备 profile 可设置名称、系统提示、Skill 指引和 MCP 服务引用。已保存、模型已应用、工具已连接是不同状态；执行接线和端到端验收仍在进行。设备 profile 生效后，由手机管理名称，不再通过口语另写一份配置。
- 默认模型使用应用动作协议与明确的结果观察续推理，原生工具声明为空；不声称提供原生 `tool` role 或结果提交 API。真实宿主及路由验收待完成。

## 核心设计理念

1. **统一页面与明确执行归属**：
   - 对话、状态和配置入口位于同一页面。保留历史 `mode=transcription` / `configuration` 页面操作状态，不把它们当成模型执行者选择。
   - 日常对话由宿主模型处理；配置动作受白名单约束，不能把配置命令数量当作通用 Agent 工具数量。
2. **可配置而不硬编码角色**：
   - 启动参数可提供 `agentId`、`agentName`、`systemPrompt`；名称和提示用于本地页面配置，不保证调用对应平台 Agent。
   - 手机设备 profile 提供版本化设置；Skill 是受限指引，MCP 引用不是连接、授权或实际调用成功的证明。
   - 顶部 HUD 展示当前配置名称与“思考中”“回复中”“就绪”等状态。
3. **不要求 Rabi Token 的基本对话路径**：
   - 基本宿主对话不要求配置 Rabi Token 或保持 PC 在线，但仍依赖设备宿主提供可用的 ASR、模型和 TTS，以及它们所需的网络与权限。
   - `SpeechRecognition` → `LanguageModel.create(options)` → `speechSynthesis`；模型不可用时显示错误或提供有界保底提示，不把保底文本当作模型成功结果。
4. **语音打断与回声抑制**：
   - 日常对话在 TTS 和推理时继续 ASR；非回声文字只停播，完整输入在当前请求结束后引导下一步。
   - 过滤自身 TTS 回声和快速重复 ASR，处理新的用户语音打断。实际噪声环境中的识别与打断效果仍需真机验证。
5. **AR 极简透明 HUD**：
   - 使用绿色高对比度字幕、顶部名称/状态/时钟/电量，尽量保留中央视野。
   - 单触可打断当前对话与播报；双触返回或退出。不同尺寸下的可读性以布局与设备验收为准。

---

## 运行架构

```text
RabiLink AIUI：同一页面，默认 local-aiui
  用户语音 → 原生 ASR → AIUI 宿主 LanguageModel → 原生 TTS / HUD
                          ↑
  手机设备 profile → 校验与保存 → 当前轮结束后、下一轮应用
  （名称 / 系统提示 / Skill 指引 / MCP 引用）

  AIUI → 受控 HTTP → RabiPC 工具 → 真实工具结果
  （实际结果返回同一宿主模型继续决策；真机待验收）

```

### 1. 默认宿主模型对话

适用于宿主能力可用时的随身对话，不承诺无网络使用。

```text
用户说话
→ AIUI SpeechRecognition 采集
→ 回声与重复过滤，必要时打断正在进行的播报
→ LanguageModel.create(options)，通过 promptStreaming() 或 prompt() 生成
→ 分句交付 speechSynthesis，并在 HUD 显示
→ 推理和播报期间保留 ASR，完整输入在步骤之间引导
```

### 2. 正式设备 Agent

PC 的消息路线可选择 `deviceAgent`，眼镜加载原生模型后登记名称、稳定 ID 和会话，领取并执行原消息。手机只转发唤醒 nonce；系统广播拒绝时原消息仍排队，不记录执行完成。自动唤醒和真机执行尚未验收。详见[设备 Agent](docs/device-agent.md)。

---

## 如何配置眼镜 Agent

### 方式 1：手机设备设置

在手机打开 **全天记录 → 设备 → 眼镜 → 眼镜设置**，选择当前使用的角色及其来源电脑，可预载 Skill。配置保存在眼镜连接登记的 PC；该配置可引用其他同应用 PC 的角色。设备经通用 HTTP 传输读取 PC 配置，当前轮及引导结束后再切换。服务器只维护连接、鉴权与中转，不保存角色业务配置。

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
  - 每次 `SpeechRecognition.start()` 必须在用户交互中调用。手势处理函数同步启动同一个 `continuous` 识别对象，推理及 TTS 期间保持监听，按 `resultIndex` 交付新的最终句段。识别结束或失败后等待再次点击或唤醒，不用定时器新建识别轮次。宿主是否提供中间结果及实际双向音频效果需单独验收。
- **语音合成 (TTS)**：[speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
  - 对话仅使用 `synthesize()` 和独立 `SpeechAudioPlayer`。非回声识别文字停止实际播放器、取消旧任务并丢弃迟到结果；缺少该能力或合成失败时明确显示 TTS 不可用或播放失败。不会回退到无法取消的共享 `speak()`；官方未暴露共享播放器的 `cancel()` 或 utterance 结束事件。
- **宿主模型**：[LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
  - 应用使用 `LanguageModel.create(options)` 传入初始提示；官方也允许省略选项并使用宿主默认模型。
  - 使用 `promptStreaming()` 或 `prompt()`；同一会话同时只运行一个活跃请求。
  - `toolcall` 可提供结构化调用事件；结果回传续轮仍未证实，详见[工具合同核对](docs/agent-tool-contract.md)。

## HUD 视觉与交互

- 顶部显示配置名称、状态、时钟与电量；底部显示主字幕和配置状态，尽量不遮挡中央真实视野。
- 字幕采用绿色高对比度设计；实际字号、边缘安全和小尺寸布局以当前实现及验收为准，不承诺所有光照下可读。
- **单触（Tap / Enter）**：对话或播报进行中可打断当前对话；空闲时启动设备 Agent 接收，转写暂停时单触恢复聆听。
- **双触（Double Tap）**：返回上一级或退出。

---

## 本地检查、构建与部署

以下命令在**本机磁盘的完整源码快照**中运行，不从 NAS 构建或启动。测试、打包、上传、安装和真机运行是不同验收阶段。

### 1. 本地代码检查与烟测

`npm run check:agent` 固定运行十一项 Agent 回归脚本，以及手机桥接、设备 Agent、接口、配置和设备状态合同测试。`npm run check` 先运行该入口，再运行原有完整跨应用审计链，不跳过缺失依赖或失败。真实 Ink 渲染、长文本压力和真机验收分别报告。
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
