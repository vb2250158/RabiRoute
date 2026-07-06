# RabiRoute Android SDK

第一版 Android 原生 SDK 使用 Kotlin 和 Android/Java 标准库实现，不依赖 Retrofit。

能力：

- 扫描当前局域网内可访问的 RabiRoute 服务。
- 读取 RabiRoute 实例信息、GUID、实例名和版本。
- 按实例 GUID 获取路由列表。
- 获取指定路由的 Agent 可选工作目录和会话线程。
- 设置指定路由的 Agent 工作目录和会话线程。

RabiRoute manager 默认只监听 `127.0.0.1`。要让 Android 设备扫描到电脑上的 RabiRoute，需要用局域网监听方式启动：

```powershell
$env:GATEWAY_MANAGER_HOST="0.0.0.0"
npm run start:manager
```

RabiLink 测试工程通过 Gradle sourceSet 直接引用 `rabiroute-sdk/src/main/java`。
