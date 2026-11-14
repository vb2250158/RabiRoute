# Swiper

`swiper` and `swiper-item` are view-container tags for organizing paged content. They currently provide content grouping and CSS layout, but they do not create a carousel automatically.

## Organize Paged Content

```xml
<swiper class="swiper">
  <swiper-item class="page"><text>Page one</text></swiper-item>
  <swiper-item class="page"><text>Page two</text></swiper-item>
</swiper>
```

```css
.swiper {
  display: flex;
  flex-direction: row;
}

.page {
  width: 100%;
  flex-shrink: 0;
}
```

## Current Behavior

`swiper` and `swiper-item` currently use the same basic container implementation as `view`. They support child nodes and CSS layout, but do not provide built-in pagination state, autoplay, indicators, or change events. Implement those behaviors in page logic and styles.

If you only need a regular horizontal layout, `view` is usually easier to understand. Choose `swiper` when its name helps communicate that the children represent separate pages.
