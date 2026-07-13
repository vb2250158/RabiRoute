# RabiLink AIUI 安装、使用与排障

最后核对：2026-07-13

本文记录 RabiLink AIUI 从本地源码到 Rokid 眼镜的完整链路，以及已经在 Craft、Rokid AI App、ADB、Ink 运行时和 RabiLink Relay 中复现过的问题。下次遇到安装或运行问题，先按“阶段判定”找到最后一个完成阶段，再看对应症状。

## 1. 先分清五个阶段

```text
本地 AIX 已生成
  -> Craft 已上传到账号云端工程
  -> 云端工程已绑定灵珠 RabiLink 并提交审核
  -> 手机智能体商店已添加 RabiLink
  -> 已同步到眼镜并产生真实运行证据
```

这五个阶段互不等价：

- `dist/rabilink-aiui.aix` 存在，只说明本地包已经生成。
- Craft 显示“上传成功”，只说明云端工程已经收到新版本。
- Craft “提审”完成并审核通过后，手机商店才可能搜索到版本。
- 手机智能体管理出现 RabiLink，才说明手机已经添加。
- 眼镜真实显示 HUD、访问 Relay 并留下 app 行为事件，才说明真机运行完成。

## 2. 正式安装与发布流程

### 2.1 本地生成和验收

在 `examples/rabilink-aiui` 运行：

```powershell
npm run check
npm run delivery:verify
npm run acceptance:local
npm run goal:evidence
```

本地交付包是：

```text
dist/rabilink-aiui.aix
```

上传前必须确认：

- AIX 审计通过。
- `delivery:verify` 直接读取最终 AIX 并与源码构建逐文件比对。
- 包内没有真实 `rabilinkToken`、Craft token、Cookie、日志、截图或私有配置。
- 上传权限只保留麦克风、语音识别和网络；当前界面不需要相机权限。

### 2.2 上传到 Craft

