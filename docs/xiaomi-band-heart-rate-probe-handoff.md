# 小米手环心率列表探针交接

> 当前状态：Android 手机端探针已迁入 Rabi Link 命名体系，正式 APK 包名为 `com.rabi.link`，通用导出脚本为 `Export-RabiLinkProbeApk.ps1`。当前真实目录是 `examples/android-rabi-link-probe/`，本文所有可执行命令均以该目录为准。

本文用于把“小米手环心率列表能否通过 APK 拉到更多数据”的当前状态交接给另一台电脑上的 Codex。

## 当前结论

- 不再走“手环心率广播”路线，因为它要求用户在手环侧开启实时心率广播，不适合普通使用。
- 小米健康本地 Provider 当前可通过 ADB shell 读取 `content://com.mi.health.provider.main/heartrate/recent`，但它只返回最近一次心率。
- 普通第三方 APK 直接读小米健康 Provider 会遇到权限墙；`HealthProviderService` 需要 signature/privileged/preinstalled 权限，不能作为稳定第三方方案。
- Health Connect 权限可以申请，但当前实测小米健康没有把心率/睡眠/步数写入 Health Connect，读数为空。
- 反编译线索显示小米健康内部存在 `DailyHrReport.hrRecords`、`singleHrRecords`、`latestHrRecord` 等结构；但普通 Provider 没有暴露完整列表。
- 当前可继续验证的产品化方向是小米健康云 SDK/OAuth：通过 `DataSource -> DataSet` 分页拉取，确认云端是否能返回完整心率列表。

## 后台 API 可行性判定

小米路线目前不能按“已经完全找到、可以稳定使用”处理。只有满足下面条件的路线，才可以封装成 Rabi Link / RabiRoute 上层 API：

- 可由后台 Provider、Service、Health Connect、云 SDK 或明确授权接口触发。
- 不依赖小米健康前台页面、手动滑动、截图、UI dump 或 logcat side effect。
- 可以返回完整历史或明确分页数据，而不只是最近一次心率。
- 权限来源稳定，可解释给普通第三方 APK 或用户授权流程。

当前路线分级：

| 路线 | 当前状态 | 能否算后台 API |
| --- | --- | --- |
| `heartrate/recent` Provider | ADB shell 可读最近一次心率；普通 APK 仍有权限边界 | 只能算最新值探针，不是完整历史 API |
| 24 小时 / 多日心率 Provider | 内部 `DailyHrReport.hrRecords` 存在，但 Provider 未暴露完整列表 | 否 |
| Health Connect | 权限可申请，实测心率/睡眠/步数为空 | 形状可行但当前不可用 |
| `HealthProviderService` | 服务存在，但权限是 signature/privileged/preinstalled | 否 |
| 小米健康云 SDK/OAuth | 需要合作方 `app_id` 和 OAuth `access_token`，未用有效凭证跑通 | 待验证 |
| `DailyHrReport` logcat | 前台心率页会输出图表聚合心率，脚本可解析 | 否，只能算诊断/证据采集 |
| 隐藏“全部记录”页 | 已能打开，但当前页面显示“暂无数据” | 否 |

## 2026-07-04 实测更新

ADB 已在另一台电脑上连通手机：

```text
serial: 4b64e6d6
model: 23116PN5BC
Android: 16
com.mi.health: 3.56.0
```

已找到一条无需 root、无需小米健康云 token 的诊断取证路线：打开小米健康心率页时，`HrmDayWeekMonthFragment.refreshViewIfNeed()` 会把 `DailyHrReport` 打到 logcat，里面包含当天图表用的 `hrRecords`。该路线依赖小米健康前台页面和 logcat side effect，不应封装为 Rabi Link / RabiRoute 后台 API。

关键反编译线索：

```text
HrmDayWeekMonthFragment.refreshViewIfNeed()
Logger.i("MiHealth:hrm", "refreshViewIfNeed:" + DailyHrReport.toString())
DailyHrReport.hrRecords: List<TimesDataRecordInt>
```

已成功从日志中解析出当天心率图表列表，并落成 JSON/CSV：

```text
examples/android-rabi-link-probe/out/mi-health-logcat/mihealth-heart-records-20260704-163557.json
examples/android-rabi-link-probe/out/mi-health-logcat/mihealth-heart-records-20260704-163557.csv
examples/android-rabi-link-probe/out/mi-health-logcat/mihealth-heart-records-expanded-20260704-163557.csv
```

