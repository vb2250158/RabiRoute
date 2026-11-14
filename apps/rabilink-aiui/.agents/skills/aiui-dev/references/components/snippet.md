# Snippet

`snippet` displays inline or block code.

## Display Inline Code

```xml
<p>Call <snippet>start()</snippet> to begin the task.</p>
```

## Display a Code Block

```xml
<snippet style="display: block; white-space: pre;">const ready = true;
console.log(ready);</snippet>
```

`display: block` selects code-block rendering. An inline-compatible subtree uses inline-code rendering; other content falls back to regular container layout.