1. 打开 [Craft](https://js.rokid.com/craft?region=cn&lang=zh-CN)。
2. 从导入菜单选择“本地 .aix”。
3. 选择 `dist/rabilink-aiui.aix`。
4. 运行预览，确认 448 x 150 卡片和进入后的 480 x 352 HUD 都能打开。
5. 点击打包，选择目标灵珠智能体 `RabiLink`。
6. 核对版本和权限后上传。

#### Craft 浏览器调试的两个入口

Craft 顶部的“运行智能体”和聊天框里的 `/debug 模拟眼镜设备运行当前页面` 不是同一条链路：

- 顶部“运行智能体”直接初始化当前本地 AIX。只验证页面包能否创建 448 x 150 卡片、进入 480 x 352 InkView、切换模式和接收模拟 ASR。
- `/debug` 先请求 Rokid 的智能体调试服务，再由服务调起当前页面。若日志显示 `agent-q.glasses-prod` DNS/fetch 失败，属于官方上游服务不可达，不能据此判定 AIX 初始化失败。
- 上游调试服务异常时，仍可用顶部“运行智能体”完成页面级回归；但这不能代替真实眼镜验收。

Craft 浏览器不会读取电脑麦克风。正确的 ASR 模拟步骤是：

1. 点击顶部“运行智能体”。
2. 在 448 x 150 卡片点击宿主“进入”。
3. 在 Interactive InkView 中触发 Craft 麦克风/唤醒控件。
4. 在 Craft 调试输入框输入识别文本并回车。
5. 确认页面把注入的 `speech.result` 显示到 HUD。

真实眼镜宿主能提供设备序列号，页面才自动启动 AIUI 原生 `SpeechRecognition`；无设备身份的 Craft 浏览器必须等待交互唤醒。

当前本地待发布版本是 `1.0.5`；云端仍是此前验证发布链路的 `1.0.4`。Craft 成功上传时会明确显示：

云端名称与版本记录在 `craft-release.json`，不要用 `package.json` 的本地开发包版本替代 Craft 发布版本。

```text
上传完成
100%
上传成功！
智能体已上传。
```

注意：这个提示不是“审核通过”，也不是“已经安装到眼镜”。

### 2.3 从本地工程切到云端工程

上传后，Craft 可能仍停留在本地工程：

```text
本地项目 > rabilink-aiui.aix
```

此时顶部“提审”会禁用，并提示：

```text
请先绑定灵珠智能体
```

正确处理：

1. 点击左上角当前项目名。
2. 在工程菜单找到“云端项目”。
3. 选择 `RabiLink <版本>`；1.0.5 上传后应选择 `RabiLink 1.0.5`，当前云端历史版本仍为 1.0.4。
4. 确认顶部项目名变为 `RabiLink`。
5. 确认“提审”按钮变为可用。

这是本次排障中确认的关键区别：本地 AIX 内容可以和云端版本完全相同，但本地工程不携带灵珠智能体绑定；只有云端工程能提审。

### 2.4 提交审核

Craft 提审分两步：

1. 确认绑定智能体、版本和 ID。
2. 选择是否需要用户协议，填写可选版本说明，然后点击“提交提审”。

“提交提审”会修改灵珠后台状态，属于外部发布动作，自动化执行前必须得到账号所有者明确授权。

审核通过前，Rokid AI App 的智能体商店按完整名称搜索 `RabiLink` 仍可能显示：

```text
没有找到匹配的智能体
```

这是发布阶段未完成，不是手机蓝牙或 ADB 故障。

### 2.5 手机添加和同步眼镜

审核通过后，在 Rokid AI App 中走公开 UI：

```text
主页
  -> 智能体商店
  -> 搜索 RabiLink
  -> 点击加号添加
  -> 右上角智能体管理
  -> 确认列表出现 RabiLink
```

随后保持手机与眼镜蓝牙连接，执行 App 提供的同步/运行路径，再从眼镜原生助手打开 RabiLink。

不要把下面两种操作当成安装：

- 把 `.aix` 推到手机 `/sdcard/Download`。
- 用 `adb install` 安装 `.aix`。

`.aix` 不是 Android APK。当前 Rokid AI App 没有公开 `.aix` 文件打开处理器；Download 中的文件只适合交付和哈希核对。

## 3. 眼镜上的使用方式

### 连接对话

- 默认模式名：`连接对话`。
- 页面前台使用 AIUI 原生 `SpeechRecognition` 单轮识别，并在 `onend` 后自动续轮。
- 最终文本按会话、序号和时间戳排队，通过 `/rokid/rabilink/input` 作为输入事件同步到 PC；页面不保存 `taskId`。
- 页面始终按 cursor 等待持续下行流。Codex/其他 Agent 的普通回复和定时器、规划器产生的主动消息都会显示并用眼镜原生 TTS 顺序播报。
- TTS 开始前页面释放 ASR，播报结束后才恢复下一轮，避免声音回流。

### 配置助手

- 在连接对话中向后滑动，或让原生 Agent 以 `mode=configuration` 调起。
- 同一个 InkView 直接切换滑轨和 HUD，不退出、不重新点击进入。
- 页面停止连接对话 ASR。配置需求由眼镜原生 Agent 理解，并以明确的 `intent` 调用页面；页面本身不会再创建一轮 ASR。
- 明确指令直接调用 Relay / PC WebGUI 配置接口并播报结果，不提交任务、不轮询 Agent 回复。
- 向前滑动，或让原生 Agent 发送“切到连接对话”，同页恢复连接对话 ASR。

### 主动投递

主动生产者复用 RabiRoute 的输出安全门：

```http
POST /api/agent/replies
Content-Type: application/json

{
  "routeProfileId": "RabiLink",
  "targetType": "rabilink",
  "proactive": true,
  "source": "scheduler",
  "text": "该休息一下了。"
}
```

消息通过策略检查后直接写入眼镜持续队列。它不要求用户刚刚说过话，也不会创建一个供眼镜查询的任务。

### 状态角标

- 左下角：时钟图标和 `HH:mm`。
- 右下角：电池图标、百分比；充电时显示充电标记。
- 所有真实电量来源都不可用，或 Relay 状态超过 3 分钟时显示 `--`。

## 4. 已复现问题与确定处理

| 症状 | 已确认原因 | 正确处理 |
| --- | --- | --- |
| 提审按钮灰色，提示“请先绑定灵珠智能体” | 当前打开的是本地 AIX 工程 | 工程菜单切换到“云端项目 > RabiLink <版本>” |
| Craft 上传成功，手机商店仍搜不到 | 上传不等于提审/审核通过 | 在云端工程提交提审并等待审核通过 |
| 上传接口 HTTP 200，但流内提示“缺少 tools 定义” | `/upload-agent` 使用 SSE；HTTP 成功不等于业务完成，且 metadata 缺少页面函数声明 | 使用当前上传器自动从 AIX 的 `pages/home/index.json` 生成 tools；验收必须看到 `done` 且没有 `error` |
| `goal:evidence` 或 readiness 在中文报告上报 `ConvertFrom-Json` 失败 | Windows PowerShell 5.1 按系统 ANSI 读取无 BOM 的 UTF-8 JSON，中文被错误解码后破坏字符串边界 | 所有本地 JSON 读取显式使用 `Get-Content -Encoding UTF8`；不要依赖 PowerShell 默认编码 |
| 手机 Download 中有 AIX，但无法打开 | App 没有公开 `.aix` 文件处理器 | 走 Craft -> 提审 -> 商店添加 -> 眼镜同步 |
| ADB 显式启动 AgentManageActivity 报 Permission Denial | 管理 Activity 未导出 | 从 Rokid AI App 主页进入智能体商店，再点右上管理入口 |
| `ecology://agent/manage` 从外部 intent 无法解析 | 深链不对普通外部调用开放 | 只使用 App 内部导航 |
| Chrome 选择本地文件报 `Not allowed` | ChatGPT Chrome Extension 没有文件 URL 权限 | 在扩展详情开启“Allow access to file URLs”，或使用内嵌 AIX 上传助手 |
| Craft 卡片阶段不开 ASR | 卡片不是 Interactive InkView；模拟器不读取真实电脑麦克风 | 点击宿主“进入”，再用 Craft 文字输入框模拟识别结果 |
| `/debug` 无法运行当前页面，但顶部“运行智能体”正常 | `/debug` 依赖的 Rokid 智能体调试上游 DNS/fetch 失败 | 用顶部入口继续页面级测试；把上游错误单独记录，不归因到 AIX |
| 初始化或进入沉浸界面卡死 | 旧页面在 resize 路径包含复杂 `scroll-view`、大型条件树、同步启动工作或并发 ASR | 保持单页、零 `scroll-view`、稳定节点树；网络和 ASR 延后到首帧后 |
| 滑动一次跳过或切换无效 | 事件源/方向映射不一致 | 统一兼容 ArrowUp/ArrowDown、ArrowLeft/ArrowRight、Backspace 和 Android DPAD；按当前模式幂等处理重复事件 |
| 浏览器没有真实 ASR | Craft 使用文字注入调试模拟器 | 真正的麦克风和自动启动只在眼镜宿主验证 |
| 模式切换或 ASR 回写后只显示半截文字 | Craft 当前 Ink 会在连续 `setData` 后只重画最后变化的局部节点 | 使用单一稳定 HUD；每次提交先遮罩并触发 1px 有界重排，解除遮罩时重放全部 HUD 可见字段；3 秒像素回归必须为零局部帧 |
| 会话时长显示旧值，例如 `585:00` | Craft 复用了上一次页面状态 | `onLoad`、恢复连接对话和切回连接对话时都把本次时长重置为 `00:00` |
| Playwright 截图偶尔只剩半截，但 `getImageData` 为完整帧 | Craft 持续渲染 Canvas 时，元素截图或直接 `toDataURL` 可能与 GPU 写入竞争 | 用一次 `getImageData` 冻结像素，再复制到离屏 Canvas 编码；像素分类和图片必须来自同一个缓冲区 |
| 电量显示 `--` | 没有 Web/wx 电量 API，或手机状态过期，或生产 Relay 缺少 device-status 路由 | 启动手机 CXR 状态服务，更新 Relay，再运行 `npm run device-status:e2e` |
| 生产 device-status 请求返回 404 | 生产 Relay 仍是旧版本 | 部署包含 `/api/rabilink/mobile/device-status` 的新服务；未授权探测应返回 401，而不是 404 |
| 页面静默一段时间后停止转写 | AIUI 只承诺前台页面续轮，不是后台常驻服务 | 保持页面前台；需要锁屏/后台常驻时使用 FenneNote 或 Android 前台服务方案 |

## 5. 卡死回归测试

历史卡死与以下模式相关：

- 448 x 150 卡片复用同一个 InkView 并 resize 到 480 x 352。
- 复杂 `scroll-view`。
- 大量顶层 `ink:if` 抑制节点。
- `onLoad` 中同步做存储、网络和 ASR。
- 快速失败后立即重建识别器，形成事件循环压力。

当前实现的约束：

- `pages/home/index.ink` 是唯一维护真源。
- 非沉浸式只有一张共享卡片，沉浸式只有一个共享 HUD；模式切换只更新同一棵节点树。
- 页面没有 `scroll-view`。
- 所有 `setData` 都经过 HUD 重绘保护：先遮罩当前帧并触发 1px 有界重排，解除遮罩时重放全部 HUD 可见字段，避免连续 ASR 状态更新留下半截界面。
- 首帧后再分阶段恢复本地状态、连接 Relay 和启动真机 ASR。
- ASR 快速空结束使用指数退避；连续失败 5 次后暂停。

回归命令：

```powershell
npm run startup:safety
npm run startup:soak
npm run interactive:resize
npm run interactive:resize:daily
npm run craft:headless
npm run check
npm run acceptance:local
npm run delivery:verify
```

任何一个命令失败，或日志出现 `apply_ops is still spinning` / `child_sync_parents`，都不能进入真机发布。

Craft 在线重绘验收记录在 `dist/craft-render-acceptance.json`。模式切换和模拟 ASR 回写都连续采样 3 秒，每 10ms 分类一次：完整 HUD 记为 `full`，重绘遮罩期记为 `black`，缺标题、越出 12px 安全区或发光像素不足记为 `partial`。接受条件是 `partial_frames = 0`。该报告只证明 Craft 浏览器 Interactive InkView，不证明真实眼镜已经运行。

## 6. 电量与充电链路

页面按以下优先级获取真实状态：

```text
Web Battery API
  -> wx.getBatteryInfo / wx.getSystemInfo
  -> 手机 Rokid CXR GlassInfo
  -> RabiLink Relay mobile device-status
  -> --
```

手机状态服务只读取 `GlassInfo.batteryLevel / ischarging`，不创建 CXR display session，也不打开 Custom View。验证命令：

```powershell
npm run device-status:e2e
```

报告只保存电量、充电布尔值、来源和时间，不保存 token。

当前已完成的真实链路证据包括手机 CXR 回调和编译 AIUI 读取 Relay 状态。生产公网 Relay 的 device-status 路由仍需部署到最新版本；在此之前，最终眼镜页面可能只能依赖宿主直接提供的 Web/wx 电量 API。

## 7. 最终验收清单

发布与安装：

- [ ] Craft 云端项目顶部显示 `RabiLink`。
- [ ] 提审目标版本正确。
- [ ] 后台审核通过。
- [ ] 手机智能体管理出现 RabiLink。
- [ ] 手机主页显示目标眼镜蓝牙已连接。

眼镜 UI：

- [ ] 默认选中 `连接对话`。
- [ ] 滑轨清楚显示 `连接对话 / 配置助手`。
- [ ] 向后滑动切到配置助手，不退出页面。
- [ ] 向前滑动切回连接对话，不重新进入。
- [ ] 原生 Agent 能以明确 `intent` 调起并执行配置助手。
- [ ] 左下时间正确。
- [ ] 右下电量正确，充电标记与手机眼镜状态一致。
- [ ] HUD 位于视野下沿，中央视野没有被遮挡。

业务链路：

- [ ] 连续 ASR 能跨多轮工作。
- [ ] 断网队列能恢复上传。
- [ ] 普通 Agent 回复能进入持续下行队列并由原生 TTS 播报。
- [ ] 没有前置语音时，`proactive=true` 消息也能唤醒队列并播报。
- [ ] TTS 期间 ASR 已释放，TTS 结束后 ASR 自动恢复。
- [ ] 配置助手能直接执行原生 Agent 传入的明确配置指令。
- [ ] 高风险写入仍需要确认。
- [ ] `npm run runtime:proof` 生成 `proved=true`。
- [ ] `npm run goal:evidence` 显示 complete。

## 8. 当前现场状态

完整的原始需求验收矩阵、自动化证据和设备回来后的最终步骤见 [acceptance-report.md](acceptance-report.md)。

截至 2026-07-13：

- 本地 1.0.5 的连接对话、持续下行流、主动投递、原生 Agent 配置助手、滑轨、时钟、电量/充电、ASR/TTS 交接、Ink 0.13/0.14 resize 和 AIX 独立运行测试已通过。
- `npm run check`、`npm run acceptance:local` 的 18 项矩阵和 `npm run delivery:verify` 已通过；视觉回归会检查模式标题完整度和左右安全区像素。
- Craft 顶部“运行智能体”已成功初始化最终 AIX；`dist/craft-render-acceptance.json` 中模式切换和模拟 ASR 回写的 3 秒采样均为 `partial_frames = 0`。`/debug` 曾因 Rokid 上游 `agent-q.glasses-prod` DNS/fetch 失败而不可用，两者已分开记录。
- 本地 1.0.5 最终 AIX SHA256 为 `fa596e2920c46bfb804a96916f4d716cff6bf9071427163286045cafcaadfd3c`；最终包已直接完成 AIX 审计和 Ink 运行。
- 此前 1.0.4 已完成 `sts -> upload -> save -> done`，但该云端证据不代表本次 1.0.5 已上传。
- 命令行、普通浏览器和内嵌浏览器三个上传入口已统一补齐 `RECORD_AUDIO`、自动/受审计的 `index` tool，并拒绝“HTTP 200 但没有 done”或流内 `error`；Windows PowerShell 5.1 的 JSON 数组序列化也已实际 dry-run 验证。
- 已确认必须从本地工程切到云端 RabiLink，提审才会启用。
- Craft 当前绑定的云端历史版本是 `RabiLink 1.0.4`；1.0.5 尚未上传或提审，等待设备与账号发布授权。
- 手机端智能体管理当前为空，商店搜索 RabiLink 无结果，与尚未审核通过相符。
- 生产 Relay 的 device-status 路由返回 404，说明公网仍是旧版本；需要有效部署凭据更新后再做最终电量真机验收。
- 手机和眼镜在 2026-07-13 已物理断开；最终手机添加、眼镜运行、真实 ASR 和真实电量/充电证据尚未完成，因此不能把当前状态写成全部验收通过。

## 9. 相关资料

- [RabiLink AIUI 项目 README](../README.md)
- [AIUI 快速开始](https://js.rokid.com/AIUI/guide/quickstart?lang=zh-CN)
- [第一个沉浸式 AIUI](https://js.rokid.com/AIUI/guide/quickstart-first-immersive?lang=zh-CN)
- [AIUI ASR 指南](https://js.rokid.com/AIUI/guide/basic-ai-asr?lang=zh-CN)
- [AIUI SpeechRecognition API](https://js.rokid.com/AIUI/api/ai-speech-recognition?lang=zh-CN)
