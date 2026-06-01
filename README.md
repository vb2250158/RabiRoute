# NapCatQClawGateway

NapCat 到 QClaw (OpenClaw) 的 QQ 消息网关。接收 NapCat 的 OneBot QQ 消息，调用 QClaw Gateway 的 Chat Completions API 生成智能回复，然后通过 NapCat HTTP API 发送回 QQ。

## 架构

```
QQ 消息 → NapCat (OneBot) → WebSocket → NapCatQClawGateway → QClaw API → 智能回复 → NapCat HTTP → QQ
```

## 前置条件

- Node.js 18+
- [NapCat](https://napneko.github.io/) 已部署运行
- [QClaw (OpenClaw)](https://docs.openclaw.ai/) Gateway 已启动

## 快速开始

```powershell
cd NapCatQClawGateway
npm install
npm run build

# 配置环境变量
copy .env.example .env
# 编辑 .env，填入 QCLAW_GATEWAY_TOKEN

# 配置网关
copy gateways.example.json gateways.json

# 启动网关管理器
npm run start:manager
```

默认端口：

- 网关管理器（WebUI）：`http://127.0.0.1:8790`
- NapCat 反向 WebSocket 地址：`ws://127.0.0.1:8789`
- QClaw Gateway API：`http://127.0.0.1:10978`
- NapCat HTTP API 地址：`http://127.0.0.1:3000`

## NapCat 网络配置

在 NapCat WebUI 里配置：

- WebSocket 客户端 → 连接地址 `ws://127.0.0.1:8789`
- HTTP 服务器 → 主机 `127.0.0.1`，端口 `3000`

## 安装 NapCat 插件

把 `napcat-plugin-qclaw-gateway` 目录复制到 NapCat 插件目录：

```text
NapCat.*/resources/app/napcat/plugins/napcat-plugin-qclaw-gateway
```

在 NapCat 插件管理里启用该插件，即可通过插件页面管理多个网关。

## 群消息路由

- 直接 @：当前消息本身直接 @ 机器人 → 调用 QClaw AI 回复
- 直接回复：直接回复机器人消息 → 调用 QClaw AI 回复
- 间接回复：回复了一条曾经 @ 过机器人的消息 → 调用 QClaw AI 回复

内置命令（本地处理，不走 AI）：

- `/ping` — 检查在线状态
- `/echo 文本` — 复读
- `/查 关键词` — 搜索已记录的消息
- `/总结今天` — 显示今日消息摘要

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `QCLAW_GATEWAY_URL` | `http://127.0.0.1:10978` | QClaw Gateway 地址 |
| `QCLAW_GATEWAY_TOKEN` | - | QClaw Gateway 认证 Token |
| `QCLAW_MODEL` | `qclaw/pool-deepseek-v4-pro` | 使用的模型 ID |
| `NAPCAT_HTTP_URL` | `http://127.0.0.1:3000` | NapCat HTTP API 地址 |
| `GATEWAY_PORT` | `8789` | 网关 WebSocket 端口 |
| `BOT_NICKNAME` | `胖虎助手` | 机器人昵称 |
| `TARGET_GROUP_ID` | - | 目标群号，留空监听所有群 |
| `DATA_DIR` | `./data` | 数据目录 |

## 开发

```powershell
npm run dev          # 运行单个网关（需要 .env 配置）
npm run manager      # 运行网关管理器
npm run build        # 编译 TypeScript
npm run start:manager # 生产模式启动管理器
```
