# Rabi Vela 手环探针

这是跑在 Xiaomi Vela 穿戴设备上的快应用探针工程，用于验证手环端可用能力。

当前探测项：

- `@system.device.getInfo`：设备型号、类型、屏幕等状态。
- `@system.battery.getStatus`：电量状态。
- `@system.event`：系统事件监听占位。
- `@system.interconnect`：手环快应用与同包名手机 App 的消息桥。

注意：

- 官方基础能力文档未发现面向第三方快应用的心率/睡眠历史读取 API。
- `interconnect` 不是健康数据 API，它只能在手环快应用和手机 App 之间传消息。
- 真机安装 `.rpk` 需要 AIoT-IDE/小米开放平台允许的测试环境，手环 10 Pro 是否开放真机调试取决于设备固件和账号权限。

建议流程：

1. 运行 `npm install`。
2. 运行 `npm run build`。
3. 构建产物位于 `dist/com.rabiroute.bandprobe.debug.0.1.0.rpk`。
4. 用 AIoT-IDE 打开本目录，选择 `watch` 模拟器运行。
5. 如果账号/固件支持真机调试，再推送到手环。

已验证：

- `npm run build` 可以成功生成 debug `.rpk`。
- 当前包名是 `com.rabiroute.bandprobe`，用于和 Android 测试 APK 保持一致，后续验证 `interconnect` 时还需要使用同一签名体系。
