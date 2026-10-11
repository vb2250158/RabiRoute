English | [简体中文](README.md)

# Bubble texture

`bubble-cat-paw-body-v2.png` is an imagegen-generated transparent RGBA body, 1254 × 1254, without a pointer, text or controls. Original v1 is retained for provenance; runtime uses v2.

The continuous opaque center defines the body, excluding transparent source padding. Slice at 25% and 65% of body width, and 24% and 72% of body height. Fixed destination insets: left 40 px, right 84 px, top 28 px, bottom 50 px. Corners and bottom-right paw stay fixed while center and edge strips stretch.

Qt draws the pointer independently in a 14 px strip, aiming at the visible pet artwork's horizontal center. The frame clamps to the screen's available area while the pointer continues tracking the pet. If there is insufficient room above, the bubble moves below the pet with an upward pointer; the paw remains at the body's bottom-right.

The built-in imagegen tool produced the original transparency without image post-processing. The edit prompt is in `bubble-cat-paw-body-v2.prompt.json`. Use new versioned filenames for replacements and check slice coordinates, alpha edges, short/long text and pointer seams.
