<!-- docs-language-switch -->
<div align="center">
<a href="./README.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute

![RabiRoute 看板娘展示消息进入、规则分流、Agent 处理和受控回传](assets/rabiroute-hero-oss.webp)

<h2 align="center">让 Agent 连接我们的一切。</h2>

<p align="center">把聊天、语音、定时任务和设备消息交给合适的 Agent，并保留清楚的上下文、权限边界和投递记录。</p>

<p align="center">
  <a href="https://github.com/vb2250158/RabiRoute/commits/main"><img alt="最近提交" src="https://img.shields.io/github/last-commit/vb2250158/RabiRoute?color=19bfc1"></a>
  <a href="https://github.com/vb2250158/RabiRoute/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/vb2250158/RabiRoute?style=flat&color=ff7eae"></a>
  <a href="./LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-f2c744"></a>
  <img alt="Node.js 20 或更高版本" src="https://img.shields.io/badge/Node.js-20%2B-3c873a">
  <img alt="当前版本：0.2.1" src="https://img.shields.io/badge/version-0.2.1-3178c6">
  <img alt="状态：积极开发中" src="https://img.shields.io/badge/status-active%20development-19bfc1">
</p>

RabiRoute 是一个与具体 Agent 解耦的**消息网关、发送规则管理器和动作安全门**。它接收 QQ、Webhook、定时任务、语音、桌面操作和设备消息，再按消息路线（Route）把内容交给指定的 Agent 或程序。

Agent 负责回答、写代码、调用工具和执行任务。RabiRoute 负责消息从哪里来、交给谁、附带哪些最近消息、能否向外回复，以及结果和回执保存在哪里。

