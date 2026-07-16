---

name: "aiui-dev"
description: "Specialized agent for developing AIUI applications. Invoke when writing AIUI code, needing API references for jsui/wx, debugging AIUI applications, or aligning AIUI visual design with this Skill's design guidelines."
---

# AIUI Agent Developer Guide

This guide provides independent and comprehensive context for AI agents developing AIUI applications. It includes project structure, SFC `.ink` support specifications, and standard API references, designed to help Large Language Models (LLMs) generate accurate AIUI pages and logic code.

At present, AIUI is used in two forms. These two forms describe the current AIUI product shape only; more forms may be added in the future. Different forms can also transition into one another as the user flow changes, for example from a conversation-flow card into a full-screen page.

- **Conversation-flow cards**: Cards embedded in a conversation flow are display-only and should be treated as non-interactive surfaces for presenting information.
- **Full-screen pages**: Full-screen pages provide complete interaction capabilities and support richer page logic, event handling, and user input.

## 1. Project Structure

A standard AIUI application project typically contains the following core files:

- `AGENTS.md`: The agent manifest, defining the agent's identity and capabilities.
- `app.json`: Global configuration, including page routes, window settings, etc.
- `app.js`: Application lifecycle and global logic.
- `pages/`: Page directory containing the application's pages, primarily using the Single File Component (SFC) `.ink` format.
- `assets/`: Directory for storing static resources like images and audio.

### 1.1 Agent Manifest (AGENTS.md)

The manifest file defines the agent's basic information and required permissions/skills:

```markdown
# Agent Manifest

## Identity
- **Name**: My AIUI Agent
- **Version**: 1.0.0
- **Description**: A brief application description.
- **Author**: Developer Name

## Capabilities
- **Permissions**:
  - camera
  - microphone
  - network
  - audio
- **Skills**:
  - weather-lookup
```

### 1.2 Global Configuration (app.json)

Defines application page paths and global UI styles. The `pages` field is required and declares the routing order for all application pages:

```json
{
  "pages": [
    "pages/index/index"
  ],
  "window": {
    "navigationBarTitleText": "My AIUI Agent",
    "viewport": {
      "width": "device-width"
    }
  }
}
```

- `pages` is an array of page route strings without file extensions.
- Each entry maps to a page directory such as `pages/index/index`, which resolves to the corresponding page files in that folder.
- The first item in the array is treated as the application's default landing page.
- Add new pages here whenever you create additional screens, otherwise the framework will not register them for navigation.

### 1.3 Application Registration (app.js)

AIUI uses an ES module-based registration system, registering the application by exporting a default configuration object:

```javascript
export default {
  onLaunch() {
    console.log('App Launch');
  },
  globalData: {
    userInfo: null
  }
};
```

### 1.4 Page

In AIUI, each page acts as a Model Context Protocol (MCP) UI component. A complete page should define the following parts:

- **Configuration**: Page-level metadata such as `description`, and `schema`. The `description` explains what the page represents, and `schema.data` uses JSON Schema to declare the input data required to render the page.
- **Logic**: Page state, lifecycle hooks, and custom methods used to initialize data and respond to user interactions.
- **Structure**: The UI template that describes the page layout and binds data to components.
- **Style**: The WXSS or CSS rules that control the visual presentation of the page.

When writing page configuration, pay special attention to `description` and `schema.data`:

- `description` should describe the page in natural language from a UI perspective.
  - State what the page displays or helps the user accomplish.
  - Mention the most important dynamic data if the page depends on external input.
  - Keep it specific and observable. Prefer "Displays a weather summary for a city" over "Weather page".
- `schema.data` should define the complete input contract required to render the page.
  - Use `type: "object"` at the top level.
  - Put all render-time fields in `properties`.
  - Use `required` for fields that must exist before the page can render correctly.
  - Add `description`, `enum`, `items`, and nested object definitions when they help clarify the data contract.

Examples:

**Example 1: Weather card page**

```json
{
  "description": "Displays the current weather summary for a city, including temperature, condition, and humidity.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "city": {
          "type": "string",
          "description": "City name shown in the page header"
        },
        "temperature": {
          "type": "number",
          "description": "Current temperature in Celsius"
        },
        "condition": {
          "type": "string",
          "enum": ["sunny", "cloudy", "rainy", "snowy"],
          "description": "Current weather condition"
        },
        "humidity": {
          "type": "number",
          "description": "Current humidity percentage"
        }
      },
      "required": ["city", "temperature", "condition"]
    }
  }
}
```

