<!-- docs-language-switch -->
<div align="center">
<a href="./rabilink-wearable-health_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiLink 智能手表 / 手环健康消息端

> 状态：**实验集成，真机主链路已闭环**。结构化健康时间线、Manager 查询 API、阈值告警路由、RibiWebGUI 消息端配置、Android 配置页、Health Connect 和 PC ADB Companion 均已实现。小米真机已由手机端配置驱动，持续读取本地 Provider 的最近心率、睡眠日报和睡眠阶段，并写入可查询时间线。小米运动健康仍未向该机的 Health Connect 写入数据；无需 ADB、会争用官方 App 连接的 MiWear SPP 直连仍未作为默认采集器。

## 边界

RabiRoute 保存归一化健康时间线、执行告警规则并给 Agent 提供查询接口。RabiLink 手机端保存设备侧配置、读取系统健康数据并经 Relay 上报。手表认证秘钥只保存在 Android Keystore 加密的本机配置中，不进入 Relay、日志、健康时间线或 Agent 上下文。

```text
手表 / 手环
  -> 手机 Health Connect（移动端原生来源）
     或手机配置 -> PC ADB Companion -> 小米健康本地 Provider（当前真机来源）
  -> RabiLink Relay，或可信本机 Manager observation
  -> wearable 消息端
  -> data/roles/<RoleId>/wearable-health/events/YYYY-MM-DD.jsonl
  -> 心率高/低阈值、冷却与睡眠状态变化规则
  -> wearable_health_alert
  -> Agent

Agent / 主动智能
  -> Manager 本机健康 API
  -> 当前心率、睡眠状态、历史和 24 小时摘要
```

健康观测不会写进普通聊天账本，也不会让每个常规样本唤醒 Agent；只有命中规则的告警才进入 Agent 路由。

## 启用消息端

在 RibiWebGUI 的 Route 配置中添加“智能手表 / 手环”消息端。配置文件等价项如下：

```json
{
  "messageAdapters": ["rolePanel", "rabilink", "wearable"],
  "messageAdapterPolicies": {
    "wearable": {
      "inputEnabled": true,
      "outputEnabled": false,
      "supportedOutputs": ["text"]
    }
  }
}
```

人格规则应启用 `wearable_health_alert`。当前示例位于 `examples/data/route/RabiLink/adapterConfig.json` 与 `examples/data/roles/RabiActive/personaConfig.json`。

## 手机配置

安装 `apps/rabilink-android` 构建的单一手机 APK，先在首页配置 RabiLink Relay，再进入“智能手表 / 手环”：

1. 设置设备名称、稳定设备 ID 和设备类别。
2. 选择采集来源：`Health Connect` 或“小米运动健康（PC ADB Companion）”，再设置同步间隔与回看时间。
3. 设置心率高/低阈值、告警冷却和睡眠状态变化告警。
4. 打开 Health Connect 权限页，授权心率与睡眠读取。
5. 如已取得小米认证秘钥，可在密码框保存；它经 Android Keystore AES-GCM 加密，只为后续厂商直连采集器保留，当前不会上传。
6. 保存并启动，或点“立即同步”。Health Connect 使用手机前台服务；ADB Companion 模式由已配对的 Rabi PC 常驻任务读取同一份手机配置。

Health Connect 没有数据时不会制造样本。手机端不再常驻轮询 Health Connect；只在用户手动同步、启动恢复或后续平台/设备事件到达时读取一次回看窗口。当前已验证手机选择 ADB Companion 后，电脑会把手机上的启用开关、稳定设备 ID、名称、类别、事件触发回看窗口和告警规则作为配置真源；电脑不读取 Keystore 密钥。

## 小米 ADB Companion

已开启 USB 调试时，Companion 使用小米健康本地 Provider 的最新心率、当日睡眠日报和睡眠阶段。脚本会归一化出心率、睡眠会话、阶段和可证明的当前睡/醒状态；默认只显示 dry-run，真实读取必须显式传入 `-Execute`：

