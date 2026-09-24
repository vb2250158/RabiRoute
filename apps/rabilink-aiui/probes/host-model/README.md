# Rabi 对话 v0.5

独立、无参数 AIUI 语音对话工程。ASR interim 实时修正字幕，只有 final 进入模型一次；同一宿主默认 LanguageModel 会话处理多轮。promptStreaming().read() 增量显示文字，按短句 enqueue TTS，尾句只发送一次。生成与累计播报估时完成后恢复 ASR。

默认下方紧凑气泡，中央保留空白；全屏模式扩展阅读区域。左右选择底部暂停、最新、全屏/气泡，确认执行；上下翻页。手动翻阅停止跟随，最新恢复跟随。切换布局保持同一识别、模型会话及播报队列。小卡片内长内容可在单一受限滚动区域阅读，当前页最多12行；真实眼镜视野和触控仍需验收。

时间为运行时当前时间。仅当 navigator.getDeviceSerialNumber 返回非空设备身份时读取官方 navigator.getBattery：显示四舍五入百分比与充电状态，监听变化，隐藏解绑，恢复刷新，5秒超时丢弃迟到结果。无设备身份、无能力、非法值或拒绝显示 —，data.batteryReason 和安全console保留原因。没有读取电脑浏览器电池作为眼镜电量。真实数值仍需眼镜与乐奇设备页对照。

模型仅有白名单 close_app 和 set_display_mode。close_app 还要求当前用户明确说“退出应用”等直接命令，调用 Page.finish() 结束当前页面任务；Cut交回焦点，Scene由宿主决定结束当前流程。set_display_mode 只接受 bubble/fullscreen，幂等切换当前布局。未知工具或参数拒绝。当前API没有已证实工具结果回传协议，不伪造tool消息。没有公开硬件息屏API，不把黑色页面、renderingEnabled或finish当作息屏。

官方 speak 无完成/取消合同，采用原项目1.8–90秒每句估算，队列时长累计。不能保证精确消除回录，暂停/退出后已提交语音可能继续。隐藏或卸载停止识别、流读取、模型会话、状态计时与电量监听。

无PC/Relay、凭据、任意外发工具或音频/文字持久化。宿主模型与语音服务可能联网。默认pages/home/index，兼容pages/index/index。Studio导入整个目录，保留home工具metadata和麦克风/语音识别权限。运行node test-lifecycle.mjs验证逻辑；回归使用替身，不冒充设备结果。
