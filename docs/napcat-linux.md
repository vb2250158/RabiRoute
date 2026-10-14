<!-- docs-language-switch -->
<div align="center">
<a href="./napcat-linux_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Linux 上的 NapCat（QQ）

Windows 行为不变（OneKey / `napcat.bat` / `NapCatWinBootMain.exe`）。Linux 支持两种模式：

## 模式 A：连接外部 NapCat（推荐，含 Docker）

NapCat 由 Docker、systemd 或其他主机运行，RabiRoute 只连接，不负责启动。实例配置**不填写 `launchCommand`**，只填地址与 token：

```json
{
  "id": "qq-bot",
  "gatewayPort": 8789,
  "httpUrl": "http://127.0.0.1:3000",
  "webuiUrl": "http://127.0.0.1:6099/webui",
  "accessToken": "<与 NapCat 网络配置一致的 token>",
  "botUserId": "<机器人 QQ 号>"
}
```

1. 复制 [`examples/linux/napcat-docker-compose.yml`](../examples/linux/napcat-docker-compose.yml)，按需修改 UID/GID，`docker compose up -d`。
2. 打开 WebUI（默认 `http://127.0.0.1:6099/webui`，首次 WebUI token 见 `docker compose logs napcat`）扫码登录。
3. 在 NapCat 网络配置中：
   - 启用 **HTTP Server**，端口 3000，设置 token；
   - 添加 **WebSocket Client**，地址 `ws://host.docker.internal:<gatewayPort>`（宿主机网络模式下用 `ws://127.0.0.1:<gatewayPort>`），token 同上。
4. RabiRoute 填入上面的 `httpUrl` / `webuiUrl` / `accessToken`。非本机地址未填 token 时会给出警告。

## 模式 B：本机 Linux QQ + NapCat.Shell

使用 NapCat 官方 Linux 安装脚本安装后，QQ 位于 `/opt/QQ/qq` 或 `~/Napcat/opt/QQ/qq`，NapCat 位于 `<QQ 根>/resources/app/app_launcher/napcat`。实例配置：

- `launchCommand`: QQ 可执行文件路径，如 `/opt/QQ/qq`
- `workingDir`: QQ 根目录，如 `/opt/QQ`（用于定位 `resources/app/app_launcher/napcat/config`）
- `botUserId`: 机器人 QQ 号

启动时 RabiRoute 自动：

- 追加 `--no-sandbox`，有 `botUserId` 时追加 `-q <QQ号>` 快速登录；
- 没有图形显示（`DISPLAY` / `WAYLAND_DISPLAY`）时用 `xvfb-run -a` 包裹；找不到 `xvfb-run` 会给出警告；
- 进程探测改为读取 `/proc`（QQ 与命令行含 napcat 的进程）。

`launchCommand` 不是 `qq` 时（例如自定义脚本）原样执行，不做改写。

## 限制

- Linux 下不会自动下载/解压 NapCat 模板，请先用官方脚本或 Docker 安装。
- 首次登录需人工扫码；RabiRoute 不代为登录 QQ。
- 本机启动模式依赖 Linux QQ 与 xvfb，请在真机验证。
