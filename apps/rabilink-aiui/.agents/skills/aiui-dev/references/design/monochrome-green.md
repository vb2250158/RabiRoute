---
version: beta
name: Rokid AIUI Monochrome-Green Scientific Interface
target:
  devices: ["RokidGlasses1", "RokidGlasses2"]
  display: "single-green monochrome transparent display"
  reference-canvas: "480x352"

description: >
  Rokid AIUI's monochrome-green visual language for transparent AR glasses.
  The system keeps the hardware constraint of a single luminous green channel,
  while shifting the visual grammar toward a restrained instrument-like interface:
  thin structural lines, sparse low-luminance fills, and compact technical typography.
  Information hierarchy is created through luminance, typography, line treatment,
  and whitespace rather than large filled cards or decorative chrome.

constraints:
  - "Single-green display only. All visible pixels are expressed through one green channel at different luminance levels."
  - "Pure black represents the transparent floor. Do not depend on opaque black panels to hide the physical environment."
  - "The full-screen reference canvas is 480x352px. Essential information must remain inside the comfortable central field."
  - "Critical text, focus states, and interaction targets must remain readable against arbitrary real-world backgrounds."
  - "Color cannot encode semantics. Status and severity must also use iconography, labels, line patterns, or motion."
  - "Decorative density must never compete with task content."

colors:
  primary: "#40ff5e"                         # Maximum display luminance / active focus
  primary-72: "rgba(64,255,94,0.72)"         # Primary readable text / active structural line
  primary-48: "rgba(64,255,94,0.48)"         # Secondary text / normal frame / inactive control
  primary-24: "rgba(64,255,94,0.24)"         # Dividers / inactive structural lines / guides
  primary-12: "rgba(64,255,94,0.12)"         # Selected or raised surface tint
  primary-06: "rgba(64,255,94,0.06)"         # Atmospheric/decorative surface tint
  background: "#000000"                      # Transparent display floor
  surface: "#000000"                         # Default content plane
  surface-subtle: "{colors.primary-06}"       # Optional local grouping only
  surface-active: "{colors.primary-12}"       # Selected/focused local region
  ink: "{colors.primary}"                     # Highest-emphasis text / value
  ink-primary: "{colors.primary-72}"          # Normal readable text
  ink-secondary: "{colors.primary-48}"        # Secondary description / metadata
  ink-disabled: "{colors.primary-24}"         # Disabled or unavailable content
  line-strong: "{colors.primary-72}"          # Focused frame / active structural line
  line-default: "{colors.primary-48}"         # Normal interactive boundary
  line-muted: "{colors.primary-24}"           # Dividers / decorative guides
  line-trace: "{colors.primary-12}"           # Atmospheric guides
  on-primary: "#000000"                       # Text on rare solid-green fill

typography:
  display:
    fontFamily: "sans-serif"
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "0.01em"
  heading:
    fontFamily: "sans-serif"
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.01em"
  body:
    fontFamily: "sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  body-sm:
    fontFamily: "sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.01em"
  label:
    fontFamily: "sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.08em"
    textTransform: uppercase
  caption:
    fontFamily: "sans-serif"
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0.05em"
  mono:
    fontFamily: "monospace"
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0.04em"
  data:
    fontFamily: "monospace"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.03em"

rounded:
  none: 0px
  xs: 2px
  sm: 4px
  md: 6px
  full: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px

border-width:
  hairline: 1px
  default: 1px
  strong: 2px

motion:
  duration-fast: 120ms
  duration-default: 200ms
  duration-slow: 320ms
  easing-enter: "cubic-bezier(0.16, 1, 0.3, 1)"
  easing-exit: "cubic-bezier(0.4, 0, 1, 1)"
  ambient-period-min: 4000ms
  ambient-period-max: 8000ms

