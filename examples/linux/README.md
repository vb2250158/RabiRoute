<!-- docs-language-switch -->
<div align="center">
<a href="./README_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# Linux 示例

可选样板，不由启动脚本安装或启用。

| 文件 | 用途 |
| --- | --- |
| [`rabiroute-host.service`](./rabiroute-host.service) | 当前用户 systemd 单元草稿：用 `--foreground`、绝对路径和 `KillMode=control-group` 运行已有构建的 Linux Host。复制后必须改成你的仓库路径、Node 路径和状态根。 |
| [`napcat-docker-compose.yml`](./napcat-docker-compose.yml) | NapCat Docker 无头示例（`mlikiowa/napcat-docker`），端口只绑定 127.0.0.1。用法与 RabiRoute 配置见 [Linux 上的 NapCat](../../docs/napcat-linux.md)。 |

日常开发仍用仓库根目录的 `Start-RabiRoute-FromSource.sh` 或 `npm run start:linux`。完整命令与安全边界见 [Linux Host](../../docs/linux-host.md)。
