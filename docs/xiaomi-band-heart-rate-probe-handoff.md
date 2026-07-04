# 小米手环心率列表探针交接

本文用于把“小米手环心率列表能否通过 APK 拉到更多数据”的当前状态交接给另一台电脑上的 Codex。

## 当前结论

- 不再走“手环心率广播”路线，因为它要求用户在手环侧开启实时心率广播，不适合普通使用。
- 小米健康本地 Provider 当前可通过 ADB shell 读取 `content://com.mi.health.provider.main/heartrate/recent`，但它只返回最近一次心率。
- 普通第三方 APK 直接读小米健康 Provider 会遇到权限墙；`HealthProviderService` 需要 signature/privileged/preinstalled 权限，不能作为稳定第三方方案。
- Health Connect 权限可以申请，但当前实测小米健康没有把心率/睡眠/步数写入 Health Connect，读数为空。
- 反编译线索显示小米健康内部存在 `DailyHrReport.hrRecords`、`singleHrRecords`、`latestHrRecord` 等结构；但普通 Provider 没有暴露完整列表。
- 当前可继续验证的产品化方向是小米健康云 SDK/OAuth：通过 `DataSource -> DataSet` 分页拉取，确认云端是否能返回完整心率列表。

## 主要工程

Android 探针工程：

```text
examples/android-band-probe/
```

Vela 快应用探针工程：

```text
examples/vela-band-probe/
```

Android 工程是当前重点。Vela 工程用于验证“跑在手环上的应用”能力，但官方快应用能力目前未发现第三方心率/睡眠历史读取 API。

## Android APK 能力

APK 包名：

```text
com.rabiroute.bandprobe
```

关键能力：

- BLE 扫描、设备信息、电量、公开心率服务探测。
- 小米健康本地 Provider/Health Connect 探测。
- 小米健康云 OAuth token 手动保存或授权回调保存。
- 默认拉取：
  - `com.xiaomi.micloud.fit.heart_rate.bpm`
  - `com.xiaomi.micloud.fit.heart_rate.summary`
- `全类型深扫`：扫描 SDK 暴露的所有官方 data type，默认最近 168 小时，按 24 小时分片，每页 1000 条，最多 50 页。
- 云端拉取跑在 `MiHealthCloudProbeService` 前台服务中，避免长时间分页任务被 BroadcastReceiver 超时中断。
- Android 13+ 会申请通知权限；深扫期间显示前台通知。
- 深扫期间持有最多 30 分钟 partial WakeLock，结束后释放。
- 拉取完成后自动保存 ZIP 到：

```text
Download/RabiRouteBandProbe/mi-health-cloud-*.zip
```

- 完成通知和主界面会显示：

```text
points / dataSources / pages / rawHttp / errors
```

- 主界面提供 `分享云ZIP`，用于把最近一次自动或手动保存的 ZIP 分享出来。

## 构建 APK

在仓库根目录：

```powershell
cd <repo>\examples\android-band-probe
.\scripts\Export-BandProbeApk.ps1 -Build
```

输出位于：

```text
examples/android-band-probe/out/apk/RabiBandProbe-v<versionName>+<versionCode>-<yyyyMMdd-HHmmss>-debug.apk
```

脚本会同时生成 SHA256 文件。

注意：构建需要本机 Android/Gradle 环境，以及 `examples/android-band-probe/app/libs/android-fit-20150719.jar`。

## 手机独立测试流程

1. 安装最新版 APK。
2. 打开 `Rabi 手环探针`。
3. 授予蓝牙和通知权限。
4. 点 `小米云授权`，输入小米开放平台 AppID、scope、data_types、hours 等；或者手动粘贴 `access_token` 并保存。
5. 点 `拉取心率列表` 先验证默认心率类型。
6. 如果仍然只有 0/1 条，点 `全类型深扫`。
7. 等完成通知出现。
8. 打开 APK 点 `查看云结果`，先看 `points/dataSources/pages/rawHttp/errors`。
9. 点 `分享云ZIP`，把 ZIP 交给 Codex 分析。

## ADB 测试流程

如果手机能被 ADB 识别：

```powershell
adb devices -l
```

运行全类型深扫并拉回证据包：

```powershell
cd <repo>\examples\android-band-probe
.\scripts\Collect-MiHealthCloudHeartRate.ps1 `
  -Serial <adb-serial> `
  -InstallApk `
  -AllSdkDataTypes
```

脚本现在直接启动前台服务：

```text
am start-foreground-service -n com.rabiroute.bandprobe/.MiHealthCloudProbeService
```

它会导出：

- `mi-health-heart-rate-*.json`
- `mi-health-heart-rate-*.md`
- `mi-health-cloud-log-*.txt`
- `raw-*` 原始 HTTP 响应目录
- `mi-health-cloud-*.zip`

## 解析结果包

解析 APK 分享或 ADB 拉回的 ZIP：

```powershell
cd <repo>\examples\android-band-probe
.\scripts\Convert-MiHealthCloudJsonToMarkdown.ps1 -InputZip .\out\mi-health-cloud\mi-health-cloud-YYYYMMDD-HHMMSS.zip
```

解析器会统计：

- 主 JSON `points`
- 去重后样本数
- 疑似重复数
- raw HTTP 中递归发现的 `dataPoint`
- raw HTTP 中递归发现的 `dataSource`
- 按 data type 统计数据源和点数

判断重点：

- `points > 1`：APK 主路径已能拉到心率列表，继续整理字段和正式集成。
- `points = 1` 但 `raw dataPoint > 1`：SDK 解析可能漏了，优先改 raw HTTP 解析路径。
- `dataSources = 0`：AppID/scope/token 或 data type 不对。
- `pages = 0`：没有进入 dataset 分页，多半是数据源为空或权限不足。
- `rawHttp = 0`：原始 HTTP 探针没跑通，先查网络/token。
- `errors > 0`：先读 `errors` 和 log。

## 当前阻塞

上一台电脑上，ADB 连续多轮返回空：

```text
adb devices -l
List of devices attached
```

本机下载目录也没有新的 `mi-health-cloud-*.zip`。因此尚未有真实云端结果包，不能证明“已经能拉到完整心率列表”。下一台电脑的首要任务是拿到真实 ZIP。

## 不要提交的文件

以下是运行产物或本机数据，不应提交：

- `examples/android-band-probe/out/`
- `examples/android-band-probe/build/`
- `examples/android-band-probe/app/build/`
- `examples/android-band-probe/.gradle/`
- `examples/android-band-probe/signing/`
- `examples/android-band-probe/mi-health-*.json`
- `examples/android-band-probe/mi-health-*.md`
- `examples/vela-band-probe/node_modules/`
- `examples/vela-band-probe/build/`
- `examples/vela-band-probe/dist/`
- `examples/vela-band-probe/*.log`

这些规则已经写入 `.gitignore`。