**Example 2: Product detail page**

```json
{
  "description": "Shows product information for an item, including title, price, primary image, and purchase status.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "title": {
          "type": "string",
          "description": "Product title"
        },
        "price": {
          "type": "number",
          "description": "Current selling price"
        },
        "imageUrl": {
          "type": "string",
          "description": "Primary product image URL"
        },
        "inStock": {
          "type": "boolean",
          "description": "Whether the product can be purchased"
        },
        "tags": {
          "type": "array",
          "description": "Short product labels shown near the title",
          "items": {
            "type": "string"
          }
        }
      },
      "required": ["title", "price", "imageUrl", "inStock"]
    }
  }
}
```

**Example 3: Task list page**

```json
{
  "description": "Renders a task list with completion status, assignee information, and an optional empty-state message.",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "tasks": {
          "type": "array",
          "description": "Tasks displayed in the list",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string",
                "description": "Task identifier"
              },
              "title": {
                "type": "string",
                "description": "Task title"
              },
              "completed": {
                "type": "boolean",
                "description": "Whether the task has been completed"
              },
              "assignee": {
                "type": "string",
                "description": "Person responsible for the task"
              }
            },
            "required": ["id", "title", "completed"]
          }
        },
        "emptyMessage": {
          "type": "string",
          "description": "Message shown when there are no tasks"
        }
      },
      "required": ["tasks"]
    }
  }
}
```

AIUI supports two page authoring modes:

1. **Multi-file mode**: Split the page across separate files such as `page.json`, `page.js`, `page.wxml`, and `page.wxss`.
   - `page.json`: Page configuration and metadata.
   - `page.js`: Page logic, data, lifecycle hooks, and methods.
   - `page.wxml`: Page template structure.
   - `page.wxss`: Page styles.
2. **Single-file mode**: Define the entire page in one `.ink` file.
   - `<script def>`: Page configuration and metadata.
   - `<script setup>`: Page logic, data, lifecycle hooks, and methods.
   - `<page>`: Page template structure.
   - `<style>`: Page styles.

Choose exactly one mode for each page. Do not mix multi-file page definitions with an `.ink` file for the same route.

## 2. Single File Component (SFC) `.ink` Specification

In AIUI, page development is recommended to use the Single File Component (SFC) format, which is the `.ink` file. This format centralizes the page's configuration, logic, structure, and style in a single file.

A standard `.ink` file structure contains four main tag blocks:

1. `<script def>`: Used to define page-level JSON configuration, such as the navigation bar title.
2. `<script setup>`: Contains the page's JavaScript logic code, exporting the page configuration object (including `data`, lifecycle hooks, custom methods, etc.) via `export default`.
3. `<page>`: The page's template structure (WXML-like syntax).
4. `<style>`: The page's stylesheet (CSS).

### 2.1 `.ink` Example Code:

```html
<script def>
{
  "navigationBarTitleText": "Home"
}
</script>

<script setup>
import wx from 'wx';

export default {
  data: {
    greeting: 'Hello AIUI!'
  },
  onLoad() {
    console.log('Page loaded');
  },
  handleTap() {
    this.setData({
      greeting: 'Hello, World!'
    });
  }
}
</script>

<page>
  <view class="container">
    <text class="title">{{ greeting }}</text>
    <button bindtap="handleTap">Click Me</button>
  </view>
</page>

<style>
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
}

.title {
  font-size: 24px;
  margin-bottom: 20px;
}
</style>
```

## 3. WXML (WeiXin Markup Language) & Components

In AIUI, the structure of a page is described using WXML (WeiXin Markup Language), which is used within the `<page>` tag of an `.ink` file (or a standalone `.wxml` file). It allows you to build user interfaces using components, data binding, and conditional rendering.

### 3.1 Basic Syntax and Data Binding

WXML uses double curly braces `{{ }}` for data binding. You can bind properties from your page's `data` object directly to the UI.

```html
<!-- Text binding -->
<view>{{ message }}</view>

<!-- Attribute binding -->
<view class="{{ dynamicClass }}"></view>

<!-- Expression binding -->
<view>{{ count + 1 }}</view>
```

