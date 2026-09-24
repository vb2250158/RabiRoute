<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink AIUI - Rokid AR 眼镜通用端侧智能体与灵珠协同框架

> **最新架构规范**：RabiLink AIUI 采用**纯粹的单一 Agent 模式（Unified Agent Mode）**架构，彻底取消了过去在“连接对话”和“配置助手”之间割裂的双模式切换。它是一个**通用的眼镜端主控智能体（Universal On-Device Master Agent）**框架，与特定人格（包括夜雨）完全解耦，**支持设置与绑定任意灵珠智能体（Lingzhu Agent）**——用户想绑定什么智能体都行！

---

## 核心设计理念

1. **单一统一模式：Agent 模式（Unified Agent Mode）**：
   - **就一个模式**：打开应用就是纯粹的 AR 智能体交互界面，无需繁琐的双段滑轨或手动切换模式。
   - **全能对话与主控**：无论是日常闲聊、信息查询、设备调控还是设置灵珠智能体，均在单一 Agent 模式下直接通过自然语言沟通，由大模型理解并闭环执行。
2. **支持设置与绑定灵珠智能体（Lingzhu Agent Binding）**：
   - **与特定人格彻底解耦**：不再强绑定任何预设角色（如夜雨等）。用户想绑定什么智能体都行，全面融入 Rokid 灵珠智能体生态。
   - **3 种灵活设置途径**：
     1. **口语即时设置**：直接对眼镜说“设置灵珠智能体为 xxx”或“绑定智能体 xxx”，系统立即更新并持久化记忆；
     2. **页面启动参数注入**：支持通过 `agentId`、`agentName` 和 `systemPrompt` 参数动态指定要运行的灵珠智能体与人设风格；
     3. **配置文件预设**：在 `app.json` 中配置默认的灵珠智能体信息。
   - **动态 HUD 呈现**：顶部状态栏实时呈现当前绑定的灵珠智能体名称（如“灵珠智能体”、“星河”或用户自定义名称），状态胶囊跟随显示“思考中”、“回复中”与“就绪”。
3. **零 Token 开箱即用（Zero-Token Standalone Master Agent）**：
   - 戴上眼镜即可直接对话，**无需在手机或网页端配置 Token、无需手机扫码绑定、不依赖 PC 随时在线**。
   - 纯端侧原生闭环：原生 `SpeechRecognition`（语音采集） -> 系统级端侧原生大语言模型 `LanguageModel.create()`（零参数纯净契约，流式生成） -> 原生 `speechSynthesis`（甜美女声实时播报）。
   - 内置端侧保底应答机制（Fallback Responder），在端侧 SLM 唤醒延迟或异常时平滑兜底，杜绝卡死无声。
4. **真人语音智能打断与回声消除（Barge-in & Echo Suppression）**：
   - 严格管理麦克风占用：TTS 播报开始前主动释放 ASR 占用，播报结束后自动续轮。
   - 针对眼镜近耳扬声器特性，深度过滤自身 TTS 回声与毫秒级重复 ASR 噪音。
   - 只有通过真人口语判定的输入，才会立即打断（Barge-in）正在进行的 TTS 播报并无缝切入新一轮应答。
5. **AR 专属极简透明 HUD 规范**：
   - 专为 Rokid AR 光学穿透优化：
     - **底部 20px 大字号字幕**：高对比度复古绿（#00FF88 / #55FF99）半透明卡片，强光与室内均清晰可见。
     - **顶部极简状态胶囊**：包含绑定的灵珠智能体名称、状态 Pill、时钟与电量，中央现实视野 100% 保持通透。
     - **极简手势**：单触打断播报/审阅，双触返回/退出。

---

## 运行架构与双模态实现

整个应用统一为单一 Agent 模式，底层支持端侧独立运行与远端协同双模态：

```text
+-----------------------------------------------------------------------------------+
|                        RabiLink AIUI (单一 Agent 模式)                             |
|                                                                                   |
|  [ 本地主控 Agent 闭环 (零 Token) ]       [ 远端协同模式 (配置 Token / Relay) ]    |
|   - 完全离线 / 开箱即用                    - 上行: 观察账本追加 (Record-only)      |
|   - 原生 ASR -> 端侧 SLM -> 原生 TTS       - 下行: 持续游标流 (Cursor Stream)       |
|   - 智能打断 + 端侧保底应答                - 接收云端/PC 灵珠智能体主动关怀推送    |
|                                                                                   |
|  [ 灵珠智能体设置与控制 ]                                                          |
|   - 语音指令: “设置灵珠智能体为 xxx” / “绑定智能体 xxx”                            |
|   - 启动参数: agentId / agentName / systemPrompt                                  |
|   - 84 项白名单受控指令 / Toolcalls 快捷调控设备与远端系统                          |
+-----------------------------------------------------------------------------------+
```