components:
  app-canvas:
    description: "Full transparent HUD canvas."
    width: 480px
    height: 352px
    safeInsetX: 16px
    safeInsetY: 12px
    backgroundColor: "{colors.background}"

  panel:
    description: >
      Primary grouping primitive. Prefer a sparse frame or local boundary over
      a filled card. Use only where grouping materially improves comprehension.
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line-muted}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"

  card:
    description: >
      Backward-compatible alias for panel. Existing card-based layouts may keep
      the component name, but new designs should visually follow panel rules.
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.line-muted}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"

  card-highlight:
    description: "Focused/selected local region with restrained tint."
    backgroundColor: "{colors.surface-active}"
    borderColor: "{colors.line-strong}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"

  divider:
    description: "Thin structural separator."
    backgroundColor: "{colors.line-muted}"
    height: "{border-width.hairline}"

  button:
    description: "Compact outlined action. Filled buttons are reserved for irreversible or primary confirmation moments."
    minHeight: 32px
    backgroundColor: transparent
    borderColor: "{colors.line-default}"
    borderWidth: "{border-width.default}"
    textColor: "{colors.ink-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "0 {spacing.md}"

  button-active:
    backgroundColor: "{colors.surface-active}"
    borderColor: "{colors.line-strong}"
    textColor: "{colors.ink}"

  button-disabled:
    backgroundColor: transparent
    borderColor: "{colors.line-trace}"
    textColor: "{colors.ink-disabled}"

  chip:
    description: "Compact status/filter token."
    minHeight: 22px
    backgroundColor: transparent
    borderColor: "{colors.line-muted}"
    borderWidth: "{border-width.hairline}"
    textColor: "{colors.ink-secondary}"
    typography: "{typography.caption}"
    rounded: "{rounded.sm}"
    padding: "0 {spacing.sm}"

  text-input:
    description: "Low-fill input field."
    minHeight: 36px
    backgroundColor: "{colors.surface-subtle}"
    borderColor: "{colors.line-default}"
    borderWidth: "{border-width.default}"
    textColor: "{colors.ink-primary}"
    placeholderColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding-y: 8px
    padding-x: 10px

  textarea:
    description: "Multi-line input following the same low-fill field grammar."
    backgroundColor: "{colors.surface-subtle}"
    borderColor: "{colors.line-default}"
    borderWidth: "{border-width.default}"
    textColor: "{colors.ink-primary}"
    placeholderColor: "{colors.ink-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding-y: 8px
    padding-x: 10px

  list-row:
    description: "Open row with divider; avoid wrapping every row in a card."
    minHeight: 40px
    padding: "{spacing.sm} 0"
    rowBorder: "{colors.line-muted}"
    titleTypography: "{typography.body}"
    metaTypography: "{typography.caption}"

  status:
    description: "Semantic status pattern using label + icon/shape + optional line pattern."
    textColor: "{colors.ink-primary}"
    iconColor: "{colors.ink-primary}"
    typography: "{typography.caption}"

  error-state:
    description: >
      Error/severity container. Green-only hardware requires redundant encoding:
      triangle/error glyph + explicit label + stronger boundary or dashed treatment.
    backgroundColor: "{colors.surface-subtle}"
    borderColor: "{colors.line-strong}"
    borderWidth: "{border-width.default}"
    borderStyle: dashed
    textColor: "{colors.ink-primary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"

  icon:
    description: "Monoline outline glyph; avoid solid icon masses."
    color: "{colors.ink-primary}"
    strokeWidth: "{border-width.hairline}"

  progress:
    description: "Linear progress/status track."
    height: 1px
    trackColor: "{colors.line-muted}"
    fillColor: "{colors.line-strong}"
    markerColor: "{colors.ink}"

  chart-container:
    description: >
      Open visualization region. Default to no filled card; use axes,
      labels, sparse guides, and 1px strokes.
    backgroundColor: transparent
    borderColor: "{colors.line-trace}"
    borderWidth: "{border-width.hairline}"
    rounded: "{rounded.xs}"
    padding: "{spacing.sm}"

