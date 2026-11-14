# Streamdown Streaming Rich Text

The `streamdown` component is used to render markdown content with streaming output support. It is especially suitable for displaying dynamic, incrementally received text, such as replies from an AI assistant.

## Usage

```xml
<streamdown 
  content="{{markdownContent}}" 
  streaming="true" 
  color="#333" 
  font-size="16"
></streamdown>
```

## Properties

| Property | Type | Description | Default |
|-----------|------|-------------|---------|
| `content` | String | The markdown content to render. | `""` |
| `streaming` | Boolean | Whether to show a blinking cursor at the end of the text to indicate ongoing typing. | `false` |
| `color` | String | The primary text color of the markdown content. | Inherited |
| `font-size` | Number | The font size of the markdown content. | Inherited |

## Features

- **Markdown Support**: Supports standard markdown syntax, including headings, lists, bold/italic text, and more.
- **Incremental Rendering**: Optimized for partial content updates to achieve a "streaming" output effect.
- **Cursor Animation**: A blinking cursor can be enabled to indicate an active typing/streaming state.
- **Styling**: Standard CSS properties such as text color and font size can be used for styling.
