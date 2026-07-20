---
version: alpha
name: Rokid AIUI Monochrome-Green Visual Design Language
target:
  devices: ["RokidGlasses1", "RokidGlasses2"]
  display: "single-green monochrome display"
description: Rokid AIUI's visual design language — a transparent-display HUD aesthetic constrained to single-green AR glasses (RokidGlasses1 / RokidGlasses2), whose hardware renders only one luminous green channel over pure black. The entire interface is expressed in that single green across four opacity tiers, with no second hue available. Every surface is a floating card pinned over the real world, structured by clear outlines, translucent fills, and stable whitespace rather than shadow. A wearable, monochrome-HUD system built on a host-driven Design Token theming mechanism, tuned for legibility on single-green-display hardware.

constraints:
  - "Single-green display only — RokidGlasses1 / RokidGlasses2 hardware can reproduce a single green channel; no red, blue, or multi-color output is possible, so the palette is locked to green opacity steps on black."
  - "No second hue for any state (including error/warning) — reds, ambers, and blues cannot render and are expressed via green opacity + border treatment instead."
  - "Transparent display background — the black base is see-through to the real world; the interface floats rather than occludes, so content must stay legible against arbitrary environmental clutter and lighting."
  - "Comfortable FOV / reading distance — content must fit the user's comfortable field of view at arm's length; the canvas is width-locked and height-capped before scrolling."

colors:
  primary: "#40ff5e"                       # Rokid Green — full-opacity accent; titles, key data, high-priority interactions
  primary-60: "rgba(64,255,94,0.6)"        # Medium Green — secondary text, default borders, mid-emphasis layers
  primary-40: "rgba(64,255,94,0.4)"        # Low Green — light fills, surface highlights, muted borders/dividers
  primary-08: "rgba(64,255,94,0.08)"       # Trace Green — input and error-state background fills
  background: "#000000"                    # Pure Black — page-level base tone (transparent-display floor)
  surface: "#000000"                       # Pure Black — card / panel / container base surface
  surface-highlight: "{colors.primary-40}" # Highlighted surface layer — demo blocks, highlighted cards
  ink: "{colors.primary}"                  # Primary text — green on black
  ink-soft: "{colors.primary-60}"          # Secondary text — descriptions, hints, placeholders
  on-primary: "#000000"                    # Text/icon on a solid-green fill — black for contrast
  border-default: "{colors.primary-60}"    # Default neutral outline — most normal frames
  border-muted: "{colors.primary-40}"      # Soft border — dividers and weak separators
  border-accent: "{colors.primary}"        # Accent outline — highlighted containers at theme primary
  border-strong: "{colors.primary}"        # Strong emphasis outline — key states
  error-bg: "{colors.primary-08}"          # Error-hint container background
  error-border: "{colors.border-muted}"    # Error-hint container border
  error-text: "{colors.ink}"               # Error-hint text (stays green — monochrome system)

typography:
  display:
    fontFamily: monospace
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: 0
  heading:
    fontFamily: monospace
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: 0
  body:
    fontFamily: sans-serif
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  body-sm:
    fontFamily: sans-serif
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: 0
  label:
    fontFamily: sans-serif
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0
  caption:
    fontFamily: sans-serif
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0
  mono:
    fontFamily: monospace
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  none: 0px
  sm: 12px
  md: 12px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 18px
  xl: 24px
  xxl: 32px

border-width:
  thin: 1px
  default: 2px
  strong: 4px