本次样本：

```text
bucketCount: 11
sampleCount: 21
```

注意：`DailyHrReport.hrRecords` 是小米健康当天心率图表聚合数据。每条 `TimesDataRecordInt` 提供桶起始时间和 `valueArray`，但不包含桶内每个值的精确秒级时间；`latestHrRecord` 单独包含最新样本的精确时间。

已把这条路线固化为脚本：

```powershell
cd <repo>\examples\android-rabi-link-probe
.\scripts\Collect-MiHealthHeartRateFromLogcat.ps1 -Serial <adb-serial>
```

对已有日志重跑解析：

```powershell
.\scripts\Collect-MiHealthHeartRateFromLogcat.ps1 `
  -InputLog .\out\mi-health-logcat\mihealth-logcat-heart-20260704-163557.txt `
  -OutputDir .\out\mi-health-logcat
```

该脚本只保存小米健康心率相关 logcat 行，避免把整份系统日志、QQ 或其他应用日志写入结果。
该脚本默认输出到 `out/mi-health-logcat/`，不要和需要 `app_id/access_token` 的 `out/mi-health-cloud/` 云 SDK 证据混放。

进一步实测：在小米健康心率页的日图表区域向右滑动可以切到前一天，且会触发新的 `DailyHrReport` 日志。例如从 2026-07-04 向右滑后，日志出现：

```text
onViewCreated..mCurrentPosition-mCurrentDate:2026-07-03
refreshViewIfNeed:DailyHrReport(time=1783008000, time = 2026-07-03 00:00:00, ...)
```

这一天解析到的报告包含更多桶和值：

```text
restHr=72
avgHr=94
maxHr=138
minHr=68
hrRecords=[TimesDataRecordInt(...), ...]
```

已新增批量抓取脚本：

```powershell
cd <repo>\examples\android-rabi-link-probe
.\scripts\Collect-MiHealthHeartRateBySwipe.ps1 -Serial <adb-serial> -DaysBack 7
```

设计意图：打开小米健康心率页，按天向右滑图表，收集所有出现的 `refreshViewIfNeed:DailyHrReport(...)`，按 `reportStartUnix` 去重后输出多日 JSON/CSV。注意小米健康页面会预加载相邻日期，所以批量脚本不能简单取“最后一条日志”；必须解析所有 `DailyHrReport` 并按日期去重。

当前批量脚本已完成解析逻辑，但一次实测时手机前台被用户切到淘宝指纹验证页，导致脚本抓到 0 条；这不是解析逻辑的有效失败。重新测试时需确保手机前台可以被 Codex 切到小米健康，或者用户暂时不操作手机。

隐藏全记录页也已通过测试 APK 成功启动：

```text
com.xiaomi.fitness.health.hrm.HrmAllRecordsFragment
```

测试 APK 新增入口：

```text
com.rabi.link/.modules.xiaomi.MiHealthFragmentLaunchActivity
```

触发命令：

```powershell
adb -s <adb-serial> shell am start `
  -n com.rabi.link/.modules.xiaomi.MiHealthFragmentLaunchActivity `
  --es fragment com.xiaomi.fitness.health.hrm.HrmAllRecordsFragment
```

日志已确认：

```text
target fragment com.xiaomi.fitness.health.hrm.HrmAllRecordsFragment
AutoPageTrack-Fragment ... HrmAllRecordsFragment
```

但当前手机处于 Dozing/AOD 锁屏状态，`uiautomator dump` 只能看到系统锁屏层。若要从该隐藏页继续抽取精确 `HrItem(time, hr)` 行，需要用户先手动解锁手机，再重新 dump UI 或截图。反编译 `x8d` adapter 已确认列表行显示：

```text
TimeDateUtil.getDateYYYYMMDDHHmmLocalFormat(hrItem.getTime(), false)
quantityString(common_unit_heart_rate_desc, hrItem.getHr())
```

因此解锁后 UI dump 理论上可以直接抽取精确时间和心率文本。

实际打开隐藏全记录页后，页面标题为“全部记录”，但当前显示“暂无数据”。因此它很可能不是连续心率曲线列表，而是手动/点测心率记录列表；连续心率仍以 `DailyHrReport.hrRecords` 为主线。

## BandBurg / AstroBox-NG 调研

用户补充的两个项目已查看：

