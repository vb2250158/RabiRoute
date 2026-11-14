<!-- docs-language-switch -->
[English](computer-control_en.md) | 简体中文 | [日本語](computer-control_ja.md)
<!-- /docs-language-switch -->

# 电脑控制

打开 **RabiLink → 电脑控制**。本机、已接入的 RabiPC 主机和轻量电脑节点平级显示；展开只读取设置与工作状态。离线和读取失败分别显示，读取失败保留最近信息。

完整功能随 0.13.0 和新版 Windows 执行端提供。旧节点继续使用其声明的能力；在线不代表已经更新。按每台电脑展示的能力判断，不根据名称、IP 或空终端列表推断。

## 选择功能

每台电脑有总开关，以及终端命令、文件操作、窗口与截图、智能体任务、鼠标与键盘、屏幕标注六个开关，缺省开启。关闭某项只作用于它的新工作；原状态和停止入口保留。终端和智能体自身仍可能操作文件或输入，这些开关按入口分工。

设置即时保存到目标电脑原有配置。页面分别显示保存结果与执行端应用结果；“应用待确认”时查询原工作状态，不重复写设置。

## 输入与观察

1. 选择目标电脑，读取窗口列表或获取画面。
2. 点击“开始手动控制”，或让 Agent 调用 `control.begin`。
3. 提交移动、点击、滚动、拖拽、Unicode 文字或快捷键的有序批次。画面坐标保留来源帧、目标实例、窗口及像素范围；布局变化需要重新观察。
4. 使用“退出控制”或目标电脑上的退出快捷键。缺省为 **Ctrl+Alt+Esc**；普通 Esc 仍传给应用。默认空闲 120 秒退出，最后 10 秒显示倒计时，可在设置调整。

观察、输入和应用效果分别报告。`captureAfter` 缺省关闭；输入后的截图失败不会把已经注入的输入改写为未执行。取消保留已经执行的前缀，不重放整个批次。关闭预览不等于结束 Agent 的后台工作。

## 屏幕标注

从画面绘制矩形、椭圆、箭头、路径、纯文字或高亮，静态标注默认显示 10 秒，可自定义或保留至清除。标注独立于鼠标键盘控制；清除标注、停止跟踪、退出控制分别执行。

动态标注默认不勾选。启用后显式开始跟踪，使用 CPU KCF 或本地模板匹配；只有这时才加载跟踪库。请求频率与实际频率分别显示，丢失、相似目标、短暂预测和资源降档都有状态，不用预测框冒充识别结果。自动预算先减少预览开销，再调整频率或分析尺寸；受影响工作暂停时保留原因。高级参数从同一设置 schema 提供。

跟踪按明确到期时间、显式停止、已记录的原来源连接断开或设置关闭收尾。普通 HTTP 请求结束不等于业务任务结束；没有持续连接 scope 时使用明确到期或停止。Rabi 计划结束时，只清理由准确任务绑定识别的来源工作；一轮模型回复结束不等于整个任务结束。没有真实任务映射的普通连接不虚构任务身份，可使用明确到期或停止。

## CLI、MCP 与其他 Agent

各入口读取同一运行目录与参数 schema。已有通用 HTTP 工具的宿主可直接使用这些接口，无须安装另一套专用业务工具。

```sh
node apps/rabi-agent/rabi-cli.mjs search "电脑列表" --category devices
node apps/rabi-agent/rabi-cli.mjs describe manager.lan-agent.computers.list --view input
node apps/rabi-agent/rabi-cli.mjs call manager.lan-agent.computers.list --input-json '{}'
node apps/rabi-agent/rabi-cli.mjs describe manager.lan-agent.computer.execute --view input
```

标准 MCP 对应 `rabi_search`、`rabi_describe`、`rabi_call`。先从业务目录取得真实 `instanceId` 和所属主机，再按合同调用；接口搜索结果数量不是电脑数量。

完整远端主机的条目带 `ownerDeviceId`。读取它自己的合同，并使用已有 `manager.rabilink.peer.http.get/post/patch`，把 `deviceId` 设为该 owner、`service` 设为 `manager`、`path` 设为原接口路径；正文和目标参数保持原样。不要把远端 `instanceId` 当成本机目标。界面通过同一原 Peer 入口处理。

控制、输入和标注沿现有 `POST /api/lan-agent/instances/:instanceId/computer` 的 `body.action` 执行。`control.status` 等动作不是另外的 operation ID；原请求编号用于查询已提交的结果，不自动重放输入。设置通过同目标 `GET/PATCH .../computer-settings` 与原 ETag 保存。

[统一接口](../unified-agent-api.md) · [实现设计](../computer-control-design.md)

动态标注的默认内存预算为 512 MiB，覆盖 KCF 组件加载后的正常运行开销；预算统计整个标注执行进程。已保存的自定义预算保持原值，动态跟踪仍默认关闭。
