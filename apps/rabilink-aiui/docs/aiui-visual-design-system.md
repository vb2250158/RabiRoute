<!-- docs-language-switch -->
<div align="center">
<a href="./aiui-visual-design-system_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# AIUI 视觉设计与主题 Tokens

本文记录 Rokid AIUI 单绿色显示场景的视觉设计基线，并说明 RabiLink 如何在透明 AR 视野、聊天卡片和独立 modal 中应用这些规则。

## 1. 核心原则

| 原则 | 要求 |
| --- | --- |
| 清晰性 | 在不同环境光、透明背景和阅读距离下仍能辨认文字与状态 |
| 层次感 | 使用 surface、边框、文字亮度和间距建立结构，不依赖阴影 |
| 品牌一致性 | 使用 Rokid 绿色主题语言，跨页面和组件保持一致 |
| 简洁性 | 避开主视角，不用大面积动画或装饰干扰现实世界观察 |
| 可主题化 | 所有基础视觉值优先来自 CSS 自定义属性，即 Design Tokens |

单绿色 Rokid Glasses 只能表达绿色通道及其亮度/透明度层级。错误、警告、成功和选中状态不能依赖第二种色相，必须同时通过文字、边框强度、填充和形状表达。

## 2. 主题级联机制

AIUI 主题是普通 CSS Token 层：

```text
宿主注入主题
  -> app.wxss 应用级覆盖
  -> 页面 WXSS / .ink <style> 覆盖
  -> 组件局部样式
```

规则：

1. 宿主 Token 是默认值，页面使用 `var(--token, fallback)` 消费。
2. 应用可以覆盖值，但不同主题应保持同一 Token 名称结构。
3. 组件标记结构不应因为切换主题而重写。
4. 页面不得通过大量内联颜色绕过主题。
5. 应用自定义 Token 必须有稳定命名和官方 Token fallback。

Rokid 单绿色显示推荐使用 Ink 内置主题 `yodaos-sprite-greenonly`。

## 3. 布局 Tokens

| Token | 用途 | 推荐值 |
| --- | --- | --- |
| `--app-width` | 应用默认宽度 | `480px` |
| `--app-height-min` | 紧凑卡片最小高度 | `120px` |
| `--app-height-max` | 建议最大高度，超过后考虑滚动 | `380px` |

主题值是设计上限，不等于宿主一定提供同样尺寸。当前 RabiLink 实测环境包括：

- 聊天内卡片：`448 x 150`。
- Interactive InkView / modal：`480 x 352`。
- 主页面宽度读取 `--app-width`，实际高度使用宿主 surface 约束。
- 当前 `352px` 真机/Craft 上限小于主题建议的 `380px`，页面不能为了填满主题上限而溢出真实视口。

超过真实可视高度时才考虑 `scroll-view`；RabiLink 常驻 HUD保持单屏下沿布局。

## 4. 颜色 Tokens

| Token | 用途 | 值 |
| --- | --- | --- |
| `--color-primary` | 品牌、关键数据和高优先级交互 | `#40ff5e` |
| `--color-primary-60` | 次级文字和默认边框 | `rgba(64, 255, 94, 0.6)` |
| `--color-primary-40` | 弱边框、轻填充和分隔 | `rgba(64, 255, 94, 0.4)` |
| `--color-background` | 页面基础背景 | `#000000` |
| `--color-surface` | 卡片、面板和容器 surface | `#000000` |
| `--color-surface-highlight` | 高亮 surface | `var(--color-primary-40)` |
| `--color-text-primary` | 标题、正文和关键标签 | `var(--color-primary)` |
| `--color-text-secondary` | 描述、提示和 placeholder | `var(--color-primary-60)` |

强调顺序：

```text
100% 绿色：关键状态和主要文字
60% 绿色：次级文字和普通边框
40% 绿色：弱分隔与低强调填充
8% 绿色：输入或错误状态的轻背景
纯黑：透明显示的基础 surface
```

黑色是透明显示环境的视觉底层，不应被误解为普通不透明网页背景。页面仍需考虑真实世界内容从黑色区域后方透出时的可读性。

## 5. 边框、圆角和间距

### 边框宽度

| Token | 用途 | 值 |
| --- | --- | --- |
| `--border-width-thin` | outline、divider、输入边框 | `1px` |
| `--border-width-default` | 卡片和普通面板 | `2px` |
| `--border-width-strong` | 重点状态 | `4px` |

### 边框颜色

| Token | 用途 | 值 |
| --- | --- | --- |
| `--border-color-default` | 普通边框 | `var(--color-primary-60)` |
| `--border-color-muted` | 弱分隔 | `var(--color-primary-40)` |
| `--border-color-accent` | 高亮轮廓 | `var(--color-primary)` |
| `--border-color-strong` | 强调轮廓 | `var(--color-primary)` |

### 圆角

