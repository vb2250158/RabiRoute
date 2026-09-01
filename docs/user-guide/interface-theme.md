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
- **添加自定义主题**：复制当前选中主题的全部参数，编辑名称、浅/深基底、语义颜色、圆角、表面透明度和阴影；页面、卡片和输入区的实际亮暗必须与所选基底一致；点击“保存并应用”后立即生效，并作为新的主题选项保留。

内置主题通过页面保存按钮持久化；自定义主题在编辑面板点击“保存并应用”时直接持久化。当前 WebGUI 立即切换；托盘会在下一次设置刷新时切换，通常不超过十秒；重启托盘也会读取已保存的选择。

## 唯一设置来源

主题属于主机级桌面设置，保存在 `data/desktop/settings.json`：

```json
{
  "theme": "custom:night-rain-green",
  "webTheme": "custom:night-rain-green",
  "customThemes": [
    {
      "id": "custom:night-rain-green",
      "name": "夜雨绿",
      "baseTheme": "dark",
      "colors": { "success": "#16a34a" },
      "styles": { "cornerRadius": 8, "shadow": "soft", "glassOpacity": 94 }
    }
  ]
}
```

`theme` 允许 `system`、`light`、`dark` 或指向 `customThemes` 中现存主题的 `custom:*` ID，供 Windows Desktop 使用；`webTheme` 保存 WebGUI 选择，也允许可信插件提供的 Web 专属主题 ID。旧配置没有 `webTheme` 时会继承 `theme`；悬空的 `custom:*` 会回退到可用主题。Manager 的 `GET` 和 `PATCH /api/desktop/settings` 是 WebGUI 与 Windows Desktop 的共同接口。旧浏览器主题键只会迁移一次并删除，不能成为第二份主题设置。

## 模块分工

| 模块 | 负责内容 |
| --- | --- |
| `src/shared/interfaceThemeContract.ts` 与 `desktopSettingsContract.ts` | 内置模板、自定义主题字段、范围限制、主题选择和输入校验。 |
| Manager | 读写主机设置并通过 `/api/desktop/settings` 返回。 |
| WebGUI | 内置主题从 `ribiwebgui/src/themes/light/` 或 `dark/` 读取 CSS token 和 Vuetify 色板；自定义主题同时更新 CSS 语义 token 与 Vuetify 控件色板。状态文字使用与状态背景配套的前景色，所有开关读取主题的关闭轨道、圆点和绿色开启态。 |
| Windows 托盘 | 内置主题从 `desktop/tray-task-window/rabiroute_tray/themes/` 读取；自定义主题由同一份声明生成 Qt 调色板、菜单样式和现有窗口颜色替换表。 |

主题只决定表现颜色和系统颜色偏好，不改变路由、消息、计划、权限或数据处理规则。

## 验证

1. 修改主题后刷新 WebGUI，主题选择仍然保留。
2. 打开托盘菜单和角色面板，背景、文字、边框、按钮与 WebGUI 使用相同的浅色或深色模式。
3. 在开启滑词菜单与截图功能后，操作条和截图窗口随托盘主题切换。
4. 选择“跟随系统”后，切换系统颜色模式并确认 WebGUI 与托盘都更新。
5. 检查不同页面的开关：关闭态与当前主题协调，开启态统一显示当前主题提供的绿色。
6. 从当前主题创建自定义主题，修改“成功 / 开启”颜色并保存；确认 WebGUI 开关、托盘菜单和角色面板随之更新，刷新页面后仍可选择该主题。
7. 在颜色编辑器输入非法色值、让页面表面的亮暗与浅/深基底不一致，或让正文、标题、次要小字与卡片表面的对比度低于 `4.5:1`；保存应被阻止，并在对应字段显示修正提示。
8. 检查成功、警告、错误、信息和强调状态：文字使用对应语义前景色，背景使用配套状态表面；浅色、深色和自定义主题下都应清楚可读。
9. 从其他页面直接刷新自定义主题；WebGUI 的普通内容和 Vuetify 按钮、标签、提示控件应使用同一主题色板。
