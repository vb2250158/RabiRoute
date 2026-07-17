<!-- docs-language-switch -->
<div align="center">
<a href="./aiui-canvas-2d-reference_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# AIUI Canvas 2D 接口速查

本文记录 AIUI `canvas` 组件提供的 Web 标准风格 Canvas 2D 绘图接口，并补充 Rokid 单色眼镜与 RabiLink 项目的使用边界。基础组件选择说明见 [AIUI 框架与逻辑开发笔记](aiui-framework-and-logic-development.md)。

## 1. 获取绘图上下文

```xml
<canvas id="myCanvas" width="300" height="150"></canvas>
```

```javascript
const canvas = this.selectComponent("#myCanvas");
const ctx = canvas.getContext("2d");
```

- `width` 和 `height` 定义绘图缓冲区像素尺寸。
- Canvas 组件创建完成后才能调用 `selectComponent()`，不要在 `onLoad()` 中假设视图已经存在。
- `canvas`、`ctx`、图片和 ImageData 保存到页面实例 `this`，不要放进可 JSON 序列化的 `data`。

## 2. `CanvasRenderingContext2D` 属性

| 属性 | 类型 | 说明 | 常见值 |
| --- | --- | --- | --- |
| `fillStyle` | String / CanvasGradient / CanvasPattern | 填充样式 | 颜色、渐变、图案 |
| `strokeStyle` | String / CanvasGradient / CanvasPattern | 描边样式 | 颜色、渐变、图案 |
| `lineWidth` | Number | 线宽 | 正数 |
| `lineCap` | String | 线段末端 | `butt`、`round`、`square` |
| `lineJoin` | String | 线段连接 | `miter`、`round`、`bevel` |
| `lineDashOffset` | Number | 虚线偏移 | 数值 |
| `shadowBlur` | Number | 阴影模糊程度 | 非负数 |
| `shadowColor` | String | 阴影颜色 | 颜色字符串 |
| `shadowOffsetX` | Number | 阴影水平偏移 | 数值 |
| `shadowOffsetY` | Number | 阴影垂直偏移 | 数值 |
| `globalAlpha` | Number | 全局透明度 | `0.0` 到 `1.0` |
| `globalCompositeOperation` | String | 图层混合方式 | `source-over`、`copy`、`lighter`、`multiply` 等 |
| `font` | String | 当前字体 | 例如 `20px sans-serif` |
| `textAlign` | String | 水平对齐 | `left`、`center`、`right`、`start`、`end` |
| `textBaseline` | String | 文本基线 | `top`、`middle`、`bottom`、`alphabetic` 等 |

Rokid 单色绿色显示设备不能可靠呈现红、蓝等色相差异。即使 API 接受完整颜色字符串，设计含义仍应通过亮度、透明度、线型、形状和文字表达。

## 3. 矩形和文本

| 方法 | 作用 |
| --- | --- |
| `fillRect(x, y, width, height)` | 绘制填充矩形 |
| `strokeRect(x, y, width, height)` | 绘制矩形边框 |
| `clearRect(x, y, width, height)` | 清除指定区域 |
| `fillText(text, x, y, maxWidth?)` | 绘制填充文本 |
| `strokeText(text, x, y, maxWidth?)` | 绘制描边文本 |
| `measureText(text)` | 测量文本，返回含 `width` 的结果 |

```javascript
ctx.fillStyle = "#40ff5e";
ctx.fillRect(10, 10, 100, 48);

ctx.font = "24px sans-serif";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("RabiLink", 60, 34, 96);
```

Canvas 文本不会自动换行、截断或响应 WXML 布局。绘制前必须使用 `measureText()` 计算宽度；多语言、字体回退和真机字形仍需实际验证。普通 HUD 文本优先使用 `text` 组件。

## 4. 路径

| 方法 | 作用 |
| --- | --- |
| `beginPath()` | 开始新路径 |
| `closePath()` | 闭合当前路径 |
| `moveTo(x, y)` | 移动路径起点 |
| `lineTo(x, y)` | 从当前位置绘制直线 |
| `arc(x, y, r, start, end, anticlockwise?)` | 绘制圆弧 |
| `arcTo(x1, y1, x2, y2, r)` | 绘制两线段之间的切线圆弧 |
| `rect(x, y, width, height)` | 将矩形加入当前路径 |
| `ellipse(x, y, rx, ry, rotation, start, end, anticlockwise?)` | 绘制椭圆 |
| `bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)` | 三次贝塞尔曲线 |
| `quadraticCurveTo(cpx, cpy, x, y)` | 二次贝塞尔曲线 |
| `fill()` | 填充当前路径 |
| `stroke()` | 描边当前路径 |
| `clip()` | 使用当前路径裁剪后续绘制 |