### 3.2 Directives (Conditional Rendering and Lists)

AIUI supports conditional rendering using the `ink:if`, `ink:elif`, and `ink:else` directives to control whether a component is rendered based on a condition.

```html
<view ink:if="{{condition === 1}}"> Rendered if condition is 1 </view>
<view ink:elif="{{condition === 2}}"> Rendered if condition is 2 </view>
<view ink:else> Rendered otherwise </view>
```

AIUI supports basic list rendering with `ink:for`, allowing you to repeat a component structure for each item in an array.

```html
<view ink:for="{{cities}}" ink:key="name">
  <text>{{item.name}}</text>
  <text>{{item.temperature}}</text>
</view>
```

Use `item` to access the current element and `index` to access its position in the array. Prefer providing a stable `ink:key` when rendering dynamic collections.

> **Current Limitation:** Nested `ink:for` is not supported yet. Keep list rendering to a single level, and flatten data in JavaScript first when you need to present hierarchical content.

### 3.3 Built-in Components

AIUI provides a set of built-in components that you can use within your WXML templates. These components are mapped to native implementations for optimal performance.

For parameter-by-parameter documentation, event behavior, content model notes, and examples, see [components.md](./components.md). The reference there is intentionally aligned with the current component registry and implementation details in `ink-builtin-components`.

For runtime API details, constructor behavior, supported overloads, and current implementation limits, see [apis.md](./apis.md). Use the linked domain reference files there when you need Canvas, `wx`, device, media, or AI-specific details.

- **`<view>`**: The fundamental layout container, similar to `<div>` in HTML.
- **`<text>`**: Displays text content. Similar to `<span>` in HTML.
- **`<image>`**: Displays local or remote images.
- **`<button>`**: A standard clickable button component.
- **`<canvas>`**: A component for custom 2D drawing.
- **`<scroll-view>`**: A scrollable container for content that exceeds the visible area.
- **`<chart>`**: A chart component supporting Line, Area, Pie, and Radar charts.
- **`<lottie-view>`**: Renders Lottie animations from inline JSON, local files, or remote URLs.
- **`<error-state>`**: A compact status component that displays an optional icon with a message.

## 4. Events

Besides lifecycle callbacks, AIUI pages also support page-level event handlers for device input such as hardware keys and voice wakeup. These handlers are defined directly on the exported page object.

### 4.1 Page-Level Events

Page-level events are page methods, not WXML binding attributes. Use them when the page itself should react to framework-delivered input events.

```js
export default {
  onKeyDown(event) {
    console.log('key down:', event.code);
  },

  onKeyUp(event) {
    console.log('key up:', event.code);
  },

  onVoiceWakeup(event) {
    console.log('voice wakeup:', event.keyword);
  }
}
```

Supported page-level event callbacks:

| Callback | Description | Trigger |
|---|---|---|
| `onKeyDown(event)` | Handles page-level key press events | Triggered when a key is pressed |
| `onKeyUp(event)` | Handles page-level key release events | Triggered when a key is released |
| `onVoiceWakeup(event)` | Handles page-level voice wakeup events | Triggered when a wake word is detected |

Some page-level events notify the page and then continue the host's built-in default behavior, such as navigating back, scrolling, or activating the focused target. For key events, those default actions are attached to the `onKeyUp(event)` phase, so interception only takes effect when the page prevents the `keyup` event.

```js
export default {
  data: {
    status: 'idle'
  },

  onKeyUp(event) {
    if (event.code === 'Backspace') {
      event.preventDefault();
      this.setData({
        status: 'back action intercepted'
      });
    }
  }
}
```

Use these rules when handling page-level events:

- If `event.preventDefault()` is not called, the host may continue the event's default behavior after the callback finishes.
- `event.preventDefault()` may be called from different handlers, but for key events the host default behavior is defined on `onKeyUp(event)`.
- For that reason, preventing a key event only takes effect when `event.preventDefault()` is applied to `onKeyUp(event)`.
- Interception only matters for events that actually have host-level default behavior.

### 4.2 Default Behaviors

Some events in AIUI are not purely notifications. After the page-level callback runs, the host may still perform a built-in action unless the page explicitly intercepts it.

