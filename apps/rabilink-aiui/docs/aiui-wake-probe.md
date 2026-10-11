# 双指单击唤醒 AIUI 验证

[English](aiui-wake-probe_en.md) | 简体中文

状态：实验探针。本次真机已验证安装、启动和自定义消息回包；普通应用发送双指广播被系统权限拒绝，不能用于自动唤醒。实际 AIUI 唤醒与原消息领取未验收。目标按用户确认的链路执行：RabiPC 投递 → 手机触发眼镜双指单击 → 乐奇已配置的自定义指令打开 AIUI → AIUI 领取原消息。

## 官方依据

2026-10-10 读取用户提供的 [CXR-L 官方文档](https://custom.rokid.com/prod/rokid_web/84feb39f8ef141b0ad0326f902ab881f/pc/cn/fa92e9303bc848e6b4a20c062f2c792b.html)。其《眼镜端按键与系统广播》v1.2 明确双指单击的广播 action 为 `com.android.action.ACTION_TWO_FINGER_SINGLE_TAP`，眼镜应用可监听并按有序广播规则处理。《自定义指令》v1.3 描述的是 `CUSTOM_APP` 内手机与自有眼镜应用的通道通信。

这些正文说明事件接收和应用间传输。官方权限说明针对系统向已注册接收器发送广播，不能据此推断普通应用有发送权限。2026-10-10 真机使用 Android `sendOrderedBroadcast()` 后返回 `dispatch_security_rejected`，对应系统抛出的 `SecurityException`；该发送路径未唤醒 AIUI。`sendCustomCmd()` 已验证可传递探针消息，不是系统按键注入 API。受支持的系统手势触发接口或授权组件仍待确认。

## 手机测试入口

1. 在乐奇 App 将眼镜双指单击的自定义指令配置为打开目标 AIUI。
2. 打开 RabiLink 的乐奇 CXR 测试页，依次连接、查询眼镜组件。需要更新组件时，先开启手机 Wi-Fi 并等网络就绪，再点击“安装随包眼镜组件”，安装后重新查询。
3. 点击“启动眼镜组件（无采集）”，等启动回调成功。
4. 点击“测试双指单击唤醒 AIUI（实验）”。眼镜组件收到带本次请求编号的 CXR 消息后，发送固定 action 的有序广播；录像或采集准备中会拒绝该测试。
5. 观察 AIUI 是否出现并能继续对话；保存手机回执与眼镜实际表现。广播回执不能确认 AIUI 已打开。

手机精简包版本为 `0.3.53-dev`（56），随包眼镜组件为 `0.1.2`（3）。不会自动安装或运行探针。每次显式点击生成一个请求编号；眼镜在发送广播前持久保存编号。同一编号重复消息不会再次发出手势。诊断编号最多 128 个，满后明确拒绝，不删除旧编号。15 秒无回执时报告超时，不自动重发。

`broadcast_submitted` 表示 Android 接受广播调用；`broadcast_finished` 表示有序广播分发结束。`duplicate_suppressed`、`capture_busy`、`ledger_full`、`ledger_failed`、`dispatch_failed` 分别报告重复、采集中、诊断记录已满、记录保存失败、广播调用失败。`dispatch_security_rejected` 单独报告系统抛出的 `SecurityException`，`dispatch_invalid_argument` 报告 `IllegalArgumentException`；手机显示对应原因，失败仍保留原编号且不自动重试。均不宣称 AIUI 已收到业务消息。

安装失败时，分别核对蓝牙/CXR 与文件传输：蓝牙连接成功不代表手机已加入眼镜热点。`onInstallAppResult=false` 只确认安装失败；代理日志若报告“加入热点失败”，先处理 Wi-Fi 链路，不据此判断 APK 签名问题。

## 执行归属与下一步

| 对象或要求 | 唯一执行者 | 验收证据 |
| --- | --- | --- |
| 手势与自定义指令 | 眼镜系统及乐奇 App 已保存配置 | 代码触发后目标 AIUI 实际出现 |
| CXR 探针 | 手机控制器与自有眼镜组件 | 同一请求编号的广播阶段回执 |
| AIUI 推理、ASR、TTS | 乐奇 AIUI 宿主 | 同一宿主处理两次消息并实际播报 |
| 原投递及正式回传 | Rabi 现有消息合同 | AIUI 领取原消息编号，回传实际响应，重复投递不重复执行 |

当前探针不拥有模型或新的业务消息队列，也未注册可用的完整 Route Agent。手机测试页退出会断开其 CXR 控制器，眼镜组件不启动采集；RabiPC 不拥有或启动 AIUI 模型。完成真实唤醒探测后，才据实际 owner、领取与回执合同接入自动投递。原生工具结果续推理另见 [工具合同核对](agent-tool-contract.md)。