components:
  app-canvas:
    description: "The floating-panel / card-based agent surface. Width is fixed to the device form factor; height scrolls once the max is exceeded."
    width: 448px
    height-min: 120px
    height-max: 352px
    backgroundColor: "{colors.background}"
  # Canvas dimension aliases — referenced as {components.app-width}, {components.height-min}, {components.height-max} elsewhere in this spec.
  app-width: 448px
  height-min: 120px
  height-max: 352px
  card:
    description: "Base content container — the foundational surface of every AIUI interface."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-highlight:
    description: "Emphasized card / demo block — one step brighter than a normal surface."
    backgroundColor: "{colors.surface-highlight}"
    borderColor: "{colors.border-accent}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  card-cover:
    description: "Card cover / media header region above the card body."
    height: 180px
    rounded: "{rounded.md}"
  divider:
    description: "Soft separator rule between content blocks."
    backgroundColor: "{colors.border-muted}"
    height: "{border-width.thin}"
  button:
    description: "Clickable element with built-in touch feedback. Renders via the native button component."
    borderColor: "{colors.border-accent}"
    borderWidth: "{border-width.default}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
  text-input:
    description: "Single-line input field baseline."
    backgroundColor: "{colors.primary-08}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.thin}"
    textColor: "{colors.ink}"
    placeholderColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding-y: 10px
    padding-x: 14px
  textarea:
    description: "Multi-line input for long-form content, remarks, and conversation drafts."
    backgroundColor: "{colors.primary-08}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.thin}"
    textColor: "{colors.ink}"
    placeholderColor: "{colors.ink-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding-y: 10px
    padding-x: 14px
  error-state:
    description: "Error-hint container. Notably still green — the monochrome system expresses error via muted border + faint fill rather than a red hue."
    backgroundColor: "{colors.error-bg}"
    borderColor: "{colors.error-border}"
    borderWidth: "{border-width.thin}"
    textColor: "{colors.error-text}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: "{spacing.md}"
  icon:
    description: "Glyph rendered from a font-icon library (e.g. Material Design Icons). Inherits text sizing/color."
    color: "{colors.ink}"
    fontSize: inherit
  list-row:
    description: "A row inside a scrollable list — view-based, separated by muted dividers."
    padding: "{spacing.md}"
    rowBorder: "{colors.border-muted}"
  chart-container:
    description: "Canvas/Chart visualization frame — line, area, pie, radar. Reuses card chrome."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"

  # ─── Examples (illustrative) — kit-mirror demonstration surfaces ───
  ex-pricing-tier:
    description: "Default Pricing tier card. Re-uses card chrome with surface base."
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  ex-pricing-tier-featured:
    description: "Featured/highlighted tier — emphasized surface layer (primary-40 fill + accent border)."
    backgroundColor: "{colors.surface-highlight}"
    textColor: "{colors.ink}"
    borderColor: "{colors.border-accent}"
    borderWidth: "{border-width.strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  ex-product-selector:
    description: "What's Included summary card — re-purposed for agent capability lists."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  ex-cart-drawer:
    description: "Session summary drawer — scrollable list of line items over the surface."
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
    item-divider: "{colors.border-muted}"
  ex-app-shell-row:
    description: "Sidebar / list nav row. Active state uses accent border as the indicator (no shadow)."
    backgroundColor: "{colors.surface}"
    activeIndicator: "{colors.border-accent}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm} {spacing.md}"
  ex-data-table-cell:
    description: "Default data-table th + td chrome. Header uses label typography; body uses body-sm."
    headerBackground: "{colors.surface-highlight}"
    headerTypography: "{typography.label}"
    bodyTypography: "{typography.body-sm}"
    cellPadding: "{spacing.sm}"
    rowBorder: "{colors.border-muted}"
  ex-auth-form-card:
    description: "Sign-in / sign-up card. Re-uses card chrome with text-input primitives inside."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  ex-modal-card:
    description: "Modal dialog surface — card chrome with accent border for emphasis (no elevated shadow)."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-accent}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  ex-empty-state-card:
    description: "Empty-state illustration frame."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-default}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
    captionTypography: "{typography.body-sm}"
  ex-toast:
    description: "Toast notification surface — card shape with accent border."
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-accent}"
    borderWidth: "{border-width.default}"
    rounded: "{rounded.md}"
    padding: "{spacing.sm} {spacing.md}"
    typography: "{typography.body-sm}"

---


## Overview