---

# Rokid AIUI Monochrome-Green Scientific Interface

## Overview

This specification defines the visual language for Rokid AIUI on **RokidGlasses1 / RokidGlasses2**, using the **480 × 352 px** single-green transparent display.

The hardware constraint remains fundamental: the display exposes one luminous green channel over a transparent black floor. The new visual direction treats that constraint as a **luminance, line, and whitespace system**. Interfaces should feel precise, lightweight, technical, and spatial — closer to a scientific instrument or mission-control overlay than a stack of conventional UI cards.

The visual system is built from four primitives:

1. **Luminance** — one green channel at controlled brightness levels.
2. **Typography** — compact, technical, low-weight hierarchy.
3. **Lines** — hairline frames, dividers, and axes.
4. **Whitespace** — deliberate empty regions that preserve focus inside a small field of view.

Large opaque surfaces, thick borders, repeated rounded cards, and decorative glow should be exceptional.

## 1. Design Principles

### 1.1 Instrument, not conventional UI chrome

AIUI is an information overlay inside the user's visual field. The interface should expose state, relationships, and actions with the minimum amount of chrome required to understand them.

Prefer:

- open layouts,
- 1px structural lines,
- compact labels,
- small local groupings,
- spatial relationships,
- data-first composition.

Avoid wrapping every content block in a visible card.

### 1.2 Low visual mass

Transparent glasses already contain a visually complex physical background. The interface should add as little opaque mass as possible.

Use:

- transparent or black floor,
- 6–12% local tint only when grouping is needed,
- 1px boundaries,
- sparse fills,
- open list rows,
- restrained iconography.

### 1.3 Readability has priority over atmosphere

Essential information must remain legible against changing backgrounds.

Minimum guidance:

- Primary readable text: `{colors.primary-72}` or brighter.
- Secondary text: `{colors.primary-48}` at 12px or larger.
- Interactive boundaries: `{colors.primary-48}` or brighter.
- Decorative guides may fall to `{colors.primary-24}` / `{colors.primary-12}`.
- Do not place critical meaning at `{colors.primary-24}` or below.

### 1.4 One hue, redundant semantics

Errors, warnings, success, online/offline, selected/unselected, and disabled states all share the same green channel. State must therefore combine multiple cues:

- label,
- icon/shape,
- line style,
- border strength,
- fill level,
- motion where appropriate.

Never encode an important state only by opacity.

## 2. Color & Luminance

The palette is a single green channel based on `#40ff5e`.

| Token | Value | Role |
|---|---|---|
| `{colors.primary}` | `#40ff5e` | Maximum emphasis, selected value, active point |
| `{colors.primary-72}` | `rgba(64,255,94,.72)` | Primary readable text, active lines |
| `{colors.primary-48}` | `rgba(64,255,94,.48)` | Secondary text, normal frames |
| `{colors.primary-24}` | `rgba(64,255,94,.24)` | Dividers, inactive lines, guides |
| `{colors.primary-12}` | `rgba(64,255,94,.12)` | Active/selected local surface tint |
| `{colors.primary-06}` | `rgba(64,255,94,.06)` | Atmospheric grouping tint |
| `{colors.background}` | `#000000` | Transparent floor |

### Luminance rules

- Full green is a scarce resource. Reserve it for focus, active data, and the most important value on screen.
- Normal body copy should use 72% brightness rather than 100%.
- Repeated structural lines should default to 24–48%.
- Large areas should not use 24%+ green fill; they create excessive bloom and visual masking.
- A selected region may use 12% fill plus a stronger frame.
- Disabled content uses 24% text and must remain explicitly recognizable as disabled.

## 3. Typography

The new direction removes the old dependency on bold monospace headings. Typography should feel closer to a technical instrument panel: compact, measured, and information-dense.

### Font strategy

Use generic system families so the runtime remains portable:

