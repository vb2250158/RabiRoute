# 移动端录音健康验收证据

[English](mobile-audio-health-evidence_en.md) | 简体中文

有效段切句上线后，持续监听不等于持续写文件。`Test-RabiMobileDurableAudioSoak.ps1` 与 `Test-RabiMobileDurableAudioFaults.ps1` 不再用 `lastWrittenAt` 或 `nextSequence` 推进证明麦克风健康。

## 已有指标与范围

脚本只读 `rabi_phone_audio_capture.xml` 中的 `active`、`lastSampleAt`、`totalBytes`、`startedAt`。这些字段由 `RabiPhoneAudioCapture.persistRuntime` 写入：`lastSampleAt` 来源于实际 AudioRecord read 的单调时间，`totalBytes` 是读入原始PCM计数，不是有效事件落盘量。健康要求采集处于活动状态、read证据新鲜；跨样本进展同时检查最后采样时间和原始字节数。

这组证据只覆盖手机麦克风。眼镜输入、缺失指标、过期指标、计数回退均不能据此声明采集健康；故障注入前缺少新鲜证据会停止，不执行设备操作。重启恢复使用重启后新的采样时间与正字节数，不跨进程强求计数单调。

## 分开报告结果

- 纯静音可以证明持续读取，不要求新增落盘或上传；`audioQualityVerified=false`，不冒充声音质量/转写效果验收。
- 只有观察到新有效事件或已有待上传段，才要求上传推进与对应传输校验。无新事件报告 `not_exercised_no_new_valid_events`。
- 故障注入未观察到在写分片时，不要求恢复计数上涨，明确报告该恢复分支未覆盖；这不是崩溃恢复通过。
- 原有哈希、顺序与落盘字节守恒仍验证；这里的保存字节守恒不包括被声学判定过滤的原始静音。
- 当前上传检验仍面向原有音频流 ACK 合同；事件 ASR 独立回执不能冒充流 ACK。仅转写事件模式若没有该合同的证据，不能报告其端到端上传通过。

脚本测试使用纯内存夹具，不连接设备。长稳/故障脚本会操作真实环境，不应为验证脚本修改而自动运行。