```powershell
.\apps\rabilink-android\scripts\Sync-MiHealthWearableToRabiLink.ps1

.\apps\rabilink-android\scripts\Sync-MiHealthWearableToRabiLink.ps1 `
  -Execute `
  -Continuous `
  -Transport Manager `
  -UseMobileSettings:$true
```

`Auto` 模式优先使用已配置 Relay，没有 Relay 时退回可信本机 Manager；Manager 模式可在 `POST observations?deliverAlerts=true` 时走相同的 Agent 告警路由。脚本不会输出 token，也不读取手表认证秘钥。该路线已在小米真机验证最近心率、睡眠会话、9 段睡眠阶段、当前睡/醒状态、去重写入和查询 API。它仍不是全天心率曲线接口，并且要求手机持续通过 ADB 连接电脑。

登录后常驻可安装当前用户计划任务；脚本默认 dry-run，只有 `-Execute` 才修改任务：

```powershell
.\apps\rabilink-android\scripts\Install-RabiLinkWearableCompanionTask.ps1

.\apps\rabilink-android\scripts\Install-RabiLinkWearableCompanionTask.ps1 `
  -Execute -StartNow -RoleId YeYu
```

任务名为 `RabiLinkWearableHealthCompanion`。它在登录时隐藏启动、断线后自动重试，并把仅含计数和状态的脱敏日志写进已忽略的 `out/private/`。手机端关闭“持续健康记录”即可阻止采集；卸载任务需显式执行安装脚本的 `-Uninstall -Execute`。

健康阈值告警使用独立的 `wearable` 消息端路由交给 Agent，避免为了健康采集启动 QQ、FenneNote 等无关消息端。首次配置可先检查，再显式执行：

```powershell
node scripts/configure-wearable-health-route.mjs
node scripts/configure-wearable-health-route.mjs --execute
```

脚本只从既有夜雨路由复制 Agent 绑定所需的非密钥字段，修改前会把私有人格规则和既有健康路由备份到忽略提交的 `data/` 下。

## Agent 查询 API

Manager 默认只应在可信本机访问：

```text
GET   /api/roles/:roleId/health
GET   /api/roles/:roleId/health/state
GET   /api/roles/:roleId/health/history
GET   /api/roles/:roleId/health/summary
GET   /api/roles/:roleId/health/config
PATCH /api/roles/:roleId/health/config
POST  /api/roles/:roleId/health/observations[?deliverAlerts=true]
```

历史查询支持 `metric`、`from`、`to`、`sourceDeviceId`、`limit` 和 `order=asc|desc`。例：

```text
GET /api/roles/YeYu/health/history?metric=heart_rate&from=2026-07-18T00:00:00%2B08:00&limit=100&order=desc
GET /api/roles/YeYu/health/state
GET /api/roles/YeYu/health/summary
```

`state` 会返回当前睡眠判断及 `stale` 标记。Agent 不应把过期心率、睡眠 `unknown` 或仅有历史睡眠区间解释成实时医学结论。

直接调用 Manager 的 `POST observations` 会持久化并返回本次规则结果，适合本机受信集成；显式传入 `deliverAlerts=true` 时，命中的规则也会形成 `wearable_health_alert` 并投递到 URL 中角色对应的 Route。Relay + `wearable` 消息端保留同样行为。

## 数据与隐私

- 事件按角色写入 `wearable-health/events/YYYY-MM-DD.jsonl`，状态与设备规则写在同目录 JSON 文件中。
- 输入会丢弃名称包含 `auth`、`token`、`secret`、`key`、`password`、`cookie` 等敏感字段的元数据。
- 样本按稳定 ID/内容指纹去重；心率告警按设备和规则执行冷却。
- 当前没有自动保留期或远端删除协议。对外开放 Manager、备份角色目录或清理健康数据都需要单独的隐私决策。
- 心率与睡眠用于辅助陪伴和主动智能，不构成医疗诊断；异常或持续不适应由用户自行决定是否寻求专业帮助。

## 验收口径

完成某一真实设备的验收至少需要：手机/桥产生真实样本、Relay 接收结构化 observation、角色目录出现去重后的事件、历史与状态 API 可查询、阈值命中只产生一次冷却内告警、Agent 收到告警，以及秘钥/token 未出现在日志和健康文件中。