- `sans-serif` — UI text, headings, actions, descriptions.
- `monospace` — numerical values, logs, timestamps, IDs, coordinates, technical metadata.

Do not require a branded font file for the core system.

### Type scale

| Token | Size | Weight | Tracking | Use |
|---|---:|---:|:---:|---|
| `{typography.display}` | 22px | 500 | 0.01em | Primary page/state title |
| `{typography.heading}` | 16px | 500 | 0.01em | Section heading |
| `{typography.body}` | 14px | 400 | 0 | Main readable copy |
| `{typography.body-sm}` | 12px | 400 | 0.01em | Dense secondary copy |
| `{typography.label}` | 11px | 500 | 0.08em | Actions, category labels, uppercase micro-headings |
| `{typography.caption}` | 10px | 400 | 0.05em | Metadata, timestamps, status |
| `{typography.mono}` | 11px | 400 | 0.04em | Logs, IDs, coordinates |
| `{typography.data}` | 13px | 500 | 0.03em | Key numerical values |

### Rules

- Avoid 700/bold as a default hierarchy mechanism.
- Use 500 as the normal maximum weight for UI headings.
- Use uppercase + tracking for short technical labels only.
- Do not set long body paragraphs in uppercase or wide tracking.
- Keep text blocks narrow enough to scan without eye travel across the full 480px canvas.
- A single screen should normally expose no more than three simultaneous type levels.

## 4. Layout

### Canvas

- Reference size: **480 × 352 px**
- Safe horizontal inset: **16px**
- Safe vertical inset: **12px**
- Effective default content width: **448px**

The system still supports scrollable content where required, but the preferred experience is to reveal the minimum actionable information in the initial field of view.

### Spacing scale

`2 / 4 / 8 / 12 / 16 / 24 / 32px`

Use 8px and 12px for internal component rhythm, 16px for section separation, and 24px only when a stronger visual pause is required.

### Composition modes

AIUI supports three primary composition modes:

**A. Linear** — lists, forms, status summaries, conversation results.

**B. Spatial** — object relationships, agent/tool arrangements, visual search.

**C. Instrument** — metrics, progress, timelines, capture regions, system state.

Do not force a spatial visualization into a card list when the relationships are the main content.

## 5. Shapes & Lines

### Radius

| Token | Value | Use |
|---|---:|---|
| `{rounded.none}` | 0px | Grids, axes, data frames |
| `{rounded.xs}` | 2px | Scientific viewport / micro-frame |
| `{rounded.sm}` | 4px | Buttons, chips, inputs |
| `{rounded.md}` | 6px | Panels and local groupings |
| `{rounded.full}` | 9999px | Circular marker / pill only |

The visual system should no longer default every container to a 12px radius.

### Borders

- Default: 1px.
- Strong/focused: 2px.
- 2px should indicate selection or strong focus, not normal container chrome.
- Dashed lines communicate provisional, unavailable, add-new, or error/severity states where useful.
- Dividers should normally use 1px at 24% luminance.

## 6. Components

### Panel / Card

`panel` is the preferred new term. `card` remains as a compatibility alias.

Default:

- black/transparent floor,
- 1px 24% frame,
- 6px radius,
- 12px padding,
- no shadow,
- no persistent bright outline.

A panel can omit one or more borders when alignment, whitespace, or corner markers already provide sufficient grouping.

### Highlighted region

Selected/focused region:

- 12% green local fill,
- 72% 1px frame,
- optional 2px focus marker,
- primary text/value may rise to 100%.

Do not use 40% full-surface fills for normal emphasis.

### Button

Default:

- minimum height 32px,
- 1px 48% outline,
- 4px radius,
- 11px / 500 uppercase label,
- transparent background.

Active:

- 12% local fill,
- 72–100% text,
- stronger boundary.

Disabled:

- 24% text,
- 12% boundary,
- no active motion.

Solid green buttons are allowed only when the interaction requires a singular, high-confidence confirmation state.

