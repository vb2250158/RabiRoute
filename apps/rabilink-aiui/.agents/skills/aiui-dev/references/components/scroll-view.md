# ScrollView

The `scroll-view` component is a scrollable view container that allows users to scroll when the content exceeds the visible area.

## Usage

```xml
<scroll-view class="scroll-container" scroll-y="true">
  <view class="item">项目 1</view>
  <view class="item">项目 2</view>
  <view class="item">项目 3</view>
  <!-- 更多项目 -->
</scroll-view>
```

## Properties

| Property | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `scroll-x` | Boolean | `false` | Enables horizontal scrolling. |
| `scroll-y` | Boolean | `false` | Enables vertical scrolling. |
| `scroll-top` | Number | - | Sets the vertical scroll position. |
| `scroll-left` | Number | - | Sets the horizontal scroll position. |
| `scroll-into-view` | String | - | Scrolls to the position of the element with the corresponding ID. |
| `auto-scroll` | Boolean | `false` | Enables automatic scrolling. |
| `scroll-speed` | Number | `25.0` | The speed of automatic scrolling. |
| `scroll-direction` | String | `vertical` | The direction of automatic scrolling (`vertical` or `horizontal`). |

## Features

- Supports both horizontal and vertical scrolling.
- Supports touch and mouse drag gestures.
- Supports mouse wheel scrolling.
- Supports automatic scrolling with custom speed and direction.
