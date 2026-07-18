<!-- docs-language-switch -->
<div align="center">
<a href="./rabilink-active-intelligence-requirements_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink 主动智能需求与实施方案

> 状态：手机后端 + 眼镜原生前端主线的实施追踪。2026-07-18 起暂停 AIUI 新功能；保留的 AIUI 代码只作历史证据。

## 最终架构

```text
眼镜原生前端
  -> 采集 PCM 发给手机；不保存 Relay 凭据，不运行 ASR
手机眼镜后端
  -> 拥有眼镜设置、Relay 凭据、目标 PC、cursor 和传输队列
  -> 调用 Relay 受限语音代理
Rabi PC 眼镜消息端
  -> RabiSpeech ASR -> record-first observation -> 统一账本 -> Agent 审阅

Agent / 定时器 / 规划器
  -> RabiRoute Outbox 和动作门 -> Relay 持久下行
手机
  -> 按 cursor 拉文本 -> 请求 Rabi PC TTS -> 把 PCM 发给眼镜
眼镜
  -> 顺序播放音频
```

手机不是第二个 RabiRoute 配置源。Route、Agent、工作区和线程配置只存在于 Rabi PC；手机通过远程 WebGUI `/manage` 修改。

## 必须达成

1. 眼镜通过手机和 Relay 连接目标 Rabi PC，公网凭据不落在眼镜。
2. 手机可打开 PC 远程配置，但不存在第二套 Route、Agent 或 Codex 绑定编辑器。
3. ASR 最终文本先落账本，不逐段同步打断 Codex。
4. 用户观察、Agent 下行和手动审阅请求进入同一条可审计 JSONL 时间线。
5. Codex 可在空闲、周期或明确引导时审阅新上下文。
6. Codex、定时器和规划器不依赖上行 `taskId` 也能主动排队消息。
7. 手机按 cursor 恢复下行，请求 PC TTS，并把 PCM 顺序发给眼镜。
8. ASR/TTS 只在 Rabi PC 眼镜消息端运行，手机和眼镜都不维护语音模型。
9. 照片和短视频按可靠消息附件处理；首版不承诺实时视频或 24 小时录音。
10. 高风险外部动作继续经过 RabiRoute 动作安全门。

## 真源划分

| 数据 | 拥有者 |
| --- | --- |
| Route、人格、策略、语音 Provider 和 Agent 配置 | PC RabiRoute |
| 统一会话上下文 | PC 人格目录 JSONL 账本 |
| 公网上下行邮箱与临时附件对象 | Relay |
| Relay 凭据、目标 PC、眼镜设置、cursor、待传队列 | 手机 App |
| 麦克风/播放状态与最小 HUD 状态 | 眼镜 App |
| 模型、工具、沙箱、审批和当前 turn | PC Agent runtime |

手机和眼镜都不能成为第二套 Agent、记忆系统或配置真源。

## 队列契约

### 音频上行

眼镜把带 tag 的 16 kHz mono 16-bit PCM 发给手机。Classic Bluetooth 与 P2P 可能同时送达控制消息，因此开始/停止必须幂等。手机把 PCM 封装为 WAV，调用 `/api/rabilink/speech/v1/audio/transcriptions`，再通过 `/api/rabilink/devices/input` 发布稳定的 record-first observation。

### 媒体上行

手机先把二进制上传到 `/api/rabilink/devices/media`，成功后才发布带 `attachments` 的 observation。PC worker 使用同一鉴权把对象下载到 Route 私有数据目录，再写账本并交给 Agent。二进制上传失败时不得产生悬空 observation。

当前真机照片回调已接线；协议接受视频文件，但真眼镜视频回调和手机磁盘级离线重试仍待验收。媒体是串行慢传的消息附件，不是实时流。

### 主动审阅

审阅器读取统一账本，只在安全处理后推进持久审阅状态。触发来源包括稳定的新 observation、周期反思、手动审阅和明确受信的紧急事件。

### 下行

用户可见文本经过 `/api/agent/replies`、输出策略、Relay Outbox 和持久消息端。手机按 cursor 拉取，调用 `/api/rabilink/speech/v1/audio/speech`，从 WAV 提取 PCM 并发给眼镜。投递回执与播放回执是下一层可靠性工作。

## 隐私与安全

- 不记录 token、转写正文、音频正文或私有附件内容。
- 原始音频默认不长期保存。
- 下载附件只进入 Route 私有数据目录，并排除在源码提交之外。
- Relay 语音权限是明确的 ASR/TTS 白名单，不等于 WebGUI、worker API、PC 麦克风控制或任意本机 URL 权限。
- 采集状态必须可见、可暂停；后台运行必须使用带常驻通知的 Android Foreground Service。
- 外发、删除、购买和设备控制继续遵守现有审批规则。

## 验收顺序

1. 构建两个 APK，验证手机侧安装和启动眼镜前端。
2. 验证真眼镜 PTT 经 PC ASR 只产生一条账本 observation。
3. 验证 PC 主动文本经 PC TTS、手机转发后在眼镜播放。
4. 验证重连/cursor 恢复和跨传输重复控制消息抑制。
5. 验证照片以本地已鉴权附件到达 PC。
6. 把手机后端从 Activity 生命周期迁移到可见的 Foreground Service。
7. 增加磁盘级音频/媒体重试、指数退避、保留期清理及投递/播放回执。
8. 接入真眼镜视频文件采集；可靠文件消息完成后才评估实时视频。

## AIUI 历史边界

AIUI 无法直接与 CXR-L 通讯，也不再属于当前主链。现有 AIUI 页面、测试和发布记录保留作回归与协议历史；Craft 提审或 AIUI ASR/TTS 真机验收不再阻塞手机/眼镜 App 里程碑。