[快速上手](#快速上手) · [当前能力](#当前能力) · [近期变化](#近期变化) · [工作方式](#工作方式) · [文档](#文档入口)

## 适合做什么

- **把聊天交给 Agent。** QQ 群聊、私聊、角色面板和其他消息入口可以按 Route 进入固定项目和固定任务。
- **让 Agent 定时工作。** 人格规则可以按间隔、时间窗口、每天指定时间或单次时间触发 Agent，也可以运行明确授权的本机脚本。
- **保留连续上下文。** 每个人格拥有自己的消息记录、计划、记忆和技能引用；每条 Route 可以限制自动附带的最近消息。
- **控制外部发送。** Agent 必须通过统一发送接口回复 QQ、RabiLink 等外部渠道；目标、引用消息、发送者身份和回执会被校验并记录。
- **从 Windows 桌面投递文字和图片。** RabiRoute Desktop 支持滑词操作、系统截图、标注、复制、贴图和投递给已启用人格。
- **连接语音和移动设备。** RabiSpeech、RabiLink 手机/眼镜、穿戴设备与远程 Relay 已有实现，但仍按实验集成验收。

## 快速上手

### Windows 安装包

从 [GitHub Releases](https://github.com/vb2250158/RabiRoute/releases/latest) 下载 `RabiRoute-<版本>-windows-x64-setup.exe`。安装包包含 RabiRoute Desktop、本机 Manager、RibiWebGUI、Node.js 和生产依赖。

发布页同时提供便携 ZIP 和 `SHA256SUMS.txt`。当前 Windows 包尚未签名，遇到 SmartScreen“未知发布者”提示时先核对校验和。

### 从源码运行

需要 Node.js 20 或更高版本，以及 npm。

```bash
git clone https://github.com/vb2250158/RabiRoute.git
cd RabiRoute
npm install
npm run build
npm run start:manager
```

打开 [http://127.0.0.1:8790/](http://127.0.0.1:8790/)。首次启动且没有本机运行数据时，Manager 会从 `examples/data/` 创建脱敏示例配置。

### 跑通第一条 Route

1. 打开**快速配置**，选择“定时触发”。
2. 选择 **Codex Agent**，绑定项目目录和一个已经存在的 Codex/ChatGPT Desktop 任务。
3. 保存 Route，在**日志诊断**中执行一次手动触发。
4. 确认触发成功，并且同一个 Desktop 任务出现了 RabiRoute 消息。

这次手动触发会执行真实投递。完整步骤和失败检查见[跑通第一条 Route](docs/user-guide/first-route.md)。

## 当前能力

仓库当前版本为 `0.2.1`。下面只列代码、配置入口和测试能够支持的范围；需要账号、外部服务或真机的功能仍要在对应环境验收。

| 范围 | 当前状态 | 用户可以完成什么 |
| --- | --- | --- |
| 路由主链 | 已验证 | 接收消息、保存事件、匹配规则、生成 Agent 上下文、投递处理端并记录回传。 |
| NapCat / OneBot | 已验证 | 接收 QQ 群聊和私聊，保存图片与合并转发证据，通过 OneBot HTTP 发送回复。 |
| 定时任务与人格自动化 | 已验证 | 按消息或时间触发 Agent；在单独授权后运行人格目录中的本机脚本。 |
| Codex Desktop | 已验证 | 按完整任务 ID 和项目目录投递；只有目标任务写入 `deliveryId` 回执后才报告成功。任务删除或归档后可受控换新。 |
| RibiWebGUI | 已验证 | 管理 Route、人格、消息端、Agent、计划、记忆、日志、诊断、主题和桌面设置。 |
| 计划、记忆与消息处理 | 已验证 | 分页查看计划和记忆，提交计划反馈，分配消息处理任务，并保存处理状态和回执。 |
| Windows 桌面 | 主链已实现 | 统一启动 Manager 与桌面界面；提供滑词、截图和截图标注。部分系统交互仍需 Windows 实机复测。 |
| DSH | 实验支持 | 作为主人格或辅助处理端使用明确的 API、项目目录和会话绑定。 |
| RabiSpeech / RabiLink / 移动与穿戴设备 | 实验支持 | 接入语音、手机、眼镜、Relay 和健康数据链路；每条链路按设备与网络环境单独验收。 |
| 局域网 Rabi Agent | 实验支持 | 其他电脑运行无界面工作进程，连接 Manager，并把任务交给该电脑上指定的 Codex Desktop 任务。真实多电脑验收待完成。 |

完整状态、限制和事实源见[当前能力与成熟度](docs/current-capabilities.md)。

## 近期变化

### 0.2.1：计划读取和本机运行改进

- 每个计划使用独立目录保存正文、历史、反馈和附件，归档时移动整个目录。
- 计划与记忆页面先加载当前可见内容，再按需读取后续页面，减少首屏等待和 Manager 磁盘压力。
- RabiSpeech 的大文件读取、性能统计和人格同步索引移出 Manager 主请求路径。
- Windows 桌面截图增加选区调整、矩形、箭头、文字、颜色和撤销。

### 未发布：投递、插件和 WebGUI 恢复能力

- Codex Desktop 投递增加 `deliveryId` 写入确认；IPC 接收但目标任务没有回执时会重试或明确失败。
- Codex 任务显示名称改为读取 Desktop 左侧栏共用索引，任务 ID 与项目目录继续作为投递身份。
- Manager 插件由版本化 Profile 和 Bundle 管理；修改后按 revision 排空旧请求、切换新实例，失败时恢复上一可用版本。
- Web Bundle 使用不可变 revision 地址，页面、脚本、样式和字体从同一版本目录加载；浏览器收到插件目录变化后替换对应模块。
- WebGUI 先显示固定界面，再在后台读取插件目录和知识内容；消息看板过期正文会被删除，只保留限期重放去重键。

逐项记录和迁移说明见[版本更新日志](版本更新日志.md)。

## 工作方式

```mermaid
flowchart LR
    A[聊天 · 定时任务 · 语音 · 设备] --> B[消息入口]
    B --> C[事件记录]
    C --> D[Route 规则]
    D --> E[上下文与附件]
    E --> F[Agent 或程序]
    F --> G[发送规则与动作安全门]
    G --> H[回复 · 回执 · 审计]
```

每条 Route 分开保存消息入口、人格、处理端、项目目录和发送规则。消息端不负责拼接 Agent 指令，Agent 也不能绕过 RabiRoute 直接取得渠道凭据或修改路由状态。

Manager 当前通过 `rabi.manager.base@0.2.1` Bundle 提供 26 个内置插件实例。插件声明依赖和界面贡献；Manager 负责启停、依赖检查、路由撤销、请求排空和失败恢复。当前实现说明见[插件 Bundle 与热替换](docs/plugin-bundles.md)。

## Agent 与安全边界

- Codex 的真实消息只通过 Desktop IPC 交给选定的 Codex/ChatGPT Desktop 任务 owner。
- 目标 Desktop 任务拥有自己的模型、工具、沙箱和审批；RabiRoute 不替它执行推理。
- 项目锁定的 `codex app-server` 只用于创建或命名空任务，不执行 Route 消息。
- Desktop 不可用、任务无法加载、项目目录不一致或 owner 不明确时，投递失败并保留错误记录。
- 平台账号、登录状态和凭据仍由对应平台拥有。
- 本机 `data/`、日志、录音、转录文本、token、Cookie 和私有路径不进入公开仓库。

RabiRoute 当前没有通用 Action Queue、统一审批中心或无副作用的 Route 预览界面。手机、眼镜、穿戴设备和多电脑 Agent 的生产闭环仍按实验功能管理。

## 配置和数据

```text
data/route/<configName>/adapterConfig.json
data/roles/<RoleId>/persona.md
data/roles/<RoleId>/personaConfig.json
```

- `adapterConfig.json` 保存消息入口、处理端、项目目录、Route 规则和人格绑定。
- `persona.md` 保存人格说明和面向处理端的工作要求。
- `personaConfig.json` 保存人格自动化、头像、语音关键词和最近消息额度。
- `data/roles/<RoleId>/conversation/` 保存该人格的消息记录。
- [`examples/data/`](examples/data/) 保存可公开复制的脱敏样板。

可独立构建的客户端位于 [`apps/`](apps/)，共享 SDK 位于 [`packages/`](packages/)，可复用 Agent 指南位于 [`skills/`](skills/)。

## 文档入口

### 第一次使用

- [跑通第一条 Route](docs/user-guide/first-route.md)：完成一次真实 Codex Desktop 投递。
- [RibiWebGUI 使用手册](docs/user-guide/README.md)：查看界面、人格、Route、Agent 和排障步骤。
- [界面与运行状态](docs/user-guide/interface-and-status.md)：判断 Manager、Route 和消息端是否正常。
- [运行、日志与排障](docs/user-guide/operations-and-troubleshooting.md)：按现象定位失败位置。

### 安装和接入

- [配置说明](docs/configuration.md)：查看本机配置、目录和主要参数。
- [局域网 Rabi Agent](docs/lan-rabi-agent-bootstrap.md)：接入其他电脑上的无界面 Codex 工作进程。
- [RabiSpeech](docs/rabispeech-plugin.md)：配置本机或远端 TTS / ASR。
- [客户端应用](apps/README.md)：构建 Android、Rokid AIUI、浏览器桥和 Rabi Agent。

### 开发和维护

- [当前能力与成熟度](docs/current-capabilities.md)：核对功能是否已验证。
- [文档索引](docs/README.md)：浏览现行、实验、设计和历史资料。
- [架构说明](docs/architecture.md)：理解产品边界和数据流。
- [项目功能手册](docs/project-function-map.md)：查找功能拥有者、API 和代码入口。
- [版本更新日志](版本更新日志.md)：查看版本变化和迁移要求。

## 开发

```bash
npm run manager          # 直接运行 TypeScript Manager
npm run webgui:dev       # 运行 Vue/Vuetify 前端
npm run test             # 运行后端与契约测试
npm run build            # 构建 Manager 与 WebGUI，并同步基础 Web Bundle
npm run check:config     # 检查公开和运行期 JSON 文本
```

提交公开内容前，删除真实账号标识、聊天内容、token、Cookie、本机用户名、私有路径和运行期 `data/`。

## 许可证

RabiRoute 使用 [MIT 许可证](LICENSE)开源。
