# View

The `view` component is the basic building block of the user interface. It is similar to the `div` element in HTML.

## Organize Page Content

```xml
<view class="container">
  <view class="item">Item 1</view>
  <view class="item">Item 2</view>
</view>
```

## Features

- Supports Flexbox layout.
- Can contain other components.
- Supports background colors, borders, and standard box model properties.

## Aliases

`row`, `column`, `swiper`, `swiper-item`, `fragment`, and `slot` currently reuse the `view` component implementation. They accept the same child content and CSS layout capabilities. The tag names themselves do not add carousel behavior, automatic row/column styling, or another layout mode.