### Chip / Tag

- minimum height 22px,
- 1px 24% border,
- 4px radius,
- 10px caption typography,
- short labels only.

Use chips for filters, status labels, source identifiers, or compact mode indicators.

### Input

- 36px minimum height,
- 6% local tint,
- 1px 48% boundary,
- 4px radius,
- 14px primary text,
- 48% placeholder.

Focus should increase the border to 72% and may add a local marker. Avoid a large glow.

### List

Rows should remain visually open:

- 40px minimum row height,
- 8px vertical rhythm,
- optional 1px 24% divider,
- no card wrapper per row by default.

Use alignment and whitespace to create hierarchy.

### Status / Semantic message

A state requires at least two signals:

- explicit text label, and
- icon/shape/line treatment.

Examples:

- error: triangle + `ERROR` + dashed strong boundary,
- warning: alert glyph + `WARN` + strong side marker,
- success: check glyph + `DONE`,
- offline: hollow dot + `OFFLINE`,
- active: solid dot + `ACTIVE`.

All remain green.

### Icon

- monoline outline,
- 1px stroke,
- size scale 16 / 20 / 24px,
- no unnecessary solid fill,
- use simple shapes that survive low-resolution rendering.

### Progress

- 1px track,
- 24% base,
- 72% filled segment,
- 100% marker only for current position.

Circular progress is allowed when radial structure has semantic value; avoid using circles solely for visual novelty.

## 7. Visualization

Charts and diagrams should inherit the same restrained grammar.

### Default visualization treatment

- transparent background,
- 1px lines,
- sparse axes,
- 24% guide grid,
- 48–72% series,
- 100% active point or current value,
- labels in caption/mono typography,
- fill areas capped around 12% unless temporarily highlighted.

### Data encoding

Because hue is unavailable, distinguish series or states through:

- solid / dashed / dotted lines,
- marker shape,
- stroke brightness,
- line weight,
- position,
- labels,
- hatch/pattern only when necessary.

Do not create multiple data series that differ only by green opacity.

## 8. Motion

Motion should indicate state change, direction, progress, or attention.

### Timing

- Fast feedback: `{motion.duration-fast}`.
- Standard transition: `{motion.duration-default}`.
- Structural transition: `{motion.duration-slow}`.
- Ambient cycle: `{motion.ambient-period-min}`–`{motion.ambient-period-max}` only when an ongoing system state must remain visible.

### Rules

- Prefer event-driven motion over continuous decorative animation.
- Active values may pulse subtly; only one dominant pulse should exist at a time.
- Loading/progress animation must remain spatially stable.
- Avoid full-screen parallax, persistent glow breathing, or multiple independent ambient loops.
- Motion must stop or simplify when the interface is static.

## 9. Depth

The system uses three restrained depth levels.

| Level | Treatment | Use |
|---|---|---|
| 0 — Open field | Transparent/black, no boundary | Default canvas |
| 1 — Local grouping | 6% tint or 24% frame | Secondary panel, input grouping |
| 2 — Active grouping | 12% tint + 72% frame | Selected/focused region |

No general-purpose drop shadow is defined.

A tiny glow may be used on an active point or cursor when hardware bloom alone is insufficient, but it must not become a component-level elevation system.

## 10. Interaction States

### Focus

Use:

- stronger border,
- active marker,
- 100% key value,
- optional 12% local tint.

Do not enlarge the entire component unless spatial targeting requires it.

### Pressed

- brief 12% fill,
- 120ms feedback,
- retain dimensions to avoid layout shift.

### Disabled

- 24% text and structural line,
- explicit unavailable/disabled semantics when ambiguity is possible,
- no pulsing or active animation.

### Loading

Prefer one of:

- moving point along a path,
- short line scan,
- marker rotation,
- determinate progress.

Avoid large generic spinners when the task can expose meaningful progress.

## 11. Backward Compatibility