Common default behaviors include:

- Navigating back when the user presses `Backspace`
- Scrolling the current root container when the user presses `ArrowUp` or `ArrowDown`
- Activating the currently focused target or entering navigation mode when the user presses `Enter`
- Triggering host-defined behavior for device-specific keys when supported by the current runtime

For key events, use `event.preventDefault()` on `onKeyUp(event)` when the page needs to replace the host action with custom logic. This is appropriate when:

- The page manages its own back stack, dialog dismissal, or overlay closing behavior
- The page uses hardware keys for custom focus movement or shortcut handling
- The page wants to block host navigation until validation or confirmation is complete

Do not call `event.preventDefault()` unless the page will provide a clear replacement behavior. If you intercept a default action without updating UI state or performing an alternative action, the page may appear unresponsive.

```js
export default {
  data: {
    dialogVisible: true,
    status: 'idle'
  },

  onKeyUp(event) {
    if (event.code === 'Backspace' && this.data.dialogVisible) {
      event.preventDefault();
      this.setData({
        dialogVisible: false,
        status: 'dialog closed instead of navigating back'
      });
    }
  }
}
```

### 4.3 Key Events

`onKeyDown(event)` is useful for immediate feedback when a hardware key is pressed, such as moving focus or reacting to directional input.

`onKeyDown(event)` is useful for transient feedback, but preventing it does not stop the host's key default behavior because those actions are processed on key release.

`onKeyUp(event)` is useful when the page needs to react after a key is released. It is also the effective interception point for key default behavior, because the host evaluates actions such as back, scroll, and activation on key release. In AIUI hosts such as Rokid Glasses, `event.code` commonly includes:

- `Backspace`: usually navigates back or requests app close unless intercepted
- `ArrowUp`: usually scrolls the root view upward unless intercepted
- `ArrowDown`: usually scrolls the root view downward unless intercepted
- `Enter`: usually enters navigation mode or activates the current target unless intercepted
- `GlobalHook`: a device-specific Rokid Glasses key code for hardware-side touch or shortcut input

> Note:
> Use `GlobalHook` only when you need the fastest possible key response, such as game-style interactions. Its tradeoff is that it is invoked before other key handlers. If you need more consistent key behavior and can tolerate a little latency, it is not recommended.

```js
export default {
  data: {
    status: 'idle'
  },

  onKeyDown(event) {
    if (event.code === 'Enter') {
      this.setData({
        status: 'enter pressed'
      });
    }
  },

  onKeyUp(event) {
    switch (event.code) {
      case 'Backspace':
        event.preventDefault();
        this.setData({ status: 'back action intercepted' });
        break;
      case 'ArrowDown':
        this.setData({ status: 'arrow down received' });
        break;
      case 'Enter':
        this.setData({ status: 'enter released' });
        break;
      case 'GlobalHook':
        this.setData({ status: 'temple button touched' });
        break;
      default:
        break;
    }
  }
}
```

### 4.4 Voice Wakeup Events

`onVoiceWakeup(event)` runs when the host reports a voice wakeup event. Read the matched wake word from `event.keyword`. Some hosts may also provide default handling for voice wakeup; whether interception is supported depends on the host implementation.

```js
export default {
  data: {
    status: 'idle'
  },

  onVoiceWakeup(event) {
    if (event.keyword === 'leqi') {
      this.setData({
        status: 'voice wakeup received'
      });
    }
  }
}
```

## 5. WXSS (WeiXin Style Sheets)

WXSS is a style language used to describe the visual presentation of components. It is highly compatible with standard CSS and is used within the `<style>` block of an `.ink` file (or a standalone `.wxss` file).

For the current confirmed selector support, layout properties, styling properties, and explicitly unsupported authoring assumptions, see [wxss.md](./wxss.md).

### 5.1 Features

WXSS extends standard CSS with features tailored for mobile and wearable devices:

- **`@import`**: You can use the `@import` statement to import external style sheets.

```css
@import "./common.wxss";

.box {
  width: 240px;
  height: 100px;
  background-color: #40FF5E;
}
```

### 5.2 Selectors

AIUI supports most standard CSS selectors:

