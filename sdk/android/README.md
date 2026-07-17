<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute Android SDK

> 状态：实验 SDK。源码已被 RabiLink Android 探针直接引用，但尚未发布为独立 Maven/Gradle 制品。

第一版原生 SDK 使用 Kotlin、`HttpURLConnection` 和 `org.json`，不依赖 Retrofit。

## 当前能力

- 扫描局域网内的 RabiRoute Manager 和 RabiLink callback。
- 读取实例 GUID、名称、设备信息和版本。
- 按实例读取 Route、Agent 工作目录和任务选项，并更新 Agent 绑定。
- 向本地 RabiLink callback 投递消息、发送回复、拉取下行消息并执行双向 smoke test。
- 从 Relay 认领任务、追加回复和完成任务。
- 读取/选择 Relay 上的 PC 实例并配置移动端 Route 绑定。
- 发布便携设备 observation、拉取主动/普通下行消息和上报设备状态。

这些 API 是同步调用。Android 应用应在后台线程使用，并自行处理网络权限、生命周期、超时和用户授权。

## 局域网监听

Manager 默认只监听 `127.0.0.1`。要让 Android 设备发现电脑，需要显式监听局域网地址，并配置操作系统防火墙：

```powershell
$env:GATEWAY_MANAGER_HOST="0.0.0.0"
npm run start:manager
```

不要把无鉴权的本地管理接口暴露到不可信网络。

## 引用方式

当前没有发布坐标。`examples/android-rabi-link-probe` 通过 Gradle `sourceSet` 直接引用：

```text
sdk/android/rabiroute-sdk/src/main/java
```

SDK 事实源是 [`RabiRouteSdk.kt`](./rabiroute-sdk/src/main/java/com/rabiroute/sdk/RabiRouteSdk.kt)。新增方法时应同步更新本 README 和英文版。