Existing AIUI pages and documentation may continue to reference old token/component names.

### Compatibility mapping

| Existing name | New behavior |
|---|---|
| `card` | Alias of `panel`; use sparse 1px frame |
| `card-highlight` | 12% local tint + stronger 1px frame |
| `border-default` | Replace with `line-default` |
| `border-muted` | Replace with `line-muted` |
| `border-accent` | Replace with `line-strong` |
| `primary-60` | Migrate to `primary-72` for readable text or `primary-48` for structure |
| `primary-40` | Migrate to `primary-48` for structure or `primary-24` for guides |
| `primary-08` | Migrate to `primary-06` / `primary-12` depending on surface state |
| 12px universal radius | Migrate to 4px controls / 6px panels |
| 2px normal card border | Migrate to 1px; keep 2px for strong focus |
| bold monospace heading | Migrate to 500 sans; keep mono for data/logs |

Implementations may keep legacy CSS variables temporarily, but new components should consume the new semantic tokens.

## 12. Migration from the Alpha Visual Language

The previous monochrome specification centered the UI on bright outlined cards. The new system keeps the same hardware and runtime foundations while changing the visual grammar.

### Change summary

**Old:** 4-level green opacity ladder  
**New:** 6-level luminance ladder with tighter separation between readable content, structure, and atmosphere.

**Old:** 12px radius across most controls and cards  
**New:** 2 / 4 / 6px functional radius scale.

**Old:** 2px normal card outline, 4px strong outline  
**New:** 1px default structural line, 2px reserved for strong focus.

**Old:** 40% highlighted surface  
**New:** 12% maximum normal local selection tint.

**Old:** bold monospace titles as a major identity cue  
**New:** compact medium-weight sans for UI hierarchy; monospace is reserved for data and technical metadata.

**Old:** card-first vertical composition  
**New:** open-field composition with panels only where grouping is necessary.

**Old:** component depth through filled surfaces and border weight  
**New:** depth through local tint, luminance, line pattern, and whitespace.

## 13. Do's and Don'ts

### Do

- Keep the 480 × 352 canvas as the primary spatial constraint.
- Use 1px lines and low visual mass for normal structure.
- Reserve full green for focus and key values.
- Use whitespace as a primary grouping tool.
- Prefer open list rows over repeated cards.
- Use monospace for logs, coordinates, IDs, and data values.
- Pair every semantic state with text plus a geometric/icon cue.
- Keep decorative lines at 24% luminance or lower.
- Test screens against bright, dark, and visually cluttered physical backgrounds.

### Don't

- Don't rebuild the interface as a stack of thick glowing cards.
- Don't default every container to a 12px radius.
- Don't use 2–4px borders as normal chrome.
- Don't use 40% green as a large-area highlight fill.
- Don't make all headings bold monospace.
- Don't encode state only through brightness.
- Don't run multiple continuous ambient animations at once.
- Don't use shadow as the primary depth model.
- Don't introduce a second hue.
- Don't reduce critical text or interaction boundaries to trace-level luminance.
- Don't let visual experimentation reduce task legibility.

## 14. Acceptance Checklist

A new AIUI screen is visually conformant when:

- [ ] It fits the 480 × 352 reference canvas or has an explicit overflow strategy.
- [ ] Primary readable text is at least 72% green luminance.
- [ ] Normal structural lines are 1px.
- [ ] 2px borders appear only for strong focus or equivalent emphasis.
- [ ] Large-area green fill remains at or below 12% in normal states.
- [ ] Controls use 4px radius and panels use 6px radius unless the layout requires square edges.
- [ ] The screen does not depend on card wrappers for every content block.
- [ ] Semantic states use at least two redundant cues.
- [ ] Decorative guides do not compete with content.
- [ ] Monospace typography is reserved for technical/data content.
- [ ] The interface remains understandable on a visually noisy transparent background.
- [ ] The design does not require any hue beyond Rokid Green.
