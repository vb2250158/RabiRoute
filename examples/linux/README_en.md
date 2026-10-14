<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Linux examples

Optional templates. The startup script does not install or enable them.

| File | Purpose |
| --- | --- |
| [`rabiroute-host.service`](./rabiroute-host.service) | Draft current-user systemd unit that runs an existing Linux Host build with `--foreground`, absolute paths, and `KillMode=control-group`. Edit the repository path, Node path, and state root before use. |
| [`napcat-docker-compose.yml`](./napcat-docker-compose.yml) | Headless NapCat Docker example (`mlikiowa/napcat-docker`), ports bound to 127.0.0.1 only. Usage and RabiRoute config: [NapCat on Linux](../../docs/napcat-linux_en.md). |

Everyday development still uses `Start-RabiRoute-FromSource.sh` or `npm run start:linux` at the repository root. Full commands and safety boundaries: [Linux Host](../../docs/linux-host_en.md).
