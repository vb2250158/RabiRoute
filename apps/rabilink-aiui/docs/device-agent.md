[English](device-agent_en.md) | 简体中文

# 眼镜作为设备 Agent

状态：实验功能。源码测试已覆盖登记、消息投递、领取和回执；自动唤醒与实际眼镜执行尚未通过真机验收。

AIUI 打开并成功创建乐奇原生 `LanguageModel` 后，向设备连接登记的 PC 注册名称、稳定 Agent ID 和原生会话 ID。PC 的消息路线（Route）可选择 `deviceAgent`，绑定的实例 ID 是该 PC 的 RabiGuid，Agent ID 是眼镜的设备绑定 ID。更改显示名称不会更改 ID。

眼镜负责推理、通用 Rabi API 工具、乐奇 ASR 和 TTS。绑定角色提供提示词与 Skill，并决定工具和聊天记录的来源 PC；它不限制接口权限。经鉴权并启用的远端 Agent 可以主动调用全部公开 Manager 接口和其它同应用 PC 的能力。Route 绑定只决定消息自动送到哪里。

PC 保存唯一的消息队列与回执。每次投递保留原始 `deliveryId`；同 ID、同正文回读原回执，变更正文会冲突。眼镜凭设备身份、当前 `ownerEpoch` 和服务器签发的 `claimToken` 领取与回传；这些字段防止其它客户端冒领正在执行的任务。手机的应用凭据可管理和主动投递消息，但不能冒充眼镜执行者。

设备会话可作为正式 Agent 请求的来源或目标。`POST /api/agent/threads` 与其它处理端共用 PC 的请求与回复账本，支持 `responsePolicy=required`、`inReplyToRequestId` 和原投递回执核对；设备不需要工作目录或 PC 模型。只有原 session 与 epoch 的眼镜实际领取消息后，投递才确认成功。页面再次打开同一会话会带回已保存的 epoch。会话与执行缓存按规范化 Relay 地址、凭据摘要、设备 ID 和设备所在 PC 分开保存；切换服务器不迁移旧缓存。连接或执行者换代后的旧投递不会交给替代会话重跑。

角色来源 PC、设备所在 PC 和请求账本所在 PC 可以不同。眼镜可直接向其它同应用 PC 发起正式请求：接收 PC 经现有通用 Manager 隧道核对实际设备所在 PC 的会话、加载状态和 epoch。正式回复仍使用原账本 PC；目标设备所在 PC 回查原账本的 reservation 与指纹，在眼镜领取前再次验证。设备 PC 只保存运输队列与回执，不复制另一台 PC 的业务账本。角色选择不改变这些身份或接口权限。

收到跨 PC 请求时，模型会得到实际账本 PC 的 `targetDeviceId`，仅用于原回传参数。普通接口的默认角色 PC 与聊天记录保存目标仍保持原配置。新正式请求也可显式选择其它 PC。证明失效、源会话未加载或 PC 连接换代时，原投递保持未确认，不换执行者、不重新排队。原账本明确返回取消状态且投递身份与指纹全部匹配时，设备 PC 把尚未领取的运输记录标为 `result-unknown / ledger_cancelled`，保留证据并继续后续消息；普通拒绝、超时或断网不会被当成取消。

眼镜未加载时，消息保持排队。手机只接收唤醒 nonce 和投递 ID，沿已有 CXR-L 自定义组件命令发送唤醒请求并上报结果。手机不接收要执行的 prompt，不创建替代模型。命令已提交不等于 AIUI 已唤醒；必须由眼镜登记、领取原消息才能得到执行者接收回执。系统拒绝广播或等待超时会保留原任务并返回具体失败。

当前普通应用触发双指广播曾被真机拒绝。已有代码不能证明该系统接受程序触发的自定义按键，也不能证明所有已配对眼镜与设备绑定一一匹配。自动唤醒仍需使用受支持的乐奇入口完成真机验收。手动打开 AIUI 后可沿同一个队列领取原消息。

消息通过现有眼镜推理循环执行，并沿原会话保存结果。ASR 可在推理和 TTS 播放中继续输入；识别到文字时只停止播放，最终文本作为下一步引导。消息领取等待当前语音输入与引导完成，不启动并行的替代推理循环。页面隐藏、模型失效或连接切换后，原任务结果不确定时不会自动重新执行。

传输复用 [通用接口客户端](generic-api-transport.md)。未配对手机时使用有限 HTTP 中转；配对后手机使用眼镜独立身份的加密 Manager Tunnel，按 LAN → P2P → Relay 连接，并提供流与 WebSocket 升级。正式 session、claim 和 response 沿同一眼镜源身份传输。协议源码已验证，实际眼镜访问手机、HTTPS 地址与线路选择仍需真机验收。新增 PC API 不需要增加 Relay 业务适配器。

开发验证入口：`src/agentAdapters/deviceAgentOwner.test.ts` 使用真实 HTTP 与 PC 状态存储验证原消息投递；`src/manager/deviceAgentEndpointBridge.test.ts` 验证通用投递工厂的正式往返回复；`src/manager/deviceAgentPeerEndpoint.test.ts` 验证两台独立 HTTP Manager 的会话证明、唯一账本与实际领取回执；`scripts/Smoke-DeviceAgentPage.mjs` 验证既有推理循环、语音引导和不确定结果。它们不替代真实 ASR、TTS、按键唤醒或眼镜模型验收。
