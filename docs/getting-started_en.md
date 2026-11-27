<!-- docs-language-switch -->
<div align="center">
English | <a href="./getting-started.md">简体中文</a> | <a href="./getting-started_ja.md">日本語</a>
</div>
<!-- /docs-language-switch -->

# Getting Started

> Status: current guide. Checked against the current Manager, RibiWebGUI, Codex Desktop owner, and NapCat setup flow.

Getting RabiRoute running is four steps; most of the time goes into first-build dependency downloads:

1. **Install** — one click on Windows, one command on Linux.
2. **Create a role** — the owner of this route.
3. **Configure a message adapter** — QQ (NapCat), or scheduled triggers only.
4. **Configure the Agent adapter** — bind a handler (Codex or DSH).

Then verify with a delivery test. Follow the steps below.

## Step 1: Install

**Windows (recommended)**: install the [Windows package](https://github.com/vb2250158/RabiRoute/releases), launch RabiRoute Host from the Start menu, and open RibiWebGUI from the tray. To run the current source, double-click `Start-RabiRoute-FromSource.bat` in the repository root. It builds Manager, WebGUI, plugins, Host, and the tray, activates the source build through Host, and keeps installed settings and data.

Only Node.js 22.13+ and the .NET 9 SDK are needed. The first build downloads Python / Qt / NuGet dependencies **automatically** — do not install or configure them by hand. Manual toolchain setup is slow and error-prone; regular users do not need it.

Failure logs are in `logs/source-start/`. If the dependency lock differs from the installed package, update the full installation first. Closing the command window does not stop Host; quit from the tray.

**Linux**: install Node.js 22.13+, npm, and util-linux `flock` (plus `xdg-utils` for Host `open`), then:

```bash
cd /path/to/RabiRoute
bash Start-RabiRoute-FromSource.sh
npm run status:linux -- --json
node scripts/linux-host.mjs --command open
```

Open the URL Host returns. This path has no Windows tray, screenshots, or global hotkeys; see [Linux Host](linux-host_en.md).

**Backend-only development (no tray)**:

```powershell
cd C:\Path\To\RabiRoute
npm install
npm run build
npm run start:manager
```

Manager prints its actual address (for example `RabiRoute manager listening at <managerBaseUrl>`). Open that run's `<managerBaseUrl>`; do not preserve a port as a permanent default.

## Step 2: Create a role

In RibiWebGUI, click "New role" at the lower left, enter a name and role ID, then open "Role configuration". The standard companion example uses `Rabi`; the glasses record-first example uses its companion role.

On a first writable start with no `data/route` or `data/roles`, Manager copies the bundled `examples/data`; only `main` is enabled by default. To copy manually:

```bash
cp -R examples/data/. data/
```

## Step 3: Configure a message adapter

Under "Role configuration → Message connectors", add a message adapter. For QQ, choose **NapCat / OneBot** and sign in with the QR code shown in the card.

NapCat's download, ports, and OneBot configuration are managed by RabiRoute — **you do not install or configure them yourself**. Each route binds one QQ account; use separate routes for multiple accounts. The first login needs a phone QR scan; afterwards RabiRoute restores the saved login automatically. For local scheduled triggers only, no message adapter is needed.

If sign-in fails, see [NapCat unattended and login stability](napcat-unattended_en.md).

## Step 4: Configure the Agent adapter

On the same page, under "Agent adapters", add a handler and set it as "primary":

- **Agent configuration**: Codex (default, verified) or DSH.
- **Agent session**: pick an existing "task name + last session time"; entering a new name creates a task on save.
- **Agent workspace**: select or enter an absolute project path.

With Codex, keep Codex/ChatGPT Desktop open during delivery; RabiRoute reuses the target task through Desktop IPC. With DSH, bind a DSH session as the handler; see [Role sessions and Agent adapters](user-guide/agents-and-sessions_en.md).

Press Save in the top bar and wait until "unsaved changes" clears.

## Verify: delivery test

On the route, open "Channel check", then click "Delivery test" on the Agent node — it sends a real message with a test ID. Confirm the page reports success and check that the target Agent actually received the same message. Saving configuration and reading channel status do not by themselves prove delivery.

For scheduled triggers, configure a rule under "Role configuration → Automation → Message rules", then use "Manual trigger" in "Diagnostics" to verify.

## More

- Full four-step tutorial with screenshots: [Run your first route](user-guide/first-route_en.md)
- Routes and adapters: [Routes and adapters](user-guide/routes-and-adapters_en.md)
- Agent adapters and sessions: [Role sessions and Agent adapters](user-guide/agents-and-sessions_en.md)
- Manual `personaConfig.json`: [Routing configuration](routing-configuration_en.md)
- Manual build from scratch (only without a package): [Windows launcher and packaging](windows-launcher-and-packaging_en.md)
- Windows Chinese-message encoding: [FAQ and support](user-guide/faq-and-support_en.md)

Source entry points: `src/manager.ts` (configuration, route lifecycle, RibiWebGUI API), `src/index.ts` (one gateway), `src/adapters/` (message adapters), `src/plugins/io.rabiroute.endpoint.rabilink/src/forwarding.ts` (rules and delivery), `src/history.ts` (JSONL records).