```javascript
ctx.beginPath();
ctx.arc(60, 60, 40, 0, Math.PI * 2);
ctx.strokeStyle = "#40ff5e";
ctx.lineWidth = 3;
ctx.stroke();
```

每个独立图形前调用 `beginPath()`，避免前一条路径被意外再次填充或描边。`clip()` 会修改后续绘制范围，通常应与 `save()` / `restore()` 配对。

## 5. 状态与变换

| 方法 | 作用 |
| --- | --- |
| `save()` | 保存当前绘图状态 |
| `restore()` | 恢复最近一次保存的状态 |
| `translate(dx, dy)` | 平移坐标系 |
| `rotate(angle)` | 按弧度旋转坐标系 |
| `scale(sx, sy)` | 缩放坐标系 |

```javascript
ctx.save();
ctx.translate(100, 100);
ctx.rotate(Math.PI / 4);
ctx.scale(1.5, 1.5);
ctx.fillStyle = "#40ff5e";
ctx.fillRect(-25, -25, 50, 50);
ctx.restore();
```

局部变换必须使用 `save()` / `restore()` 包围，避免坐标系、透明度、裁剪或样式泄漏到后续绘制。动画循环中不能无界 `save()` 而不 `restore()`。

## 6. 图像与像素

| 方法 | 作用 |
| --- | --- |
| `drawImage(image, ...args)` | 绘制图片或另一个 Canvas，支持 3、5 或 9 参数形式 |
| `createImageData(width, height)` | 创建空白 ImageData |
| `getImageData(x, y, width, height)` | 读取指定区域 RGBA 像素 |
| `putImageData(data, x, y)` | 把 ImageData 写回画布 |

`ImageData`：

- `width`：图像宽度。
- `height`：图像高度。
- `data`：`Uint8ClampedArray`，按 RGBA 顺序保存像素。

像素读写通常会产生较大的同步复制成本。不要在常驻 HUD 的每一帧调用 `getImageData()` / `putImageData()`；只在调试采样、低频分析或确有必要的局部处理时使用，并限制区域大小。

项目的 Craft 重绘验收会对宿主 Canvas 使用 `getImageData()`，冻结单帧后再分析像素带。它是测试工具行为，不应复制进眼镜端运行代码。

## 7. 渐变和图案

| 方法 | 作用 |
| --- | --- |
| `createLinearGradient(x0, y0, x1, y1)` | 创建线性渐变 |
| `createRadialGradient(x0, y0, r0, x1, y1, r1)` | 创建径向渐变 |
| `createPattern(image, repetition)` | 创建重复图案 |

`CanvasGradient` 使用 `addColorStop(offset, color)` 添加 `0.0` 到 `1.0` 的颜色节点。

```javascript
const gradient = ctx.createLinearGradient(0, 0, 300, 0);
gradient.addColorStop(0, "rgba(64, 255, 94, 0.2)");
gradient.addColorStop(1, "#40ff5e");
ctx.fillStyle = gradient;
ctx.fillRect(0, 0, 300, 40);
```

`CanvasPattern` 表示重复图案，可通过 `setTransform(matrix)` 调整图案变换。图案和复杂渐变会增加绘制成本；RabiLink 的单色 HUD 不使用装饰性渐变或纹理。

## 8. 混合与阴影

- `globalAlpha` 适合统一降低一个绘制阶段的透明度，完成后恢复。
- `globalCompositeOperation` 可实现叠加、复制和混合；非基础模式需在目标 Ink 版本真机验证。
- 阴影模糊通常比普通填充和描边昂贵。穿戴设备常驻画面应避免大半径阴影与多层叠加。
- 单色设备用透明度层级比彩色混合更可预测。

## 9. 推荐重绘模板

```javascript
redrawChart(points) {
  const canvas = this.chartCanvas || this.selectComponent("#chartCanvas");
  if (!canvas) return;
  this.chartCanvas = canvas;
  const ctx = this.chartContext || canvas.getContext("2d");
  this.chartContext = ctx;

  ctx.clearRect(0, 0, 300, 120);
  if (!Array.isArray(points) || points.length < 2) return;

  ctx.save();
  ctx.strokeStyle = "#40ff5e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
}
```

只在数据实际变化时调用重绘；页面隐藏、卸载或 Canvas 尺寸变化后，释放旧引用并重新获取上下文。

## 10. RabiLink 决策

- 当前主 HUD 不使用页面级 Canvas。
- 不用 Canvas 绘制品牌、模式轨、状态文字、时钟、版本或电量。
- 不在没有 PCM/音量 API 的情况下伪造 ASR 波形。
- 未来图表或传感器可视化采用固定独立区域、普通文本数值和低频重绘。
- Canvas 失败时必须保留可读的静态状态，不能让核心交互依赖一块空画布。