- **Class Selector (`.class`)**: The recommended way to style components.
- **ID Selector (`#id`)**.
- **Type Selector (`element`)**: e.g., `view`, `text`.
- **Combinators**: Grouping (`A, B`), Descendant (`A B`), Child (`A > B`).

*Recommendation: Prioritize using Class Selectors to ensure optimal rendering performance.*

### 5.3 Layout

AIUI supports both **Flexbox** and **Grid** layout through the Ink CSS engine.

- **Flexbox** is the primary and recommended choice for most one-dimensional layouts such as vertical stacks, horizontal toolbars, centered content, and card internals.
- **Grid** is supported for two-dimensional layouts where rows and columns need to be controlled together.

Supported Flexbox properties include:

- `display: flex`
- `flex-direction`
- `flex-wrap`
- `justify-content`
- `align-items`
- `flex-grow`
- `flex-shrink`
- `flex-basis`
- `gap`, `row-gap`, `column-gap`

Supported Grid properties include:

- `display: grid`
- `grid-template-columns`
- `grid-template-rows`
- `grid-auto-columns`
- `grid-auto-rows`
- `grid-auto-flow`
- `grid-column`, `grid-column-start`, `grid-column-end`
- `grid-row`, `grid-row-start`, `grid-row-end`
- `grid-area`
- `align-content`
- `justify-items`
- `align-self`
- `justify-self`
- `gap`, `row-gap`, `column-gap`

Prefer Flexbox when either layout model can work. Use Grid when the UI clearly benefits from explicit row and column placement.

```css
.container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.dashboard {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: auto auto;
  gap: 12px;
}
```

### 5.4 Styling

AIUI supports a practical subset of CSS properties for visual styling. When generating styles, stay within the properties that are known to be supported by the Ink CSS engine.

Commonly supported styling properties include:

- **Box model and sizing**: `width`, `height`, `min-width`, `min-height`, `max-width`, `max-height`, `margin`, `padding`, `box-sizing`
- **Positioning and overflow**: `position`, `inset`, `overflow`, `overflow-x`, `overflow-y`, `z-index`
- **Colors and backgrounds**: `color`, `background-color`, custom properties, and `var(--token)` references
- **Borders and outlines**: `border`, `border-width`, `border-style`, `border-color`, `border-radius`, `outline`, `outline-width`, `outline-style`, `outline-color`, `outline-offset`
- **Typography**: `font-size`, `line-height`, `font-weight`, `font-family`, `font-style`, `font-variant`, `text-align`, `white-space`, `word-break`
- **Effects and visibility**: `opacity`, `visibility`, `box-shadow`, `filter`, `transform`, `transform-origin`
- **Motion**: `transition`, `transition-property`, `transition-duration`, `transition-timing-function`, `transition-delay`, `animation`, `animation-name`, `animation-duration`, `animation-timing-function`, `animation-delay`, `animation-iteration-count`, `animation-direction`, `animation-fill-mode`

Prefer simple, production-safe CSS. Do not assume browser-only features or unsupported CSS shorthands beyond what AIUI and Ink CSS explicitly support.

When styling AIUI interfaces:

- Prefer AIUI's built-in theme tokens instead of hardcoding colors, spacing, border widths, or radii
- Reference theme values with `var(--token-name)`
- Keep custom properties semantically named when introducing new local tokens

Built-in green theme token reference:

