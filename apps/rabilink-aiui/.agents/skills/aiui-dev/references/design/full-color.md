# Rokid Color Full-Color Design

Use this reference for Rokid Color (乐奇全彩眼镜). The complete [design specification](https://github.com/yodaos-project/AIUI/blob/main/design/fullcolor/design.md) defines the full token and component set.

## Layout

- The full-screen design reference is **480 × 352** logical units.
- A conversation card has a **480**-wide reference container and a height that adapts to its content. Do not fix its height to 352.
- Adapt both surfaces to the actual container width and available height; 480 is the container reference, not the width of the inner content. Include FOV clearance, card padding, and borders in the available space.
- The current full-color theme defaults `--app-width` to `448px`. Override it as needed, respecting the actual container. Theme defaults do not automatically make custom layouts responsive.
- Keep essential content accessible. Use summaries and details, pagination, or an operable scroll region when content exceeds the available space; do not clip actions or shrink text to fit.

## Visual baseline

- Use 14–24 dp text, icons at least 12 × 12, white body text, bright accents, and transparent containers. Black appears transparent on the glasses.
- Keep 10 units of clearance to FOV edges and card padding of 10 horizontally and 24 vertically. Apply the clearance once.
- The outermost card is borderless. Internal cards use a 12-unit radius and a 1px white inside border at 30% alpha, changing to 100% on focus or selection.
- Check readability and interactions on the target device against real backgrounds and lighting.

## Recommended palette

- The design specification includes ten-step cyan, green, violet, red, gray, and yellow scales and a transparent white alpha scale. These are recommendations, not built-in theme defaults; select or override colors explicitly.
- Reference semantic bases: `cyan5` `#39D6E0`, `red5` `#FF5855`, `green5` `#4ED149`, and `yellow5` `#FFCC66`. Neutral hierarchy: `gray10`, `gray7`, `gray5`, `gray3`.
- Darker and low-alpha variants can be hard to see on transparent glasses. Keep essential foreground readable, use the 40% minimum alpha recommendation, and validate against real backgrounds. Internal card borders remain the 30% exception.