Rokid AIUI is rendered as a **heads-up display over the real world**, locked to **single-green AR glasses (RokidGlasses1 / RokidGlasses2)**. Where most UI systems reach for full-color palettes and soft Material shadows, AIUI builds itself out of a single luminous green on pure black — a hard constraint forced by the **single-green-display hardware**, which physically can reproduce only the green channel and no other hue. That limitation is then turned into a coherent visual identity. Every interface is a **floating card** pinned in the user's field of view: a `{colors.surface}` black panel outlined in green, filled only with translucent green where emphasis is needed, carrying green text that glows against the transparent backdrop of the physical environment behind it.

The system runs on a **monochrome value ladder rather than a hue range**. A single color — `{colors.primary}` Rokid Green — is the entire chromatic vocabulary. It is deployed at four opacity steps to build the whole hierarchy: full strength (`{colors.primary}`) for titles, key data, and high-priority interaction outlines; 60% (`{colors.primary-60}`) for secondary text, default borders, and mid-emphasis layers; 40% (`{colors.primary-40}`) for light fills, surface highlights, and muted dividers; and 8% (`{colors.primary-08}`) for the faintest input/error fills. There is no second hue. Hierarchy, emphasis, and even error states are expressed entirely through **green opacity + border weight + surface layering**, never through color.

Structure comes from **outlines, not shadows**. The documentation is explicit: this token set favors *light fills, clear outlines, and stable whitespace*, which suits a transparent AR display better than relying on shadows. A card is a `{colors.surface}` black rectangle with a `{border-width.default}` 2px `{colors.border-default}` green-60% outline and `{rounded.md}` 12px corners; emphasis is achieved by stepping the surface to `{colors.surface-highlight}` (green-40% fill) and the border to `{colors.border-accent}` (full green), or thickening the outline to `{border-width.strong}` 4px. The whole thing floats as a `{components.app-canvas}` panel capped at `{spacing.lg}`-aware dimensions — `{components.app-width}` 448px wide, between 120px and 352px tall, scrolling past that rather than expanding unbounded.

The system is **token-driven and host-injected**. AIUI's visual design is not a static color convention but a reusable infrastructure organized around **Design Tokens** (CSS custom properties). The host environment injects the theme first as the default token layer; the application can override variables in `app.wxss`, page styles, and component-local styles. The recommended built-in Ink theme is `yodaos-sprite-greenonly`, which encodes every value below into a single CSS file so that switching themes never requires markup changes.