| Token | Category | Purpose |
| --- | --- | --- |
| `--app-width` | App layout | Defines the standard application width. |
| `--app-height-min` | App layout | Defines the minimum recommended application height. |
| `--app-height-max` | App layout | Defines the maximum recommended application height. |
| `--color-primary` | Core colors | Primary brand and action color. |
| `--color-primary-60` | Core colors | Reduced-opacity primary color for secondary emphasis. |
| `--color-primary-40` | Core colors | Lower-opacity primary color for highlights and subtle fills. |
| `--color-secondary` | Core colors | Secondary accent color derived from the primary palette. |
| `--color-background` | Core colors | Default page or app background color. |
| `--color-surface` | Core colors | Surface color for cards and panels. |
| `--color-surface-highlight` | Core colors | Highlighted surface fill for selected or emphasized areas. |
| `--color-text-primary` | Core colors | Default high-priority text color. |
| `--color-text-secondary` | Core colors | Lower-emphasis text color for supporting copy. |
| `--border-width-thin` | Borders and radii | Thin border width for subtle separators and outlines. |
| `--border-width-default` | Borders and radii | Standard border width for common components. |
| `--border-width-strong` | Borders and radii | Heavy border width for strong emphasis. |
| `--border-color-default` | Borders and radii | Default border color for most components. |
| `--border-color-muted` | Borders and radii | Softer border color for low-emphasis dividers. |
| `--border-color-strong` | Borders and radii | Strong border color for emphasized boundaries. |
| `--border-color-accent` | Borders and radii | Accent border color for interactive or highlighted states. |
| `--border-color-success` | Borders and radii | Border color for success states. |
| `--border-color-danger` | Borders and radii | Border color for error or destructive states. |
| `--border-color-warning` | Borders and radii | Border color for warning states. |
| `--border-color-highlight` | Borders and radii | Border color for featured or highlighted elements. |
| `--border-color-contrast` | Borders and radii | High-contrast border color for strong separation. |
| `--border-color-fallback` | Borders and radii | Fallback border color when a semantic border token is unavailable. |
| `--card-border-width` | Borders and radii | Default border width for card components. |
| `--card-border-color` | Borders and radii | Default border color for card components. |
| `--radius-sm` | Borders and radii | Small corner radius. |
| `--radius-md` | Borders and radii | Medium corner radius used by standard components. |
| `--spacing-sm` | Spacing | Small spacing unit. |
| `--spacing-md` | Spacing | Medium spacing unit used for default padding and gaps. |
| `--spacing-lg` | Spacing | Large spacing unit for more open layouts. |
| `--card-padding` | Card tokens | Default inner padding for cards. |
| `--card-title-font-size` | Card tokens | Font size for card titles. |
| `--card-title-gap` | Card tokens | Gap between card title content and adjacent elements. |
| `--card-footer-font-size` | Card tokens | Font size for card footer content. |
| `--card-footer-padding-y` | Card tokens | Vertical padding for card footers. |
| `--card-footer-margin-top` | Card tokens | Top margin separating the footer from body content. |
| `--card-divider-width` | Card tokens | Divider thickness inside cards. |
| `--card-divider-color` | Card tokens | Divider color inside cards. |
| `--card-cover-height` | Card tokens | Standard media or cover area height for cards. |
| `--card-cover-background` | Card tokens | Background color for card cover regions. |
| `--error-state-icon-size` | Error state tokens | Icon size for error-state components. |
| `--error-state-icon-gap` | Error state tokens | Gap between error icon and text. |
| `--error-state-font-size` | Error state tokens | Font size for error-state text. |
| `--error-state-text-color` | Error state tokens | Text color for error-state content. |
| `--error-state-background` | Error state tokens | Background fill for error-state containers. |
| `--error-state-border-width` | Error state tokens | Border width for error-state containers. |
| `--error-state-border-color` | Error state tokens | Border color for error-state containers. |
| `--input-background-color` | Input tokens | Background color for input fields. |
| `--input-border-width` | Input tokens | Border width for input fields. |
| `--input-border-color` | Input tokens | Border color for input fields. |
| `--input-placeholder-color` | Input tokens | Text color for placeholder content. |
| `--input-padding-y` | Input tokens | Vertical padding inside inputs. |
| `--input-padding-x` | Input tokens | Horizontal padding inside inputs. |
| `--input-radius` | Input tokens | Corner radius for inputs. |
| `--calendar-padding` | Calendar tokens | Outer padding for calendar components. |
| `--calendar-background` | Calendar tokens | Background color for calendars. |
| `--calendar-border-width` | Calendar tokens | Border width for calendar containers. |
| `--calendar-border-color` | Calendar tokens | Border color for calendar containers. |
| `--calendar-radius` | Calendar tokens | Corner radius for calendar containers. |
| `--calendar-title-gap` | Calendar tokens | Gap around the calendar title area. |
| `--calendar-title-font-size` | Calendar tokens | Font size for calendar titles. |
| `--calendar-title-color` | Calendar tokens | Text color for calendar titles. |
| `--calendar-weekday-gap` | Calendar tokens | Gap between weekday labels. |
| `--calendar-weekday-font-size` | Calendar tokens | Font size for weekday labels. |
| `--calendar-weekday-color` | Calendar tokens | Text color for weekday labels. |
| `--calendar-cell-min-height` | Calendar tokens | Minimum height for day cells. |
| `--calendar-cell-radius` | Calendar tokens | Corner radius for calendar day cells. |
| `--calendar-selected-indicator-size` | Calendar tokens | Size of the selected-day indicator. |
| `--calendar-day-font-size` | Calendar tokens | Font size for day numbers. |
| `--calendar-day-color` | Calendar tokens | Text color for day numbers. |
| `--calendar-annotation-font-size` | Calendar tokens | Font size for day annotations or notes. |
| `--calendar-holiday-color` | Calendar tokens | Accent color used for holidays. |
| `--calendar-event-color` | Calendar tokens | Accent color used for events. |
| `--calendar-marker-size` | Calendar tokens | Size of event or holiday markers. |
| `--calendar-holiday-marker-color` | Calendar tokens | Marker color for holidays. |
| `--calendar-event-marker-color` | Calendar tokens | Marker color for events. |
| `--calendar-outside-month-color` | Calendar tokens | Text color for days outside the current month. |
| `--calendar-selected-bg` | Calendar tokens | Background color for the selected day. |
| `--calendar-selected-color` | Calendar tokens | Text color for the selected day. |
| `--calendar-today-border-color` | Calendar tokens | Border color used to indicate today. |
| `--calendar-today-text-color` | Calendar tokens | Text color used to indicate today. |
| `--chart-color` | Chart tokens | Primary chart color. |
| `--chart-positive-color` | Chart tokens | Color for positive chart values or trends. |
| `--chart-negative-color` | Chart tokens | Color for negative chart values or trends. |
| `--chart-reference-color` | Chart tokens | Color for reference lines or benchmarks. |
| `--chart-stroke-color` | Chart tokens | Default stroke color for chart lines and frames. |
| `--chart-stroke-width` | Chart tokens | Default stroke width for chart lines and frames. |
| `--chart-radar-fill-color` | Chart tokens | Fill color for radar chart areas. |
| `--chart-fill-style` | Chart tokens | Fill style mode used by chart rendering. |
| `--chart-panel-background` | Chart tokens | Background color for chart panels. |
| `--chart-frame-background` | Chart tokens | Background color for chart frames or plot areas. |
| `--theme-color` | Compatibility tokens | Compatibility token mapping to the main theme color. |
| `--theme-bg` | Compatibility tokens | Compatibility token mapping to the theme background. |
| `--theme-border` | Compatibility tokens | Compatibility token for a default themed border shorthand. |
| `--theme-radius` | Compatibility tokens | Compatibility token mapping to the default radius. |
| `--theme-padding` | Compatibility tokens | Compatibility token mapping to the default padding. |

