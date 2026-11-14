# Formula

`formula` renders inline or block mathematics from TeX-style source.

## Insert a Formula in Text

```xml
<p>The energy relation is <formula>E = mc^2</formula>.</p>
```

## Display a Standalone Formula

```xml
<formula style="display: block;">\frac{a + b}{2}</formula>
```

Inside `p`, `header`, `blockquote`, or `list-item`, it renders inline; elsewhere it renders as a block. If formula image generation fails, the source text remains visible.
