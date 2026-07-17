<!-- docs-language-switch -->
<div align="center">
English | <a href="./aiui-visual-design-system.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# AIUI Visual Design and Theme Tokens

This document records the visual-design baseline for Rokid AIUI's monochrome-green display and explains how RabiLink applies these rules in a transparent AR field of view, chat cards, and standalone modals.

## 1. Core Principles

| Principle | Requirement |
| --- | --- |
| Clarity | Text and status remain recognizable across ambient-light levels, transparent backgrounds, and reading distances |
| Hierarchy | Establish structure with surfaces, borders, text brightness, and spacing rather than shadows |
| Brand consistency | Use Rokid's green theme language consistently across pages and components |
| Simplicity | Stay out of the primary view and avoid large animations or decoration that interferes with observing the real world |
| Themeability | Source foundational visual values from CSS custom properties, also known as Design Tokens |

Monochrome-green Rokid Glasses can express only the green channel and its brightness and opacity levels. Error, warning, success, and selected states cannot depend on a second hue; they must also be expressed through text, border intensity, fill, and shape.

## 2. Theme Cascade

An AIUI theme is an ordinary CSS Token layer:

```text
Theme injected by the host
  -> app.wxss application-level overrides
  -> Page WXSS / .ink <style> overrides
  -> Component-local styles
```

Rules:

1. Host Tokens provide the defaults, and Pages consume them through `var(--token, fallback)`.
2. An application may override values, but different themes should retain the same Token-name structure.
3. Component markup must not be rewritten merely because the theme changes.
4. A Page must not bypass the theme with large numbers of inline colors.
5. Application-defined Tokens require stable names and official-Token fallbacks.

For a Rokid monochrome-green display, use the built-in Ink theme `yodaos-sprite-greenonly`.

## 3. Layout Tokens

| Token | Purpose | Recommended value |
| --- | --- | --- |
| `--app-width` | Default application width | `480px` |
| `--app-height-min` | Minimum compact-card height | `120px` |
| `--app-height-max` | Recommended maximum height, beyond which scrolling should be considered | `380px` |

Theme values are design limits; they do not guarantee that the host supplies the same dimensions. RabiLink's currently measured environments include:

- In-chat card: `448 x 150`.
- Interactive InkView / modal: `480 x 352`.
- The main Page reads its width from `--app-width`, while actual height follows the host surface constraint.
- The current `352px` physical-device/Craft limit is smaller than the theme's recommended `380px`; the Page must not overflow the real viewport merely to fill the theme maximum.

Consider `scroll-view` only when content exceeds the actual visible height. The persistent RabiLink HUD remains a single-screen layout at the lower edge.

## 4. Color Tokens

| Token | Purpose | Value |
| --- | --- | --- |
| `--color-primary` | Branding, critical data, and high-priority interaction | `#40ff5e` |
| `--color-primary-60` | Secondary text and default borders | `rgba(64, 255, 94, 0.6)` |
| `--color-primary-40` | Weak borders, light fills, and separators | `rgba(64, 255, 94, 0.4)` |
| `--color-background` | Base Page background | `#000000` |
| `--color-surface` | Card, panel, and container surface | `#000000` |
| `--color-surface-highlight` | Highlighted surface | `var(--color-primary-40)` |
| `--color-text-primary` | Titles, body text, and key labels | `var(--color-primary)` |
| `--color-text-secondary` | Descriptions, hints, and placeholders | `var(--color-primary-60)` |

Emphasis order:

```text
100% green: critical status and primary text
60% green: secondary text and ordinary borders
40% green: weak separators and low-emphasis fills
8% green: light backgrounds for input or error states
Pure black: base surface for a transparent display
```

Black is the visual base layer in a transparent-display environment and must not be mistaken for an ordinary opaque web-page background. The Page must still account for readability when real-world content shows through behind black regions.

## 5. Borders, Radii, and Spacing

### Border Widths