### 5.5 Fonts

AIUI applications can use both system fonts provided by the host platform and bundled custom fonts declared in `app.json`.

#### System fonts

For common cases, reference a system font directly in `font-family` or in a canvas 2D `font` string:

```xml
<text style="font-family: Arial, sans-serif; font-size: 18px;">
  System font example
</text>
```

```javascript
const ctx = wx.createCanvasContext('myCanvas');
ctx.font = '18px Arial';
ctx.fillText('Canvas system font example', 12, 40);
```

Recommendations:

- Prefer a fallback chain such as `Arial, sans-serif` instead of a single family.
- Do not assume every platform ships the same system fonts.
- Test the final visual result on the actual target host.

#### Bundled custom fonts

If the UI requires a specific typeface, declare it in `app.json` under `fonts`. The runtime bundles the font files with the app and lets both text rendering and canvas rendering reuse the same family name.

```json
{
  "pages": [
    "pages/index/index"
  ],
  "fonts": [
    {
      "family": "Bundled Serif",
      "src": "assets/fonts/NotoSerif-Regular.ttf",
      "weight": 400,
      "style": "normal"
    },
    {
      "family": "Bundled Serif",
      "src": "assets/fonts/NotoSerif-BoldItalic.ttf",
      "weight": 700,
      "style": "italic"
    }
  ]
}
```

After declaration, reference the family name exactly as declared:

```xml
<text style="font-family: 'Bundled Serif', serif; font-size: 20px;">
  Bundled font example
</text>
```

