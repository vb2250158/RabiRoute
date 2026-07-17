[English](speech-message-endpoint-design_en.md) | 简体中文

# 语音消息端整合设计

> 状态：已选定并进入实施。目标是由 RabiRoute / RabiPC 接管 OumuQ 与 FenneNote 的本地语音能力；不接入付费云 TTS / ASR。

## 约束

- RabiSpeech 仍是可直接调用的普通本地 API，不拥有 Agent，也不理解对话上下文。
- 语音消息端是 RabiPC 的可选 Route 入口：录音、ASR、投递、TTS 回复和少量参数配置都在这里完成。
- 未配置语音消息端时，RabiPC 仍可按人格名直接合成并播放语音。
- 人格拥有声线身份。参考音频、台词索引、情绪标签和可重建缓存统一位于 `data/roles/<RoleId>/voice/`。
- 每次请求显式携带人格、模型、Route 和会话；不得依赖进程级“当前角色”。
- 所有 Route 和直接调用共享一个主机级 FIFO 播放队列，生成可并行或由 GPU 互斥组调度，但扬声器不得重叠播放。

## 方案比较

### 方案 A：全部放进 Manager

Manager 同时管理模型、音频、Route 和播放。入口集中，但会让 TypeScript 控制面承担 Python 模型生命周期，并使独立 API 依赖 Agent/Route 运行时。

### 方案 B：RabiSpeech 语音域 + RabiPC 可选消息端（选定）

RabiSpeech 直接管理本地 provider、worker、人格声线解析和主机播放队列；Manager 只提供安全代理、Route 投递和 WebGUI 配置。直接 API 与消息端复用相同模型注册表和播放队列。

### 方案 C：继续代理 OumuQ / FenneNote

改动最小，但保留两个停止维护项目、三套前端和重复配置，不能形成新的唯一入口。

## 选定边界

```text
RabiSpeech 常驻本机麦克风 / 本地文件 / 任意 HTTP 客户端
  -> RabiPC 顶部 TTS/ASR 管理标签（可选）或 RabiSpeech API（直接）
  -> RabiSpeech 本地模型注册表
  -> ASR worker / TTS worker
  -> data/roles/<RoleId>/voice/
  -> 主机级 FIFO 播放队列（可选播放）
  -> Route / Agent（仅消息端模式）
```

常驻麦克风属于 RabiSpeech 服务生命周期，关闭 RabiPC 页面不会停止。RabiPC 的 ASR 标签只负责设备、双阈值、动态底噪、前置缓存、静音切句、模型、会话和可选 Route 投递配置；TTS 标签负责人格、声线、模型、风格和 FIFO 播放。麦克风启动/停止接口只开放给本机回环 Manager，不随普通 RabiLink token 对外暴露。

RabiSpeech 不从文本猜人格。`voice` 使用人格 ID；高级调用才允许显式参考音频。不同会话可以同时使用不同人格，但每个 job 在入队时冻结完整声线快照。

## 人格声线目录

```text
data/roles/<RoleId>/voice/
  voice-profile.json        # 默认模型、语言、发声说明和授权摘要
  voice-index.json          # 稳定台词 ID、文本、情绪、参考音频
  dialogue-examples.jsonl   # 影响口吻和情绪的台词示例
  audio/                    # 私有参考音频；默认不提交
  cache/reference-audio/    # 合并、重采样等可重建缓存
  reports/                  # 该人格的本地测试结果
```

Wiki 提取只保留角色人设、影响声线/情绪的特征、台词示例和台词索引；不得用 Wiki 覆盖 Rabi 已存在的人格原则、记忆、计划或动作边界。

## 扩展边界

Provider 注册接口继续保留，但默认配置、安装脚本、文档和测试只列本地模型。未来增加其它 provider 时必须显式安装并由本机管理员登记；远程请求不能下载模型或加载代码。