**Key Characteristics:**
- **Single-green monochrome** — the entire palette is one hue (`{colors.primary}` #40ff5e) at four opacity tiers (100% / 60% / 40% / 8%), on a `{colors.background}` pure-black floor. No secondary hue exists.
- **Card-based floating panels** — every agent interface is a `{components.app-canvas}` 448px-wide panel of stacked `{components.card}` surfaces, height-capped at 352px before it scrolls.
- **Outlines over shadows** — depth is conveyed by border weight and green opacity, never by blurred drop shadows; this is mandated for transparent AR display legibility.
- **Token-first theming** — all visuals are expressed as CSS custom properties (`--color-*`, `--border-*`, `--radius-*`, `--spacing-*`) injected by the host, overridable by the app.
- **`yodaos-sprite-greenonly` baseline** — black background + green foreground, tuned for contrast and comfort on single-green-display hardware.
- **Error states stay green** — validation/error uses a faint green-08% fill with a muted green-40% border; the monochrome discipline is never broken with a red hue.
- **Clear + simple + brand-consistent** — readability across lighting/distance, stable information hierarchy via surfaces/borders/type/spacing, and continuation of Rokid's green AR visual language.

## Colors

The palette is a **single green at four opacities over pure black**, dictated by the single-green display of RokidGlasses1 / RokidGlasses2 — the hardware renders only the green channel, so no red, blue, or secondary hue is physically available. Read it as a value ladder: every emphasis decision is an opacity step on the same hue, never a different color.

### Brand & Accent
- **Rokid Green** (`{colors.primary}` — #40ff5e): The one and only hue. The primary brand color and core accent, used for titles, key data, and high-priority interaction outlines. Full opacity is the highest-emphasis state in the system — reserve it for what should glow brightest.
- **Medium Green** (`{colors.primary-60}` — rgba(64,255,94,0.6)): Mid emphasis. Carries secondary text, the default `{colors.border-default}` outline on most containers, and weaker accent layers. The "normal" green for chrome.
- **Low Green** (`{colors.primary-40}` — rgba(64,255,94,0.4)): Light fills and highlights. Drives `{colors.surface-highlight}`, muted `{colors.border-muted}` dividers, and background hint layers.
- **Trace Green** (`{colors.primary-08}` — rgba(64,255,94,0.08)): The faintest tint. Used exclusively as the background fill for `{components.text-input}` and `{components.error-state}` — just enough to suggest a recessed field without competing with content.

### Surface
- **Pure Black** (`{colors.background}` / `{colors.surface}` — #000000): The page-level base tone and the base surface for cards, panels, and containers. On a transparent AR display this black reads as "see-through to the real world" — the interface floats rather than occludes.
- **Highlight Surface** (`{colors.surface-highlight}` — `{colors.primary-40}`): A more emphasized background layer than normal surfaces, for highlighted cards and demo blocks. The only surface variant — there is no grayscale ramp.

### Text
- **Primary Text** (`{colors.ink}` — `{colors.primary}`): Titles, body text, and high-contrast labels — luminous green on black.
- **Secondary Text** (`{colors.ink-soft}` — `{colors.primary-60}`): Descriptions, hints, placeholders, and de-emphasized information.
- **On-Primary** (`{colors.on-primary}` — #000000): Text or icon sitting on a hypothetical solid-green fill — black for contrast. Rarely needed in the steady state since fills stay translucent.

### Border
- **Default Border** (`{colors.border-default}` — `{colors.primary-60}`): The default neutral outline, suitable for most normal frames.
- **Muted Border** (`{colors.border-muted}` — `{colors.primary-40}`): Softer border for dividers and weak separators.
- **Accent Border** (`{colors.border-accent}` / `{colors.border-strong}` — `{colors.primary}`): Full-green outline for highlighted containers and key states.

### Semantic
- **Error / Alert**: Not a separate color. Error hints use `{colors.error-bg}` (green-08% fill), `{colors.error-border}` (muted green-40% border), and `{colors.error-text}` (primary green text). The monochrome discipline is preserved — emphasis comes from the container treatment, not a red hue.

## Typography

### Font Family
AIUI renders through a **Skia-powered native runtime** and follows Web/WXSS CSS conventions, so typography is expressed as standard CSS rather than a bespoke typeface system. The spec is **font-agnostic**: it defines only generic families — `sans-serif` for body/labels/captions and `monospace` for titles, headings, and code — which resolve to the platform default (e.g. Roboto / the system sans and the system monospace on Android, and the browser default sans/mono elsewhere). For this HUD aesthetic, **titles use the monospace stack** — the fixed-width numerals and fixed advance read like a heads-up terminal display over the real world, which suits the single-green monochrome hardware (RokidGlasses1 / RokidGlasses2). Body copy and UI labels stay on the proportional sans-serif stack for reading comfort. The visual spec defers type to the theme layer and WXSS is highly compatible with standard CSS, so these are host/application-overridable tokens; no named typeface is mandated.

### Hierarchy

> The `typography.*` tokens above are the recommended baseline scale for this HUD aesthetic, calibrated to the 448px-wide card context and AR-glasses readability. They are host/application-overridable — the theme layer and WXSS may replace them without changing markup.

| Token | Font | Size | Weight | Line Height | Letter Spacing | Use |
|---|---|---|---|---|---|---|
| `{typography.display}` | monospace | 24px | 700 | 1.25 | 0 | Card hero titles, panel headings — HUD-terminal voice |
| `{typography.heading}` | monospace | 18px | 700 | 1.3 | 0 | Section headings within a card |
| `{typography.body}` | sans-serif | 15px | 400 | 1.5 | 0 | Primary body copy, descriptions |
| `{typography.body-sm}` | sans-serif | 13px | 400 | 1.45 | 0 | Dense lists, table cells, secondary copy |
| `{typography.label}` | sans-serif | 13px | 600 | 1.3 | 0 | Button text, input labels, list headers |
| `{typography.caption}` | sans-serif | 11px | 400 | 1.4 | 0 | Timestamps, metadata, fine print |
| `{typography.mono}` | monospace | 13px | 400 | 1.4 | 0 | Code, data values, technical content |

### Principles
- **Titles are mono, body is proportional.** `{typography.display}` and `{typography.heading}` use the system monospace stack to evoke a fixed-width heads-up terminal; body, labels, and captions stay on the proportional sans-serif stack for reading comfort. The mono/proportional split is itself a hierarchy cue on a single-color display.
- **Hierarchy is by weight and size, not color.** Since the whole palette is green, type emphasis must come from size and weight contrast. Titles go bold and larger; body stays regular and small; the green opacity ladder (`{colors.ink}` vs `{colors.ink-soft}`) handles the secondary tier.
- **Readable at distance.** Body text floors at ~15px because AR content is read at arm's length or beyond over a transparent backdrop on RokidGlasses1 / RokidGlasses2; smaller sizes risk illegibility against real-world clutter.
- **Type is themeable and font-agnostic.** The spec defines families as generic `sans-serif` / `monospace` stacks and does not mandate any named typeface. Font family, sizes, and weights should be tokenized so a host theme can swap them without touching markup — consistent with the Design Token philosophy.

### Note on Font Substitutes
No specific typeface is required. The spec intentionally uses generic CSS families — `sans-serif` for body/labels/captions and `monospace` for titles, headings, and code — which resolve to the platform default (e.g. Roboto / the system sans and the system monospace on Android and browser defaults). Because WXSS follows standard CSS, any system font stack works; the visual identity does not depend on a named typeface, only on the green-on-black value discipline and the mono/proportional hierarchy split. Note the device constraint: on RokidGlasses1 / RokidGlasses2 only the green channel renders, so anti-aliasing and weight should be chosen for crisp green-on-black reproduction on a single-green display.

## Layout

### Spacing System
- **Base tokens** (from `yodaos-sprite-greenonly`): `{spacing.sm}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 18px.
- **Extended scale** (recommended): `{spacing.xs}` 4px · `{spacing.sm}` 8px · `{spacing.md}` 12px · `{spacing.lg}` 18px · `{spacing.xl}` 24px · `{spacing.xxl}` 32px.
- `{spacing.sm}` (8px) is the compact rhythm — icon gaps and small padding. `{spacing.md}` (12px) is the standard component padding (and the default `{components.card}` interior). `{spacing.lg}` (18px) is page padding and section spacing. The layout favors **stable, moderate whitespace** — enough to keep structure clear on a cluttered real-world backdrop, never so much that the card sprawls.

### Grid & Container
- **Fixed-width canvas**: the app surface is `{components.app-width}` 448px wide, between `{components.height-min}` 120px and `{components.height-max}` 352px tall. This is the default size reference for floating panels and card-based agent interfaces. Beyond the max height, content **scrolls** rather than expanding unbounded — a `{components.scroll-view}` takes over.
- **Card-based composition**: the body is a vertical stack of `{components.card}` panels inside the canvas. There is no multi-column desktop grid — the wearable form factor enforces a single, scrollable column.
- **Flexbox layout**: containers use Flexbox (via the `view` component) for arrangement; `scroll-view` provides horizontal/vertical scrolling when content overflows.

### Whitespace Philosophy
Whitespace is **structural clarity over a transparent backdrop**. Because the card floats over the real world, padding and gaps must be deliberate enough to separate content from environmental noise — hence the "stable whitespace" mandate. But the panel is height-capped and width-fixed, so whitespace never becomes luxury breathing room; it is a measured seam that keeps each card readable without sprawling past the user's comfortable field of view.

### Responsive Strategy

#### Breakpoints
| Name | Width | Key Changes |
|---|---|---|
| Wearable canvas | 448px fixed | The native, sole target — a floating panel sized to the glasses' display form factor |
| Host-resized | varies | The host controls the canvas; the app does not reflow independently |

This is a **fixed-canvas, form-factor-locked** design. It is authored for the single-green AR glasses (RokidGlasses1 / RokidGlasses2) display and does not fluidly reflow. The host theme (`--app-width`, `--app-height-min/max`) defines the geometry; the application fills it. Content that exceeds `{components.height-max}` enters a `{components.scroll-view}` scroll layout rather than resizing.

#### Touch Targets
Interaction on Rokid Glasses is **non-touch by default**: voice input (the core mode), temple slide/tap, and head tracking. The `{components.button}` carries built-in touch/feedback support for when taps occur, but the primary targeting is gaze + tap, so hit areas should stay comfortable rather than micro-precise.

#### Image Behavior
The `{components.image}` supports local and (planned) network images with `aspect fit` / `aspect fill` scaling modes. Card covers sit in a fixed `{components.card-cover}` 180px-tall header region, clipped to the card's `{rounded.md}` corners. **Single-green constraint:** imagery will be reproduced only in the green channel, so prefer high-luminance/green-friendly assets and avoid relying on red/blue hue cues for meaning.

## Elevation & Depth

Depth in this system is **outline and opacity, not shadow**. The documentation is explicit: the token set favors light fills, clear outlines, and stable whitespace because that suits transparent AR display better than shadows. There is no blurred drop-shadow vocabulary.

| Level | Treatment | Use |
|---|---|---|
| 0 — Recessed field | Faint `{colors.primary-08}` green fill + thin `{colors.border-default}` outline | `{components.text-input}`, `{components.textarea}`, `{components.error-state}` |
| 1 — Card | `{colors.surface}` black + `{border-width.default}` 2px `{colors.border-default}` outline | Default `{components.card}`, chart containers |
| 2 — Highlighted card | `{colors.surface-highlight}` green-40% fill + `{colors.border-accent}` full-green outline (or `{border-width.strong}` 4px) | Emphasized cards, demo blocks, featured content |
| 3 — Accent emphasis | Full-green `{colors.border-accent}` outline + `{border-width.strong}` 4px | Key interactive states, active rows |

### Decorative Depth
Where a softer system would use shadows, AIUI uses **surface opacity** — stepping the fill from black (`{colors.surface}`) to green-40% (`{colors.surface-highlight}`) is the equivalent of raising a card. The "glow" of full-green text and borders against pure black supplies all the visual pop; no `box-shadow` is required or recommended.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Sharp edges (rare — the system leans rounded) |
| `{rounded.sm}` | 12px | Inputs, compact elements, buttons, icon frames |
| `{rounded.md}` | 12px | Standard radius — cards and most containers |
| `{rounded.full}` | 9999px | Pills, badges (recommended for status chips) |

The signature is **consistently moderate rounding**. Notably, in `yodaos-sprite-greenonly` both `{rounded.sm}` and `{rounded.md}` resolve to **12px** — the system uses a single, generous corner radius across inputs and cards alike. This uniform roundness reads as friendly and legible on a small wearable surface; there is no sharp-edge identity here (contrast with hard-chrome systems). The uniform 12px also simplifies the token layer: one radius value governs nearly every container.

### Container Geometry
Cards are rectangles at the `{components.app-canvas}` width with `{rounded.md}` corners and a `{border-width.default}` green outline. The cover/media header is a fixed 180px band clipped to the same radius. There are no chamfers, bevels, or textured geometry — shapes are flat, outlined, and translucent, which is what a transparent display renders cleanly.

## Components

> AIUI's visual spec defines tokens, not exhaustive component states. The specs below combine the official component-token defaults (`card`, `input`, `error-state`) with the built-in native components (`view`, `scroll-view`, `text`, `icon`, `button`, `image`, `calendar`, `canvas`, `chart`, `a2ui`). No hover states are documented; the system targets gaze/voice/tap interaction with built-in feedback.

### Layout & Containers

**`app-canvas`** — Floating agent surface
- The fixed-width card-based panel: `{components.app-width}` 448px wide, between `{components.height-min}` 120px and `{components.height-max}` 352px tall, on a `{colors.background}` black floor. Once height exceeds the max, a scroll layout takes over.

**`card`** — Base content container
- The foundational surface. `{colors.surface}` black fill, `{border-width.default}` 2px `{colors.border-default}` (green-60%) outline, `{rounded.md}` 12px corners, `{spacing.md}` 12px interior padding. Nearly every interface is a stack of these.

**`card-highlight`** — Emphasized card / demo block
- One step brighter: `{colors.surface-highlight}` (green-40%) fill with a `{colors.border-accent}` full-green outline. The "raised" surface — used for highlighted cards and demo blocks in lieu of shadow.

**`card-cover`** — Card media header
- A fixed `{components.card-cover}` 180px-tall region above the card body holding the `{components.image}` cover, clipped to `{rounded.md}`.

**`divider`** — Soft separator
- A `{border-width.thin}` 1px `{colors.border-muted}` (green-40%) rule between content blocks. The standard separator — muted rather than full-opacity.

### Inputs & Forms

**`text-input`** — Single-line input
- `{colors.primary-08}` faint-green fill, `{border-width.thin}` 1px `{colors.border-default}` outline, `{colors.ink}` green text, `{colors.ink-soft}` placeholder, `{rounded.sm}` 12px corners, 10px × 14px padding. The recessed field — depth comes from the trace fill, not shadow.

**`textarea`** — Multi-line input
- Same chassis as `text-input`, for long-form content, remarks, and conversation drafts.

**`error-state`** — Error hint container
- `{colors.error-bg}` green-08% fill, `{colors.error-border}` muted green-40% border, `{colors.error-text}` primary-green text. **Stays green** — the monochrome system expresses error via container treatment, never a red hue.

### Buttons & Content

**`button`** — Clickable element
- The native `button` component with built-in touch feedback. Full-green `{colors.border-accent}` outline, `{colors.ink}` green label in `{typography.label}`, `{rounded.sm}` corners. Emphasis is by border, not by a filled colored background.

**`icon`** — Glyph
- A font-icon (e.g. Material Design Icons) inheriting `text` sizing/color. Renders in `{colors.ink}` green; sizing comes from `font-size`.

**`list-row`** — Scrollable list row
- A `view`-based row inside a `scroll-view`, `{spacing.md}` padding, separated by `{colors.border-muted}` dividers.

**`chart-container`** — Data visualization frame
- Canvas/Chart surface (line, area, pie, radar) reusing the `{components.card}` chrome: black fill, green outline, 12px radius. Turns structured agent data into visualizations.

### Built-in Native Components
AIUI ships these components rendered natively through Skia: `view` (flex container), `scroll-view` (scrollable container with `scroll-x`/`scroll-y`), `text`, `icon`, `error-state`, `streamdown` (streaming markdown), `button`, `calendar` (date browsing/selection), `image`, `lottie-view` (animation), `canvas` (2D drawing), `chart`, and `a2ui` (AI interaction surface for voice/multi-turn/task flows).

### Examples (illustrative)

> Kit-mirror demonstration surfaces. Each `ex-*` entry references brand-native primitives so downstream consumers re-skin the same 10 surfaces consistently — always via outlines and green-opacity, never shadows.

**`ex-pricing-tier`** — Default Pricing tier card. Re-uses card chrome with surface base.
- Properties: `backgroundColor`, `textColor`, `borderColor`, `borderWidth`, `rounded`, `padding`

**`ex-pricing-tier-featured`** — Featured/highlighted tier — emphasized surface layer (primary-40 fill + accent border, thickened to strong).
- Properties: `backgroundColor`, `textColor`, `borderColor`, `borderWidth`, `rounded`, `padding`

**`ex-product-selector`** — What's Included summary card — re-purposed for agent capability lists.
- Properties: `backgroundColor`, `borderColor`, `borderWidth`, `rounded`, `padding`

**`ex-cart-drawer`** — Session summary drawer — scrollable list of line items over the surface.
- Properties: `backgroundColor`, `rounded`, `padding`, `item-divider`

**`ex-app-shell-row`** — Sidebar / list nav row. Active state uses accent border as the indicator (no shadow).
- Properties: `backgroundColor`, `activeIndicator`, `rounded`, `padding`

**`ex-data-table-cell`** — Default data-table th + td chrome. Header uses label typography on highlight surface; body uses body-sm.
- Properties: `headerBackground`, `headerTypography`, `bodyTypography`, `cellPadding`, `rowBorder`

**`ex-auth-form-card`** — Sign-in / sign-up card. Re-uses card chrome with text-input primitives inside.
- Properties: `backgroundColor`, `borderColor`, `borderWidth`, `rounded`, `padding`

**`ex-modal-card`** — Modal dialog surface — card chrome with accent border for emphasis (no elevated shadow).
- Properties: `backgroundColor`, `borderColor`, `borderWidth`, `rounded`, `padding`

**`ex-empty-state-card`** — Empty-state illustration frame.
- Properties: `backgroundColor`, `borderColor`, `borderWidth`, `rounded`, `padding`, `captionTypography`

**`ex-toast`** — Toast notification surface — card shape with accent border.
- Properties: `backgroundColor`, `borderColor`, `borderWidth`, `rounded`, `padding`, `typography`


## Do's and Don'ts

### Do
- Build every surface as an **outlined card**: a `{colors.surface}` black body with a green outline (`{colors.border-default}` at minimum). Outlines, not shadows, define structure on a transparent AR display.
- Express hierarchy through the **green opacity ladder** — `{colors.primary}` for emphasis, `{colors.primary-60}` for secondary text/borders, `{colors.primary-40}` for fills/dividers, `{colors.primary-08}` for recessed fields. One hue, four steps.
- Keep within the **fixed canvas** (`{components.app-width}` 448px, height ≤ 352px) and switch to a `{components.scroll-view}` when content overflows — don't let the card sprawl past the user's comfortable FOV.
- **Tokenize first**: define visuals from `--color-*`, `--border-*`, `--radius-*`, `--spacing-*` tokens instead of hardcoding, so the host theme and app overrides stay consistent.
- Default to `{rounded.md}` (12px) corners — the `yodaos-sprite-greenonly` theme uses one generous radius across inputs and cards for clean, legible wearable surfaces.
- Reuse the `card`, `input`, and `error-state` token groups when designing new components to keep the system unified.
- Raise emphasis by **stepping the surface** to `{colors.surface-highlight}` and/or the border to `{colors.border-accent}` / `{border-width.strong}` — that is the system's elevation language.
- Treat the **single-green display as a hard constraint** — design for RokidGlasses1 / RokidGlasses2, where only the green channel renders; encode all visuals (including imagery and charts) to survive green-only reproduction.

### Don't
- Don't introduce a **second hue**. Adding red for errors, blue for links, or gray for muted states is impossible on RokidGlasses1 / RokidGlasses2's single-green display and breaks the monochrome identity.
- Don't use **blurred drop shadows** for elevation. The spec is explicit — light fills, clear outlines, and stable whitespace suit transparent AR display better than shadows.
- Don't use **red for error states** — error hints use `{colors.primary-08}` fill + `{colors.border-muted}` border and stay green (red cannot render on the single-green hardware).
- Don't hardcode colors or spacing directly in pages; bypassing the token layer breaks host-driven theming and theme switching.
- Don't expand the canvas beyond `{components.height-max}` (352px) without switching to a scroll layout — unbounded growth pushes content out of the user's comfortable field of view on the glasses.
- Don't rely on fine mouse hover states; the primary interaction is voice + gaze + temple tap, so emphasize gaze-readable contrast and tap feedback over hover affordances.
- Don't flatten type hierarchy into a single size — since color can't differentiate emphasis, size and weight (plus the mono/proportional split) must carry the structure.
- Don't rely on red/blue hue cues in images or data visualizations — on a single-green display those channels are lost; encode meaning via luminance, position, and labels instead.