### 1. 零 Token 端侧独立闭环链路
- **适用场景**：日常随身佩戴、外出无网、轻度对话或无需连接 PC 的独立使用场景。
- **工作流程**：
  ```text
  用户说话
  -> AIUI SpeechRecognition 连续自然语言采集
  -> 回声消除与重复过滤 (Suppress Echo & Rapid Duplicates)
  -> 若正在播报且检测到真人新发话: 触发打断 (Barge-in Interruption)
  -> 端侧原生 LanguageModel.create() (零参数纯净契约) 流式生成回复
     (若 SLM 初始化延迟或报错，自动启用内置兜底应答池)
  -> 命中分句断句后流式交付 AIUI 原生 speechSynthesis 播报
  -> 底部 20px 绿色 HUD 同步滚动呈现文字
  -> 播报收尾后自动恢复下一轮 ASR 监听
  ```

### 2. 远端协同模式（可选）
- **适用场景**：已配置 Token / 远端 Relay 服务，需要与桌面 PC（RabiRoute / Codex / 本地大模型）或云端灵珠智能体大脑深度协同。
- **工作流程**：
  ```text
  【上行队列 - 观察账本】
  眼镜端 ASR 观察 -> 附带 clientMessageId -> POST /rokid/rabilink/input
  -> 远端 Worker 追加至统一会话账本 (rabilink-conversation.jsonl)
  -> 立即响应释放上行项 (不阻塞等待模型逐句回复，不卡死眼镜端)
  -> 远端大脑 (Codex/云端 Agent) 空闲时结构化审阅账本，或由眼镜端轻触触摸板触发即时审阅

  【下行队列 - 持久游标流】
  远端 Agent (主动通知 / 审阅回复 / 定时提醒) -> 投递至持久下行 Outbox
  -> 眼镜端根据本地持久化游标 (nextCursor) 轮询接收 /rokid/rabilink/messages?stream=1
  -> 写入本地持久队列 -> 原生 speechSynthesis 顺序朗读
  ```

---

## 如何设置灵珠智能体

### 方式 1：语音即时配置（最便捷）
戴上眼镜直接对麦克风说出以下任意口令：
- “设置灵珠智能体为 星河”
- “绑定智能体 小爱”
- “切换灵珠智能体为 助手”

系统会立即更新当前绑定的智能体名称与持久化存储，顶部状态栏立即刷新，并通过 TTS 语音播报确认。

### 方式 2：启动参数（Schema 注入）
在 Rokid AIUI Studio 中调用或通过外部灵珠智能体唤醒页面时，传入以下参数：
```json
{
  "agentId": "your-lingzhu-agent-id",
  "agentName": "自定义智能体名称",
  "systemPrompt": "你是一个幽默风趣的科技助手，回答简洁聚焦。"
}
```

---

## 官方 API 契约与参考文档

本项目严格遵循 Rokid AIUI 官方标准 API 开发：

- **语音识别 (ASR)**：[AIUI SpeechRecognition API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=0.18.0)
  - 采用单轮状态机前台受控续轮设计；
  - 启动前确保界面处于可交互状态；
  - 在 TTS 开始前主动中止 ASR，避免麦克风占用冲突。
- **语音合成 (TTS)**：[AIUI speechSynthesis API (0.18.0)](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=0.18.0)
  - 采用标准 `speak(utterance, "enqueue")` 队列机制；
  - 配合宿主 `onend/onerror` 生命周期回调与基于字数的有界超时安全 Watchdog，防止播报状态锁死。
- **端侧大语言模型 (SLM)**：[AIUI LanguageModel API (0.18.0)](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
  - 采用严格的 `LanguageModel.create()` 零参数纯净契约，杜绝因工具 Schema 传参格式差异引发的端侧 Native 崩溃；
  - 通过 `promptStreaming()` 分句流式吐出应答；
  - 配备完整的可用性检查与本地兜底应答机制。

---

## HUD 视觉与交互规范

- **视野适配**：针对 Rokid AR 光学穿透特性开发，不使用大面积高亮或彩色色块，不阻挡真实视界。
- **HUD 结构**：
  - **顶部状态胶囊**：灵珠智能体名称（动态展示）、状态 Pill（思考中 / 回复中 / 正在聆听 / 就绪）、时钟角标与电量显示。
  - **底部主字幕卡片**：20px 大字号复古绿（#00FF88 / #55FF99）高对比度文字，半透明黑底背景。
- **触摸板交互契约**：
  - **单触（Tap / Enter）**：在语音播报时立即打断（Barge-in）；在远端协同模式空闲时请求远端 Agent 即时审阅。
  - **双触（Double Tap）**：返回上一级或退出当前应用。

---

## 本地检查、构建与部署

### 1. 本地代码检查与烟测
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

### 3. 上传与真机同步
1. 打开 [Rokid AIUI Studio (Craft)](https://aiui.rokid.com)；
2. 选择“导入本地文件夹”，指向生成的 `apps/rabilink-aiui/dist/craft-upload` 目录；
3. 在 Studio 中即可直接预览大字号 HUD，并执行真机调试或发布提审；
4. 提审通过后即可在 Rokid 手机 App 智能体中心添加并一键同步到眼镜。