| Token | Purpose | Value |
| --- | --- | --- |
| `--border-width-thin` | Outlines, dividers, and input borders | `1px` |
| `--border-width-default` | Cards and ordinary panels | `2px` |
| `--border-width-strong` | Emphasized states | `4px` |

### Border Colors

| Token | Purpose | Value |
| --- | --- | --- |
| `--border-color-default` | Ordinary borders | `var(--color-primary-60)` |
| `--border-color-muted` | Weak separators | `var(--color-primary-40)` |
| `--border-color-accent` | Highlighted outlines | `var(--color-primary)` |
| `--border-color-strong` | Emphasized outlines | `var(--color-primary)` |

### Radii

| Token | Purpose | Value |
| --- | --- | --- |
| `--radius-sm` | Inputs and compact components | `12px` |
| `--radius-md` | Cards and containers | `12px` |

### Spacing

| Token | Purpose | Value |
| --- | --- | --- |
| `--spacing-sm` | Icon gaps and compact padding | `8px` |
| `--spacing-md` | Standard component padding | `12px` |
| `--spacing-lg` | Page padding and section gaps | `18px` |

The overall style is light fill, explicit outlines, and stable whitespace. A transparent AR display does not use large blurred shadows to create hierarchy.

## 6. Component Tokens

### Card

| Token | Value |
| --- | --- |
| `--card-padding` | `var(--spacing-md)` |
| `--card-border-width` | `var(--border-width-default)` |
| `--card-border-color` | `var(--border-color-default)` |
| `--card-cover-height` | `180px` |

### Input

| Token | Value |
| --- | --- |
| `--input-background-color` | `rgba(64, 255, 94, 0.08)` |
| `--input-border-width` | `var(--border-width-thin)` |
| `--input-border-color` | `var(--border-color-default)` |
| `--input-placeholder-color` | `var(--color-text-secondary)` |
| `--input-padding-y` | `10px` |
| `--input-padding-x` | `14px` |
| `--input-radius` | `var(--radius-sm)` |

### Error State

| Token | Value |
| --- | --- |
| `--error-state-background` | `rgba(64, 255, 94, 0.08)` |
| `--error-state-border-color` | `var(--border-color-muted)` |
| `--error-state-text-color` | `var(--color-text-primary)` |

Error states remain green. They are distinguished by the title, description, subtle background, and border, not by a red channel that does not exist.

## 7. Theme Baseline

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

Application code should reference host Tokens rather than mechanically copying this `:root` block into a second source of truth. Fallbacks exist only to preserve readability when the host has not yet injected a theme.

## 8. RabiLink Mapping

| HUD section | Token strategy |
| --- | --- |
| Page and surface | `--color-background`, `--color-surface` |
| Branding, primary reply, active mode | `--color-text-primary` |
| Secondary status, time, version, battery value | `--color-text-secondary` |
| Ordinary mode-track border | `--border-width-thin` + `--border-color-muted` |
| Active mode-track thumb | `--border-color-accent` |
| Light input/error background | `--input-background-color` / `--error-state-background` |
| Panels and standalone browsing containers | Card Tokens |

The current compact HUD has a small number of application-level geometry Tokens that keep the accepted dimensions of status tracks and device icons from 14px through 28px unchanged. They may override corner geometry, but color, border hierarchy, and spacing semantics must continue to fall back to the official Tokens.

## 9. Design Checklist

- [ ] Black base, monochrome-green channel, and no second-hue state.
- [ ] Primary, secondary, and muted information use 100% / 60% / 40% levels respectively.
- [ ] Colors, borders, radii, and spacing reference Tokens first.
- [ ] No shadows, gradient orbs, blurred decoration, or large looping animations.
- [ ] Cards and modals share the same markup tree, with no stale content after resize.
- [ ] The HUD is organized upward from the lower edge and stays out of the primary field of view.
- [ ] Text does not overlap on a transparent background or under 125% font stress.
- [ ] Error states use text and outlines rather than relying on red.
- [ ] Content beyond the actual height uses a purpose-specific scrolling Page instead of unbounded growth.
- [ ] Readability, flashing, power use, and different ambient-light conditions are verified on a physical device.