| Token | 用途 | 值 |
| --- | --- | --- |
| `--radius-sm` | 输入框和紧凑组件 | `12px` |
| `--radius-md` | 卡片和容器 | `12px` |

### 间距

| Token | 用途 | 值 |
| --- | --- | --- |
| `--spacing-sm` | 图标间距和紧凑 padding | `8px` |
| `--spacing-md` | 标准组件 padding | `12px` |
| `--spacing-lg` | 页面 padding 和 section 间隔 | `18px` |

整体风格是“轻填充、明确轮廓、稳定留白”。透明 AR 显示中不使用大面积模糊阴影建立层次。

## 6. 组件 Tokens

### Card

| Token | 值 |
| --- | --- |
| `--card-padding` | `var(--spacing-md)` |
| `--card-border-width` | `var(--border-width-default)` |
| `--card-border-color` | `var(--border-color-default)` |
| `--card-cover-height` | `180px` |

### Input

| Token | 值 |
| --- | --- |
| `--input-background-color` | `rgba(64, 255, 94, 0.08)` |
| `--input-border-width` | `var(--border-width-thin)` |
| `--input-border-color` | `var(--border-color-default)` |
| `--input-placeholder-color` | `var(--color-text-secondary)` |
| `--input-padding-y` | `10px` |
| `--input-padding-x` | `14px` |
| `--input-radius` | `var(--radius-sm)` |

### Error State

| Token | 值 |
| --- | --- |
| `--error-state-background` | `rgba(64, 255, 94, 0.08)` |
| `--error-state-border-color` | `var(--border-color-muted)` |
| `--error-state-text-color` | `var(--color-text-primary)` |

错误状态仍使用绿色。区别来自标题、描述、弱背景和边框，而不是不存在的红色通道。

## 7. 主题基线

```css
:root {
  --app-width: 480px;
  --app-height-min: 120px;
  --app-height-max: 380px;

  --color-primary: #40ff5e;
  --color-primary-60: rgba(64, 255, 94, 0.6);
  --color-primary-40: rgba(64, 255, 94, 0.4);
  --color-background: #000000;
  --color-surface: #000000;
  --color-surface-highlight: var(--color-primary-40);
  --color-text-primary: var(--color-primary);
  --color-text-secondary: var(--color-primary-60);

  --border-width-thin: 1px;
  --border-width-default: 2px;
  --border-width-strong: 4px;
  --border-color-default: var(--color-primary-60);
  --border-color-muted: var(--color-primary-40);
  --border-color-strong: var(--color-primary);
  --border-color-accent: var(--color-primary);

  --radius-sm: 12px;
  --radius-md: 12px;

  --spacing-sm: 8px;
  --spacing-md: 12px;
  --spacing-lg: 18px;

  --card-padding: var(--spacing-md);
  --card-border-width: var(--border-width-default);
  --card-border-color: var(--border-color-default);

  --input-background-color: rgba(64, 255, 94, 0.08);
  --input-border-width: var(--border-width-thin);
  --input-border-color: var(--border-color-default);
  --input-placeholder-color: var(--color-text-secondary);
  --input-padding-y: 10px;
  --input-padding-x: 14px;
  --input-radius: var(--radius-sm);
}
```

应用代码应引用宿主 Token，不把这段 `:root` 机械复制成第二套真源。fallback 只用于宿主尚未注入主题时保持可读。

## 8. RabiLink 映射

| HUD 部分 | Token 策略 |
| --- | --- |
| 页面与 surface | `--color-background`、`--color-surface` |
| 品牌、主要回复、活动模式 | `--color-text-primary` |
| 次级状态、时间、版本、电量值 | `--color-text-secondary` |
| 模式轨普通边框 | `--border-width-thin` + `--border-color-muted` |
| 模式轨活动 thumb | `--border-color-accent` |
| 输入/错误轻背景 | `--input-background-color` / `--error-state-background` |
| 面板和独立浏览容器 | Card Tokens |

当前紧凑 HUD 有少量应用级几何 Token，用于保证 14px 到 28px 高的小型状态轨和设备图标不改变已验收尺寸。它们可以覆盖圆角几何，但颜色、边框层级和间距语义必须继续回落到官方 Token。

## 9. 设计检查清单

- [ ] 黑底、单绿色通道，无第二色相状态。
- [ ] 主要、次要、弱化信息分别使用 100% / 60% / 40% 层级。
- [ ] 颜色、边框、圆角和间距优先引用 Token。
- [ ] 不使用阴影、渐变光球、模糊装饰或大面积循环动画。
- [ ] 卡片和 modal 共用同一标记树，resize 不残留旧内容。
- [ ] HUD 从下沿向上组织，不占据主视野。
- [ ] 文字在透明背景和 125% 字体压力下不重叠。
- [ ] 错误状态使用文字和轮廓表达，不依赖红色。
- [ ] 超出真实高度时使用职责明确的滚动页面，不无边界增高。
- [ ] 真机验证可读性、闪烁、功耗和不同环境光表现。