```javascript
const ctx = wx.createCanvasContext('myCanvas');
ctx.font = 'italic 700 24px "Bundled Serif"';
ctx.fillText('Canvas uses bundled fonts', 12, 40);

ctx.font = '24px "Bundled Serif"';
ctx.fillText('Missing glyphs still fall back to system fonts', 12, 80);
```

Bundled font notes:

- `font-family` and canvas `font` share the same bundled family name.
- When multiple weights or styles are declared for one family, the nearest matching face is selected automatically.
- If a bundled resource is missing or cannot be parsed, the app falls back to system fonts.
- Store bundled font files under app-owned assets such as `assets/fonts/` so they can be packaged with the app.
- Prefer a generic fallback family such as `serif` or `sans-serif` after the bundled family name.

When generating AIUI code:

- Use `app.json` `fonts` only when the UI explicitly needs a non-system typeface.
- Keep family names consistent between `app.json`, WXSS, inline `style`, and canvas `font` strings.
- Do not assume web font loading patterns such as remote `@font-face` URLs.

## 6. Design Guidelines

> The full visual design language for **single-green monochrome display** devices (RokidGlasses1 / RokidGlasses2) — color tokens, typography, spacing, radii, border widths, component chrome, and Do's & Don'ts — lives in [`design-system-green.md`](./design-system-green.md). This system currently applies **only** to single-green monochrome hardware; a separate full-color variant does not exist yet. Treat the spec as the source of truth whenever you choose colors, spacing, or component styling on monochrome-green targets; the cheat-sheet below only summarizes the rules that come up most often during code generation.

When developing AIUI applications, especially for wearable devices, it is crucial to follow these design guidelines to ensure a consistent and user-friendly experience.

### 6.1 Dimensions and Layout

- **Width**: The application width is strictly **448px**.
- **Height**: The recommended application height is between **120px and 352px**. The full screen reference size is **448 x 352**. Avoid creating overly tall pages that require excessive scrolling.
- **Card Style**: It is highly recommended to use a **Card Style** layout for each page. This provides a clear boundary and better visual focus in the spatial environment.
- **Default Background**: Use **black** as the default background color.
- **Default Border**: Use a **2px** border as the default border width for cards and key interactive elements.
- **Border Radius**: The recommended border radius (e.g., for cards, buttons, and images) is **12px**.

### 6.2 Color Palette

- **Theme First**: Prefer AIUI's built-in theme tokens as the public styling interface.
- **Token Usage**: Use `var(--color-primary)`, `var(--color-text-primary)`, `var(--color-background)`, `var(--spacing-md)`, `var(--radius-md)`, and related semantic tokens before introducing hardcoded values.
- **Green Theme Reference**: If you intentionally target the green wearable visual language, prefer the built-in green theme tokens instead of hardcoding `#40FF5E`, `rgba(64, 255, 94, 0.6)`, or `rgba(64, 255, 94, 0.4)` directly.
- **Default Text Color**: Prefer semantic text tokens such as `var(--color-text-primary)` or `var(--color-text-secondary)` unless a specific component token is more appropriate.

### 6.3 Prohibitions

- **DO NOT use emoji in generated UI copy, labels, status text, or decorative content by default.** Emoji may only be used when the developer explicitly requests them or the product requirements clearly require them.
- **DO NOT use large areas of solid color blocks.** This can be visually overwhelming and uncomfortable on wearable displays. Keep backgrounds subtle and use colors primarily for accents, text, and interactive elements.

## 7. AIUI API Reference

The detailed runtime API index lives in [apis.md](./apis.md). It links to domain-specific reference files for Canvas, `wx`, device, media, and AI APIs.

When generating code:

- Treat `apis.md` and its linked domain reference files as the source of truth for currently supported API shapes and behaviors.
- Follow the implementation-aligned definitions there instead of assuming standard Web API compatibility.
- Do not infer unlisted overloads, return shapes, or browser semantics.

## 8. Usage Examples (WeChat APIs)

### Take a Photo with Camera

```javascript
import wx from 'wx';

const camera = wx.media.createCameraContext();
const photo = await camera.takePhoto({ quality: 'high' });
console.log('Image data size:', photo.data.byteLength);
```

### Crypto & UUID Generation

```javascript
const uuid = crypto.randomUUID();
const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hello AIUI'));
```
