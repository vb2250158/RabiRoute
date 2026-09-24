[English](README_en.md) | 简体中文

# AIUI 与 Rabi 手机 BLE 连通测试

实验包：仅交换 `ping:<8位随机十六进制>` 和相同 nonce 的 `pong:`，各 13 字节，无音视频、账户或业务数据。没有公网依赖。编译成功不代表真机连通或后台唤醒成功。

1. 更新包含此诊断的 Rabi 手机包（保留数据；安装会中断正在运行的服务，应先安排录音窗口）。
2. 手机高级诊断中心 → 眼镜 BLE 连通测试，允许附近设备权限，保持页面前台；v0.2 进入页面自动广播，重复启动不会重建已运行服务。
3. 将本目录作为独立 AIUI 包导入官方平台，在眼镜打开可交互的 `pages/ping/index`。v0.2 首次就绪后自动扫描 4 秒，只在发现唯一测试手机时自动交换一次 ping/pong 并断开。失败不循环重试；点击重试或确认键可再次测试。
4. 只有眼镜显示收到对应 nonce 的 pong 才算端到端通过。手机“已交给蓝牙栈”不等于眼镜已收到。
5. 离开任一诊断页停止链路；不会修改官方眼镜配对、采集设置或已有业务队列。

服务 UUID：`78c20001-48a3-4b18-a401-819ec0200001`；特征 UUID：`78c20002-48a3-4b18-a401-819ec0200001`。AIUI 严格按服务筛选，使用 write-with-response 后 read，返回 `number[]`；手机拒绝 prepared write、非零 offset、超长和非协议正文。测试接口无需绑定认证，因此不得扩展承载私人或业务数据。

手机新增 `BLUETOOTH_ADVERTISE` 运行时权限；不扫描其他设备。官方眼镜蓝牙连接能否与本链路并存、当前固件 AIUI BLE 是否可用，均需现场确认。AIUI 搜索与连接要求页面可交互；此包不提供后台保活。

页面分别保留最后阶段、结果、生命周期原因和按键编码。隐藏、卸载、超时、用户停止不会冒充 BLE 失败；已成功结果不会被隐藏覆盖。宿主交互门禁和系统权限仍照常生效。多个测试手机同时广播时不会猜选目标。空闲只显示重试入口，确认键不激活停止按钮。

v0.3 先调用 `getDevices()` 读取运行时记住的设备；这不是系统配对列表。只有与本测试此前成功 nonce 往返后保存的设备 ID 和服务 UUID 完全匹配的唯一目标才会被直接连接，并重新验证服务与 nonce。首次使用、记录缺失或不能唯一匹配时仍按服务 UUID 扫描；不连接其他已记住设备。错误显示完整 `name: message`，并区分 S1 调用扫描、S2 等待返回、S3 注册监听、S4 等待回调、S5 解析回调，便于定位宿主 QuickJS 异常。手机继续使用 v0.2，无需重装。

手机实现位于 `../rabi-mobile-android/app/src/main/java/com/rabi/link/modules/rokid/RokidBlePing*.java`。项目目录只存源码，构建和 ZIP 产物在本机目录生成。

复制源码到本机后运行 `node test-ping.mjs`。运行 `node build.mjs <新的本机输出目录> <Write-DeterministicZip.mjs 路径>` 生成普通 Studio 目录与 AIX；ZIP writer 复用 `../rabilink-aiui/scripts/Write-DeterministicZip.mjs`。手机协议验证使用 `:app:testDebugUnitTest --tests com.rabi.link.modules.rokid.RokidBlePingProtocolTest -PmobileSlim -ProkidVideo`。
