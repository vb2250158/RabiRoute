<!-- docs-language-switch -->
<div align="center">
<a href="./routes-and-adapters_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Route 与消息端

一条 Route 是一套可独立启停的消息流配置。它把消息入口、处理端、工作目录、人格绑定和回传意图组合在一起。

```text
消息端 -> Route 规则 -> 人格与上下文 -> Agent 处理端 -> Outbox / 回复
```

## 什么时候新建 Route

下面情况适合拆成不同 Route：

- 消息来自不同平台或账号。
- 需要投递到不同项目或 Desktop 任务。
- 使用不同人格或规则集合。
- 回传策略、允许的消息类型或文件目录不同。
- 需要单独启停、观察和排障。

多个 Route 可以复用同一个人格。不要只因为消息入口不同就复制一份人格目录。

## 消息端成熟度

| 消息端 | 状态 | 适合用途 | 额外依赖 |
| --- | --- | --- | --- |
| 定时触发 | 已验证 | 周期巡检和首次闭环 | 无外部账号 |
| 角色面板 | 已验证 | 托盘和本地角色消息 | Manager / 托盘入口 |
| NapCat / OneBot | 已验证 | QQ 群聊和私聊 | NapCat、QQNT、OneBot 配置 |
| 企业微信 / WeCom | 实验 | 企业微信群聊 | Bot ID、Secret、真实环境验收 |
| 远端 Agent | 实验 | 连接独立 bridge 设备 | 远端 bridge 和密码挑战 |
| FenneNote / 小爱 | 实验 | 语音转写 | 对应桥接程序或设备 |
| RabiLink | 实验 | Relay、眼镜和主动下行 | Relay 配置和真机验收 |
| 通用 Webhook | 实验 | 没有专用适配器的 POST | 外部系统和回调网络 |

“已验证”表示项目内实现、配置和契约测试完整；外部账号、网络、设备和平台风控仍可能影响运行。

## 添加消息端

打开“消息适配器”，在“消息端”区域点击添加入口。目录按本地桌面、实时消息、远端设备、内部触发、语音转写和外部接口分组。

每个消息端会显示成熟度、连接状态、依赖检查和自己的配置面板。先让一个入口稳定，再增加第二个。

<div class="screenshot-placeholder">
  <strong>截图占位 07｜消息端目录与成熟度</strong>
  <span>建议画面：添加消息端目录展开，显示分组、入口名称、成熟度和连接标签。</span>
  <span>标注重点：已验证、实验、连接状态、添加按钮。</span>
</div>

## 接收与回传是两个开关

消息端 policy 会区分：

- **接收消息**：RabiRoute 是否允许这个入口产生事件。
- **允许回传/代发**：Agent 是否可以通过 RabiRoute 的 Outbox 向该平台发送。
- **支持的输出类型**：例如文本、图片、语音和文件。
- **本地文件白名单**：允许上传文件时，限定可读目录。

关闭接收不会删除历史数据。关闭回传也不会阻止处理端在自己的任务里产出结果，只会阻止对应外部发送。

## QQ / NapCat 最小配置

NapCat 通过两条连接与 RabiRoute 协作：

- WebSocket Client：把 QQ 事件送到 RabiRoute，常用地址为 `ws://127.0.0.1:8789`。
- OneBot HTTP Server：供状态查询和回复，常用地址为 `http://127.0.0.1:3000`。

在 Route 的 NapCat 面板中确认实例、RabiRoute WS 端口、HTTP 地址和 WebUI 地址。扫描只读取状态；启动、登录和修复只会在明确点击相关按钮后执行。

<div class="screenshot-placeholder">
  <strong>截图占位 08｜NapCat 实例与连接状态</strong>
  <span>建议画面：一个已配置 QQ 实例，实例卡片、WS、HTTP、账号状态和“打开 NapCat”按钮可见。</span>
  <span>标注重点：实例账号、WS 端口、HTTP 地址、登录状态、扫描与打开动作。</span>
</div>

RabiRoute 不保存或绕过 QQ 密码、验证码、设备确认和风控。首次登录与异常验证必须在 NapCat / QQNT 中完成。

完整恢复流程见 [NapCat 无值守与登录稳定性](../napcat-unattended.md)。

## 定时触发

启用“定时触发”后，还需要在人格规则中配置 `heartbeat` 的触发计划。计划支持间隔、每天指定时间和一次性指定时间。

“会话工作中时跳过心跳”只影响固定 Codex 任务仍忙碌时的 heartbeat。它不会丢弃 QQ、私聊或其他实时消息。

## Webhook 和命名适配器

已存在专用适配器的平台应优先使用专用入口。它们通常能保留更准确的状态、日志、模板变量和回传语义。

通用 Webhook 适合尚未命名的外部 POST。公开配置只应使用 localhost、占位域名和脱敏 token。

需要在原生灵珠智能体、AIUI 和原生 App 之间选择时，查看 [RabiLink 眼镜端三条路线对比](../rabilink-glasses-route-comparison.md)。

## 保存和生效

添加、删除、启停或修改消息端后，点击顶栏“保存配置”。Manager 可能同步配置或重载当前 Route。

保存后到“日志诊断”确认运行状态。外部入口还要在平台侧检查连接，例如 NapCat WebSocket、WeCom 鉴权或 Relay 在线状态。

## 接下来阅读

- 选择处理端和任务：[Agent、项目与任务](agents-and-sessions.md)。
- 决定什么消息会命中：[人格与消息规则](personas-and-rules.md)。
- 消息进入但没投递：[运行、日志与排障](operations-and-troubleshooting.md)。
