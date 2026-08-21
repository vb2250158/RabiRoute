import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const launcher = fs.readFileSync(new URL("../Start-RabiRoute-Desktop.bat", import.meta.url), "utf8");
const lifecycle = fs.readFileSync(new URL("../src/manager/desktopLifecycleRoutes.ts", import.meta.url), "utf8");
const desktopSettingsRenderer = fs.readFileSync(new URL("../ribiwebgui/src/components/renderers/DesktopSettingsRenderer.vue", import.meta.url), "utf8");
const windowsGuide = fs.readFileSync(new URL("../docs/windows-launcher-and-packaging.md", import.meta.url), "utf8");
const windowsGuideEnglish = fs.readFileSync(new URL("../docs/windows-launcher-and-packaging_en.md", import.meta.url), "utf8");
const troubleshootingGuide = fs.readFileSync(new URL("../docs/user-guide/operations-and-troubleshooting.md", import.meta.url), "utf8");
const troubleshootingGuideEnglish = fs.readFileSync(new URL("../docs/user-guide/operations-and-troubleshooting_en.md", import.meta.url), "utf8");
const desktopEntry = fs.readFileSync(new URL("../desktop/tray-task-window/main.py", import.meta.url), "utf8");

test("Windows desktop starts as one RabiRoute product runtime", () => {
  assert.equal(packageJson.scripts["start:windows"], "Start-RabiRoute-Desktop.bat");
  assert.match(launcher, /function Start-RabiRouteDesktop/);
  assert.match(launcher, /function Start-DesktopShell/);
  assert.match(launcher, /RabiRoute Desktop cannot start because Python was not found/);
  assert.doesNotMatch(launcher, /Manager\/WebGUI remain available/);
  assert.match(lifecycle, /"packaged-desktop"/);
  assert.match(lifecycle, /"windows-desktop"/);
  assert.match(lifecycle, /"desktop-exit"/);
  assert.match(desktopEntry, /LEGACY_DESKTOP_ARTIFACT_NAMES/);
  assert.match(desktopEntry, /_remove_legacy_desktop_artifacts\(project_root\)/);
});

test("Windows UI and public guides keep tray and Manager inside RabiRoute Desktop", () => {
  assert.match(desktopSettingsRenderer, /class="section-title">RabiRoute 桌面功能<\/div>/);
  assert.match(desktopSettingsRenderer, /登录 Windows 后自动启动 RabiRoute Desktop；后台运行时保留系统托盘入口。/);
  assert.doesNotMatch(desktopSettingsRenderer, /Manager 仍按自己的运行开关管理/);

  assert.match(windowsGuide, /RabiRoute Desktop 是 Windows 上唯一的用户入口。/);
  assert.match(windowsGuide, /不单独作为另一款 Windows 软件出现。/);
  assert.doesNotMatch(windowsGuide, /Manager\/托盘进程配对/);
  assert.doesNotMatch(troubleshootingGuide, /托盘消失但 Manager 仍在/);

  assert.match(windowsGuideEnglish, /RabiRoute Desktop is the one Windows user entry\./);
  assert.match(windowsGuideEnglish, /does not appear as a separate Windows application\./);
  assert.doesNotMatch(windowsGuideEnglish, /Manager\/desktop shell process-pair/);
  assert.doesNotMatch(troubleshootingGuideEnglish, /Tray missing while Manager remains online/);
});
