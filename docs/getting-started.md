<!-- docs-language-switch -->
<div align="center">
<a href="./getting-started_en.md">English</a> | 简体中文 | <a href="./getting-started_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# 快速上手

> 状态：现行指南。已按当前 Manager、RibiWebGUI、Codex Desktop owner 和 NapCat 配置流程核对。

跑通 RabiRoute 只有四步，主要时间花在首次构建下载依赖上：

1. **安装** —— Windows 一键，或 Linux 一行命令。
2. **配置角色** —— 建一个角色，作为这条路由的归属。
3. **配置消息端** —— 接 QQ（NapCat），或只用定时触发。
4. **配置 Agent 端** —— 绑定处理端（Codex 或 DSH）。

完成后用「投递测试」验证。下面按这四步走。

## 第 1 步：安装

**Windows（推荐）**：安装 [Windows 安装包](https://github.com/vb2250158/RabiRoute/releases)，从开始菜单启动 RabiRoute Host，再从托盘打开 RibiWebGUI。需要跑当前源码时，双击仓库根目录的 `Start-RabiRoute-FromSource.bat`：它会自动构建 Manager、WebGUI、插件、Host 和托盘，通过 Host 切换过去，并沿用安装版的配置和数据。

只需要 Node.js 22.13+ 和 .NET 9 SDK。首次构建的 Python / Qt / NuGet 依赖会由脚本自动下载，**不需要手工安装或配置**。手工拼这套工具链既慢又容易出错，普通用户不必走这条路。

失败日志在 `logs/source-start/`；依赖锁文件与安装版不一致时先更新完整安装包。关闭命令窗口不会退出 Host，退出应用请用托盘。

**Linux**：安装 Node.js 22.13+、npm 和 util-linux `flock`（要用 Host `open` 时另需 `xdg-utils`），然后：

```bash
cd /path/to/RabiRoute
bash Start-RabiRoute-FromSource.sh
npm run status:linux -- --json
node scripts/linux-host.mjs --command open
```

打开 Host 返回的实际地址。Linux Host 不含 Windows 托盘、截图和全局快捷键，详见 [Linux Host](linux-host.md)。

**纯后端开发（无托盘）**：

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

Manager 会在标准输出打印实际地址（如 `RabiRoute manager listening at <managerBaseUrl>`）。打开这次输出的 `<managerBaseUrl>`，不要把端口保存成永久默认值。

## 第 2 步：配置角色

在 RibiWebGUI 左下角「新建角色」，填角色名与角色 ID，创建后进入「角色配置」。普通陪伴示例用 `Rabi`；眼镜 record-first 示例用配套角色。

首次可写启动时，如果没有 `data/route` 和 `data/roles`，Manager 会优先复制整包 `examples/data`；只有 `main` 默认启用。需要手动复制时：

```powershell
xcopy examples\data data /E /I
```

## 第 3 步：配置消息端

在「角色配置 → 消息连接器」添加消息端。接 QQ 时选 NapCat / OneBot，并配好：

- WebSocket 客户端：`ws://127.0.0.1:8789`（收消息事件）
- HTTP 服务器：`127.0.0.1:3000`（主动发消息和调 OneBot API）

只想本地跑定时任务时可以不接 NapCat。账号登录与无值守恢复属于 NapCat / QQNT 侧，见 [NapCat 无值守与登录稳定性](napcat-unattended.md)。

## 第 4 步：配置 Agent 端

在同一页「Agent 端」添加处理端并设为「主控 Agent」：

- **Agent 配置**：选 Codex（默认已验证）或 DSH。
- **Agent 会话**：选「任务名 + 最后会话时间」里的已有任务；输入新名称会在保存时创建新任务。
- **Agent 工作目录**：选或填项目绝对路径。

用 Codex 时，投递期间 Codex/ChatGPT Desktop 必须已打开，RabiRoute 通过 Desktop IPC 复用目标任务。用 DSH 时，还需绑定一个 DSH 会话作为处理端；配置方法见 [角色会话与 Agent 端](user-guide/agents-and-sessions.md)。

确认无误后点顶栏「保存」，等待「有未保存的修改」消失。

## 验证：投递测试

在消息路由上点「通道检查」，再在 Agent 节点点「投递测试」——它会发一条带编号的真实消息。确认页面显示成功，并到目标 Agent 里核对收到了同一条消息。配置保存和通道状态读取本身不代表投递成功。

需要定时触发时，在「角色配置 → 自动化 → 消息规则」配置规则，再到「日志诊断」用「手动触发」验证。

## 更多

- 完整四步教程（含截图）：[跑通第一条 Route](user-guide/first-route.md)
- 路由与消息端细节：[路由与适配端](user-guide/routes-and-adapters.md)
- Agent 端与会话：[角色会话与 Agent 端](user-guide/agents-and-sessions.md)
- 手动写 `personaConfig.json`：[路由配置](routing-configuration.md)
- 手工从零构建（仅无安装包时）：[Windows 桌面启动与完整打包](windows-launcher-and-packaging.md)
- Windows 中文消息编码注意：[常见问题与支持](user-guide/faq-and-support.md)

源码入口：`src/manager.ts`（配置、路由进程、RibiWebGUI API）、`src/index.ts`（单个 gateway）、`src/adapters/`（消息适配端）、`src/plugins/io.rabiroute.endpoint.rabilink/src/forwarding.ts`（规则与投递）、`src/history.ts`（JSONL 记录）。
