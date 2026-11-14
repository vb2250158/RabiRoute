<!-- docs-language-switch -->
<div align="center"><a href="./computer-control-visual-workflow_en.md">English</a> | 简体中文</div>
<!-- /docs-language-switch -->

# 电脑视觉操作

通过同一电脑操作合同完成观察、定位、整批输入和结果核对。CLI、MCP 与 Agent 插件共用参数、目标身份和原请求回执。

Host 0.15.0 与 Core 0.1.8 配套提供注册图像响应。Agent SDK／CLI 0.4.4 与 MCP 0.2.4 提供对应的媒体投影及原生批次协议。实际采用版本从运行中的插件、客户端和桌面执行器读取。

## 观察目标

1. 从当前接口目录找到电脑操作，查询已接入电脑并选择目标实例。
2. 使用 `displays.list` 获取该电脑的显示器 ID、物理区域、工作区、缩放和布局版本。
3. 使用 `screen.capture` 观察所需显示器、区域或窗口。
4. 根据模型实际收到的图像定位，保留结果中的完整 `source`。

| 截图范围 | 参数 |
| --- | --- |
| 虚拟桌面概览 | `scope: "virtual"` |
| 单显示器 | `scope: "display"` 和原 `displayId` |
| 显示器内区域 | `scope: "region"`、原 `displayId` 和 `region: {x, y, width, height}` |
| 窗口 | `scope: "window"`、原 `windowId` 和 `pid` |

区域坐标相对所选显示器，采用物理像素。显式显示器／区域截图默认保留原始像素，可以通过 `maxWidth` 指定输出宽度。原有概览请求保持原默认宽度。选择字段可以放在顶层、`source` 或 `captureSpec` 中，同一字段应保持相同值。`layoutRevision` 可用于核对原显示器布局。

## 图像与坐标

MCP 将有效图像作为图像内容返回，文本回执保存请求身份、来源与结果。DSH 适配器将图像交给官方附件服务，并沿当前模型的图像预览接口处理尺寸。

`source.width`、`source.height`、`frameId` 和 `imageItemId` 对应原缓存图像。宿主缩放预览后，`source.imageView.width` 与 `height` 记录模型实际看到的完整图像尺寸。输入、标注和跟踪会自动将这个图像坐标映射回原缓存和桌面。调用方复用完整来源及图上坐标即可。

媒体转换出错时，回执保留原业务结果与对应的媒体错误。查询原请求可取得已执行的真实状态。

## 一次完整输入

先调用 `control.begin` 取得 `controlSessionId`。随后将一次逻辑操作放入同一 `input.execute.actions` 数组，例如点击输入框、输入文字、提交快捷键。使用原 `requestId` 查询或核对该次结果。

原生执行器在批次首次输入前保存用户光标和前台，按顺序执行动作，在批次结束时释放自身按键／按钮并归还光标与前台。`captureAfter: true` 可返回操作后的图像。普通控制操作的附图也保留显示器、区域、窗口、布局版本与 `maxWidth` 参数。

结果中的 `completedActions`、`results`、`releaseState` 和 `returnState` 分别描述已执行前缀、各动作结果、资源释放及归还事实。`returnState.keys`、`cursor`、`foreground` 独立报告。取消、失败、超时和用户接管沿原输入 owner 收尾。

| 设置 | 行为 |
| --- | --- |
| `control.returnCursor` | 控制批次后的光标归还，默认开启 |
| `control.returnForeground` | 控制批次后的前台归还，默认开启 |
| `control.returnForegroundTimeoutMs` | 前台请求后的原生确认预算，默认 120ms，0 表示立即确认 |

用户实际移动鼠标后，执行器保留用户的新位置。用户接管造成的取消与尚未完成的归还分别反映在回执中。

## 操作提示

桌面提示条按当前观察屏幕定位。`presentation.barPlacement` 选择顶部或底部居中，文字大小和动效沿当前配置与主题。提示条展示当前区域、观察／操作／归还阶段和停止入口，WebGUI 同步显示活动状态并可展开图像。

桌面提示采用圆角胶囊和透明窗角。标准文字下宽度为 280–360、高度为 46 个逻辑像素。大字模式高度为 58。超长文字在固定宽度内省略，停止按钮的说明提供完整状态、来源和退出快捷键。提示正文和圆角区域允许点击穿透，右侧停止按钮保持可操作。

原生端已进入控制后，Qt 确认失败会在 `presentation.presentationWarning` 中说明，原生受理状态仍可查询。此时没有已确认的可见性结论。已退出的控制不会被迟到的显示确认重新激活。

## 更新与局部失败

原生执行器通过已有能力握手声明显示器／区域截图、整批输入和 `imageView` 支持。原有概览与窗口截图继续沿旧协议。新能力缺失时，对应请求返回具体能力与桌面资源更新提示。

缩放后的定位操作使用接收端实际声明的 `imageView-v1` 格式能力。旧端缺少该格式时，仅该次定位请求返回格式提示，文字、状态查询、取消和清理继续使用。该次未发出不代表原请求从未执行，沿原 `requestId` 查询 `input.status` 核对已有回执。远端 PC 使用目标 PC 自身的操作合同。

旧客户端的逐动作协议继续保持动作之间的焦点，释放其自身按键与按钮。完整批次协议在整个批次结束后执行自动归还。

本版本的 Core 图像声明与 Host 通用响应支持配套采用。独立插件安装按目标 Host 的实际兼容验证决定。插件、媒体或单次输入的局部错误由对应 owner 报告，其他无依赖操作继续使用。

相关入口见[电脑控制设计](computer-control-design.md)、[插件更新](plugin-source-layout.md)和[Agent 接口](rabi-agent-interfaces.md)。