- `https://github.com/0-2studio/bandburg`
- `https://github.com/AstralSightStudios/AstroBox-NG`

结论：

- BandBurg 是基于 Web Bluetooth + AstroBox-NG WASM 的 Vela 设备管理界面，README 明确是连接和管理 Vela 系列设备，支持设备发现、状态、表盘、快应用和文件安装。
- BandBurg 暴露的 WASM 方法主要是 `miwear_connect`、`miwear_get_data`、`thirdpartyapp_*`、`watchface_*`、`miwear_get_file_type`。
- BandBurg 脚本文档里 `miwear_get_data` 示例只覆盖 `battery`、`storage` 等设备状态，没有发现 `heart` / `hrm` / 历史健康记录读取接口。
- AstroBox-NG README 定位是 Rust/Tauri 可穿戴生态工具箱，聚焦第三方应用安装、调试与分发；代码搜索未发现历史心率或健康记录导出模块。
- AstroBox-NG 的 `scripts/decrypt_companion_device.py` 和 core auth 说明对后续研究 authkey / miwear 连接有价值，但它不能直接绕过小米健康 App 拉历史心率。

因此这两个项目的可借鉴方向是“BLE/authkey/设备管理协议栈”，不是当前最快的历史心率数据源。当前最快可验证路线仍是小米健康页面 `DailyHrReport` 日志侧路。

## 主要工程

Android 探针工程：

```text
examples/android-rabi-link-probe/
```

Vela 快应用探针工程：

```text
examples/rabi-link-vela-probe/
```

Android 工程是当前重点。Vela 工程用于验证“跑在手环上的应用”能力，但官方快应用能力目前未发现第三方心率/睡眠历史读取 API。

## Android APK 能力

APK 包名：

```text
com.rabi.link
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
Download/RabiLinkProbe/mi-health-cloud-*.zip
```

- 完成通知和主界面会显示：

```text
points / dataSources / pages / rawHttp / errors
```

- 主界面提供 `分享云ZIP`，用于把最近一次自动或手动保存的 ZIP 分享出来。

## 构建 APK

在仓库根目录：

```powershell
cd <repo>\examples\android-rabi-link-probe
.\scripts\Export-RabiLinkProbeApk.ps1 -Build
```

输出位于：

```text
examples/android-rabi-link-probe/out/apk/RabiLinkProbe-v<versionName>+<versionCode>-<yyyyMMdd-HHmmss>-debug.apk
```

脚本会同时生成 SHA256 文件。

注意：构建需要本机 Android/Gradle 环境，以及 `examples/android-rabi-link-probe/app/libs/android-fit-20150719.jar`。

## 手机独立测试流程

1. 安装最新版 APK。
2. 打开 `Rabi Link 设备探针`。
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
cd <repo>\examples\android-rabi-link-probe
.\scripts\Collect-MiHealthCloudHeartRate.ps1 `
  -Serial <adb-serial> `
  -InstallApk `
  -AllSdkDataTypes
```

脚本现在直接启动前台服务：

```text
am start-foreground-service -n com.rabi.link/.modules.xiaomi.MiHealthCloudProbeService
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
cd <repo>\examples\android-rabi-link-probe
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

旧状态：上一台电脑上，ADB 连续多轮返回空：

```text
adb devices -l
List of devices attached
```

当前状态：ADB 已连通，且 logcat 侧路已证明能拉到小米健康当天图表心率列表。云端 SDK/OAuth 仍缺少合作方 `app_id` 和 `access_token`，不能复用小米健康私有登录态；Health Connect 读数为空；隐藏全记录页需要用户解锁后继续抽取。

## 不要提交的文件

以下是运行产物或本机数据，不应提交：

- `examples/android-rabi-link-probe/out/`
- `examples/android-rabi-link-probe/build/`
- `examples/android-rabi-link-probe/app/build/`
- `examples/android-rabi-link-probe/.gradle/`
- `examples/android-rabi-link-probe/signing/`
- `examples/android-rabi-link-probe/mi-health-*.json`
- `examples/android-rabi-link-probe/mi-health-*.md`
- `examples/rabi-link-vela-probe/node_modules/`
- `examples/rabi-link-vela-probe/build/`
- `examples/rabi-link-vela-probe/dist/`
- `examples/rabi-link-vela-probe/*.log`

这些规则已经写入 `.gitignore`。
