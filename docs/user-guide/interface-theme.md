<!-- docs-language-switch -->
<div align="center">
  简体中文 | <a href="./interface-theme_en.md">English</a>
</div>
<!-- /docs-language-switch -->

# 界面主题

**现行指南。** 设置页、WebGUI、托盘菜单、角色面板、滑词操作条和截图窗口使用同一项主题选择。

## 使用方式

在 WebGUI 的“设置”页选择：

- **跟随系统**：浏览器和 Windows 当前使用浅色或深色时，RabiRoute 随之切换。
- **浅色**：始终使用浅色界面。
- **深色**：始终使用深色界面。

保存后，当前 WebGUI 立即切换；托盘会在下一次设置刷新时切换，通常不超过十秒；重启托盘也会读取已保存的选择。

## 唯一设置来源

主题属于主机级桌面设置，保存在 `data/desktop/settings.json`：

```json
{
  "theme": "system"
}
```

允许值为 `system`、`light`、`dark`，缺失或无效值按 `system` 处理。Manager 的 `GET` 和 `PATCH /api/desktop/settings` 是 WebGUI 与 Windows 托盘的共同接口。浏览器本地存储、托盘私有文件和单个窗口状态都不能成为第二份主题设置。

## 模块分工

| 模块 | 负责内容 |
| --- | --- |
| `src/shared/desktopSettingsContract.ts` | 主题值、默认值和输入校验。 |
| Manager | 读写主机设置并通过 `/api/desktop/settings` 返回。 |
| WebGUI | 从 `ribiwebgui/src/themes/light/` 或 `ribiwebgui/src/themes/dark/` 读取 CSS token 和 Vuetify 色板；在“跟随系统”时监听浏览器系统颜色变化。 |
| Windows 托盘 | 从 `desktop/tray-task-window/rabiroute_tray/themes/light/` 或 `desktop/tray-task-window/rabiroute_tray/themes/dark/` 读取调色板和菜单样式，并在刷新时更新 Qt 应用、角色面板、滑词操作条和截图窗口。 |

主题只决定表现颜色和系统颜色偏好，不改变路由、消息、计划、权限或数据处理规则。

## 验证

1. 修改主题后刷新 WebGUI，主题选择仍然保留。
2. 打开托盘菜单和角色面板，背景、文字、边框、按钮与 WebGUI 使用相同的浅色或深色模式。
3. 在开启滑词菜单与截图功能后，操作条和截图窗口随托盘主题切换。
4. 选择“跟随系统”后，切换系统颜色模式并确认 WebGUI 与托盘都更新。
