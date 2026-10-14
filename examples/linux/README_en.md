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

Everyday development still uses `Start-RabiRoute-FromSource.sh` or `npm run start:linux` at the repository root. Full commands and safety boundaries: [Linux Host](../../docs/linux-host_en.md).
