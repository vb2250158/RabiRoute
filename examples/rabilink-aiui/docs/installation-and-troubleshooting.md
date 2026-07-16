# RabiLink AIUI 安装、使用与排障

最后核对：2026-07-14

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

### 2.2 配置 PC RabiLink 主动智能 Route

PC 全局“连接服务器”只负责登记电脑和代理远程 WebGUI。要让 AIUI observation 进入统一账本，并让 Codex 在没有前置任务时主动下行，还必须存在一条已启用的 RabiLink Route：

1. 新工作区会看到默认禁用的 `RabiLink` 模板。已有 data 的升级环境如果没有它，把 `examples/data/route/RabiLink` 和 `examples/data/roles/RabiActive` 复制到对应运行目录。
2. 在路由配置中确认消息端包含 `rabilink`，且输入、输出和 `text` 能力都开启。
3. Agent 选择 `codex`，人格选择 `RabiActive`，填写明确的固定线程名和 Agent 工作目录。
4. 检查本地端口无冲突后启用并保存 Route。
5. 在全局“Rabi 实例”中配置 Relay 地址、应用 token 和 PC 标识并打开“连接服务器”，再到 Relay `/manage` 为应用选择这台通讯 PC。

Relay 地址和 token 只属于本机全局配置及智能体变量 `rabilinkToken`，不要写入 Route 模板。Route 运行中只是输入可落账的必要条件；主动下行还会经过 `/api/agent/replies` 的 Rabi 输出策略和 Action Gate。

### 2.3 上传到 Craft

1. 打开 [Craft](https://js.rokid.com/craft?region=cn&lang=zh-CN)。
2. 从导入菜单选择“本地 .aix”。
3. 选择 `dist/rabilink-aiui.aix`。
4. 运行预览，确认 448 x 150 卡片和进入后的 480 x 352 HUD 都能打开。
5. 点击打包，选择目标灵珠智能体 `RabiLink`。
6. 核对版本和权限后上传。

没有本机设备凭证时页面仍必须完成第 4 步。真机会先进入独立的 `RabiLink Setup` 首次设置页，不显示模式滑轨、ASR 或 Agent 会话内容，只显示完整眼镜 SN、Relay `/manage` 地址和绑定状态。外层智能体即使仍传入旧应用 token，真机也会忽略它。用户登录服务器后台，在目标应用卡片的“眼镜 SN”输入框填写该 SN，点击“绑定 / 重置”。眼镜每 5 秒尝试首次领取设备凭证，成功后写入当前 Agent 隔离的 `localStorage`，并自动切换到正常 RabiLink HUD，不需要再次点击进入，也不需要配置灵珠记忆变量。页面工具的 `token` 参数只用于无设备 SN 的 Craft 调试兼容。

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

当前本地待发布版本是 `1.0.18`。沉浸式 HUD 和 448 x 150 卡片都会在电量左侧显示 `v1.0.18`，可用它确认眼镜实际运行的包；云端实际版本应在 Craft 项目列表中复核。Craft 成功上传时会明确显示：

云端名称与版本记录在 `craft-release.json`，不要用 `package.json` 的本地开发包版本替代 Craft 发布版本。

```text
上传完成
100%
上传成功！
智能体已上传。
```

注意：这个提示不是“审核通过”，也不是“已经安装到眼镜”。

### 2.4 从本地工程切到云端工程

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
3. 选择 `RabiLink <版本>`；本次上传后应选择 `RabiLink 1.0.18`。
4. 确认顶部项目名变为 `RabiLink`。
5. 确认“提审”按钮变为可用。

这是本次排障中确认的关键区别：本地 AIX 内容可以和云端版本完全相同，但本地工程不携带灵珠智能体绑定；只有云端工程能提审。

### 2.5 提交审核

Craft 提审分两步：

1. 确认绑定智能体、版本和 ID。
2. 选择是否需要用户协议，填写可选版本说明，然后点击“提交提审”。

“提交提审”会修改灵珠后台状态，属于外部发布动作，自动化执行前必须得到账号所有者明确授权。

审核通过前，Rokid AI App 的智能体商店按完整名称搜索 `RabiLink` 仍可能显示：

```text
没有找到匹配的智能体
```

这是发布阶段未完成，不是手机蓝牙或 ADB 故障。

### 2.6 手机添加和同步眼镜

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

这里手机不只是安装入口。按 Rokid 官方 AIUI 机制，眼镜页面发出的网络包会经蓝牙透明代理到手机 App，再访问 Relay；页面代码仍使用普通 `fetch`。这会减少眼镜独立联网负担，但不能据此宣称 QuickJS、Canvas、页面状态或全部 ASR/TTS 计算已经迁移到手机。PC RabiRoute 仍拥有 Agent、统一账本、配置真源和动作安全门。

RabiLink 手机伴侣还可以用同一应用 token 上报 CXR 电量，并通过设备无关 API 接入手机、手表等便携端。当前 AIUI 仍采用“眼镜页面直接消费、手机透明代理网络”的模式；不要再让手机以同一个眼镜身份并行代收，否则可能重复显示或 TTS。完整架构见 `../../../docs/rabilink-phone-edge-hub.md`。

不要把下面两种操作当成安装：

- 把 `.aix` 推到手机 `/sdcard/Download`。
- 用 `adb install` 安装 `.aix`。

`.aix` 不是 Android APK。当前 Rokid AI App 没有公开 `.aix` 文件打开处理器；Download 中的文件只适合交付和哈希核对。

## 3. 眼镜上的使用方式

### 连接对话

- 默认模式名：`连接对话`。
- 页面前台使用 AIUI 原生 `SpeechRecognition` 单轮识别，并在 `onend` 后自动续轮。
- 这只能逼近“页面保持打开时的持续转录”，不能把 AIUI 页面宣称为系统级 24 小时后台录音服务；页面隐藏、退出或被系统回收后会停止采集，真正锁屏/后台常驻仍需 FenneNote 或 Android 前台服务。
- 最终文本按会话、序号和时间戳排队，通过 `/rokid/rabilink/input` 作为 `rabilink.observation` 同步到 PC；PC 只把它写入统一会话账本并释放上行项，不逐句投递 Codex，也不创建页面需要保存的 `taskId`。
- 页面断网队列保留最近 2000 段、最长 48 小时。最终文本会压缩空白、丢弃纯标点、过滤 2.5 秒内完全相同的重复，并在原生 TTS 结束后短时过滤高度相似的回声。
- 单击一次触摸板表示“现在审阅最近记录”：Codex 空闲时新开一轮，正在执行时 steer 当前轮次；该操作不暂停 ASR。向后滑动才切到配置助手，两者不是同一级动作。
- 没有手动单击时，PC 端也会在固定 Codex 线程空闲且最后一段转写稳定后主动审阅；Agent 必须读取 JSONL 判断直接对话、环境谈话、媒体声音和噪声，没必要回应时保持安静。
- 即使没有新转写，PC 端默认每 30 分钟在线程空闲时做一次连续反思，检查用户当前目标、障碍、未完成承诺、计划、时间变化和本地 Agent 结果。它可以只静默准备，不等于每 30 分钟播报；Route 变量 `rabilinkContinuousReflection` 和 `rabilinkReflectionIntervalMinutes` 可关闭或调整。
- 页面始终按 cursor 等待持续下行流。Codex/其他 Agent 的普通回复和定时器、规划器产生的主动消息都会显示并用眼镜原生 TTS 顺序播报。
- Relay 下行 outbox 与十分钟任务清理分离，默认保留 48 小时。首次连接读取仍在保留期内的 backlog，不跳到当前队尾；因此 Codex 可以在眼镜页面尚未打开时先投递。
- AIUI 收到一批消息时，先按 token 把最多 2000 条、48 小时的待播报项写入本地存储，再保存 `nextCursor`。页面隐藏、切到配置助手或播报中断不会删除未完成项；回到连接对话后按原 cursor 顺序继续，成功 TTS 后才移除。
- TTS 开始前页面释放 ASR，TTS 状态机收尾后才恢复下一轮，避免声音回流。当前官方 `speechSynthesis` API 只公开 `speak(utterance, mode?)`，没有承诺完整 utterance 生命周期事件或 `cancel()`；页面使用 `enqueue` 模式，并在宿主不回调 `onend/onerror` 时按文本长度启用 1.8 到 90 秒的保守 watchdog，防止 `speechActive` 永久卡住。这个估算只能保证状态机继续推进，实际播报结束时刻仍必须在真眼镜验收。
- 单条 TTS 连续失败 3 次后仍保留在持久队列，但会让出队首，使后续普通/主动消息继续播报；HUD 显示 `TTS 失败，单击重试`，连接对话中单击触摸板会重置失败项并重试。

PC 端统一会话数据：

- 当前会话：`rabilink-conversation.jsonl`。
- 用户观察：`direction=user_to_agent`；成功排队的 Agent 下行：`direction=agent_to_user`；触摸板请求：`direction=control`。
- 跨本地日期，或空档达到默认 6 小时后，旧文件移动到 `rabilink-conversations/YYYY-MM-DD[-NN].jsonl`，`index.json` 只记录文件、起止时间和条数。
- 分卷和索引写入受跨进程锁保护，索引采用临时文件替换；即使进程恰好在文件移动后退出，读取时间线时也会发现未登记的日期分卷并恢复，不把未审阅观察藏在损坏索引之后。
- 归档不生成摘要、不改写原文。Agent 需要上下文时先读当前文件，再按索引读取相关日期归档。

### 配置助手

- 在连接对话中向后滑动，或让已绑定灵珠智能体以 `mode=configuration` 调起。
- 同一个 InkView 直接切换滑轨和 HUD，不退出、不重新点击进入。
- 页面先停止连接对话 ASR，模式帧提交后再用同一个受控识别器启动配置 ASR。用户可直接描述需求，完整原话会交给 AIUI 原生 `LanguageModel`。
- 页面内模型只能通过 `execute_configuration_action` 白名单 `toolcall` 选择现有动作；页面外 Agent 也可以用明确 `intent` 调用页面。两条入口都直接调用 Relay / PC WebGUI 配置接口并播报真实结果，不提交任务、不轮询 Agent 回复。
- 执行接口、模型理解或播报 TTS 时会释放配置 ASR；操作和 TTS 状态机收尾后自动开始下一轮。模型不确定时只追问，不会误执行或停在“正在处理”。
- 向前滑动，或直接说“切到连接对话”；配置 ASR 会在调用 `LanguageModel` 前识别这条控制语句，同页立即恢复连接对话 ASR。

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
  "targetDeviceKinds": ["glasses"],
  "presentation": ["text", "tts"],
  "text": "该休息一下了。"
}
```

消息通过策略检查后直接写入持续队列，并以 `agent_to_user` 写回统一会话账本。`targetDeviceKinds` 和 `presentation` 可省略；都省略时是应用内广播，显式写 `glasses` + `tts` 时只让眼镜端按 TTS 方式呈现。它不要求用户刚刚说过话，也不会创建一个供眼镜查询的任务。

上行和下行是两条独立队列：眼镜输入被 PC Rabi 记录后就释放上行项；Codex 在线程空闲审阅记录，或被触摸板引导审阅。定时器、规划器或 Codex 也可以完全没有上行输入，随时主动写入下行。下行写入带稳定 `deliveryId`，网络响应丢失时重试不会造成重复 TTS。`taskId` 只保留旧的直接消息兼容关系，不参与 record-only 上行、主动投递、阻塞或关流。

### 状态角标

- 左下角：时钟图标和 `HH:mm`。
- 右下角：`v<发布版本>`、电池图标、百分比；充电时显示充电标记。
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
| 运行智能体后一直停在“等待智能体渲染” | 旧工具 Schema 把尚未绑定的 token 设为必填，已绑定灵珠智能体没有完成页面工具调用 | 使用当前 AIX；token 未配置时省略参数并先打开页面，配置后再引用 `rabilinkToken` |
| 源码 Ink 测试通过，但 Craft 仍加载旧界面或不渲染 | `dist/rabilink-aiui.aix` 没有从当前源码重建 | 重新运行 `npm run package:aix`，并用 `npm run delivery:verify` 逐文件比对最终 AIX |
| Craft 卡片阶段不开 ASR | 卡片不是 Interactive InkView；模拟器不读取真实电脑麦克风 | 点击宿主“进入”，再用 Craft 文字输入框模拟识别结果 |
| `/debug` 无法运行当前页面，但顶部“运行智能体”正常 | `/debug` 依赖的 Rokid 智能体调试上游 DNS/fetch 失败 | 用顶部入口继续页面级测试；把上游错误单独记录，不归因到 AIX |
| 初始化或进入沉浸界面卡死 | 旧页面在 resize 路径包含复杂 `scroll-view`、大型条件树、同步启动工作或并发 ASR | 保持单页、零 `scroll-view`、稳定节点树；网络和 ASR 延后到首帧后 |
| 滑动一次跳过或切换无效 | 事件源/方向映射不一致 | 统一兼容 ArrowUp/ArrowDown、ArrowLeft/ArrowRight、Backspace 和 Android DPAD；按当前模式幂等处理重复事件 |
| 浏览器没有真实 ASR | Craft 使用文字注入调试模拟器 | 真正的麦克风和自动启动只在眼镜宿主验证 |
| 模式切换或 ASR 回写时画面闪烁 | 旧重绘保护把每次 `setData` 都设为 `opacity: 0`，时钟、ASR 和消息更新都会短暂清空整帧 | 使用 1.0.16；只有模式切换触发 1px 有界重排，普通更新不隐藏 HUD，Ink 烟测在转场 8ms 采样也必须保留亮像素 |
| 打包后左上角多段文字叠在一起，且 Craft 预览不一定复现 | 1.0.15 以前分别挂载 448 x 150 卡片树与 480 x 352 沉浸树；Ink 0.13 复用同一 Canvas 执行 resize 后可能留下不完整的旧树绘制，旧测试只统计总亮点所以误判通过 | 使用 `1.0.16` 或更新版本；两种尺寸只挂载同一棵 87px HUD，并逐行检查品牌、模式轨、状态、消息和底栏像素带；在电量左侧核对 `v<版本>` |
| 配置助手说完一句后停住或一直等待 | 当前官方 AIUI `speechSynthesis` 没有承诺 `utterance.onend/onerror`；旧页面等待 `onend` 才释放 `speechActive` 和恢复 ASR，所以真机不回调时会永久停住 | 更新到 1.0.16；通过 `AiuiTtsOutputAdapter` 使用官方 `enqueue` 模式，并用有界文本时长 watchdog 兜底完成 TTS/ASR 交接。模拟宿主完全不发送生命周期事件的回归已通过，真机仍需核对估算时长 |
| 一条 TTS 失败后，后续主动消息也一直不播 | 旧队列让失败项永久占据队首 | 1.0.16 每项最多自动尝试 3 次；失败项保留但让出队首，后续消息继续。连接对话单击触摸板可重试失败项 |
| 上行显示 pending 很久，或 WebGUI 配置偶发 30 秒超时 | 远端任务虽已领取，但完成确认或本机代理请求可能遇到不确定网络响应；旧实现没有有界重试 | 当前版本对本机代理和 Relay 完成确认设置超时重试；完成接口幂等，重试不会重复记录 observation 或重复下行消息 |
| Codex 在眼镜打开前发了消息，首次连接却收不到 | 旧 AIUI 用 `tail=1` 把首次 cursor 直接放在当前队尾，同时 Relay outbox 跟随十分钟 task TTL 清理 | 使用当前版本并部署当前 Relay；首次连接消费 48 小时保留 backlog，任务清理不再删除待播报消息 |
| TTS 播报中切模式、隐藏页面或重新进入后，后续消息消失 | 旧页面先保存 cursor，再把消息只放进内存 TTS 队列；`onHide` 会清空内存 | 当前版本先持久保存整批消息再推进 cursor；未成功播完的项在恢复后按原顺序继续 |
| 断网转写已保存，但重新打开页面后一直不补传 | 旧首次启动只恢复 ASR 和下行队列，未立即 flush 已持久化的 observation；必须等下一句或再次切换页面才触发 | 当前版本在首次前台激活时立即补传旧队列，并沿用原 `clientMessageId` 供 Relay 幂等去重 |
| 升级后未传 token，页面却沿用旧连接，或换 token 后出现旧消息 | 旧包曾把手工输入 token 写进页面本地设置，cursor/TTS 队列键还含 token 首尾片段，离线 observation 也没有账号隔离 | 当前版本不再读取或持久化 token；首次延迟启动删除旧明文字段，并把旧队列迁移到不含凭证片段的稳定指纹。observation、cursor 和待播 TTS 都按指纹隔离，切换 token 不会串线 |
| Codex 离线期间 JSONL 已分卷，恢复后只审阅新文件 | 旧审阅器只读取当前 `rabilink-conversation.jsonl`，没有把 archive 纳入 pending 游标 | 更新 RabiRoute；审阅范围由归档索引和当前文件组成，分卷前未审阅 observation 仍会进入下一轮 |
| RabiLink 路由日志出现 `thread/list` timeout 后进程退出 | 旧后台审阅用 fire-and-forget Promise 启动 Codex 检查，app-server 超时形成未处理 rejection | 更新并重新构建 RabiRoute；startup、定时检查、触摸唤醒和排队唤醒都捕获失败并记录 deferred，账本和审阅游标不前移，下一轮自动重试 |
| 会话时长显示旧值，例如 `585:00` | Craft 复用了上一次页面状态 | `onLoad`、恢复连接对话和切回连接对话时都把本次时长重置为 `00:00` |
| Playwright 截图偶尔只剩半截，但 `getImageData` 为完整帧 | Craft 持续渲染 Canvas 时，元素截图或直接 `toDataURL` 可能与 GPU 写入竞争 | 用一次 `getImageData` 冻结像素，再复制到离屏 Canvas 编码；像素分类和图片必须来自同一个缓冲区 |
| 电量显示 `--` | 没有 Web/wx 电量 API，或手机状态过期，或生产 Relay 缺少 device-status 路由 | 启动手机 CXR 状态服务，更新 Relay，再运行 `npm run device-status:e2e` |
| 生产 device-status 请求返回 404 | 生产 Relay 仍是旧版本 | 部署包含 `/api/rabilink/mobile/device-status` 的新服务；未授权探测应返回 401，而不是 404 |
| 页面静默一段时间后停止转写 | AIUI 只承诺前台页面续轮，不是后台常驻服务 | 保持页面前台；需要锁屏/后台常驻时使用 FenneNote 或 Android 前台服务方案 |

### 获取眼镜运行日志

`1.0.17` 起，AIUI 会把应用自身的运行状态、ASR/TTS/LanguageModel 错误和安全 console 摘要异步上传到 Relay。登录 Relay 的 `/manage/<账号>`，打开“眼镜云日志”，即可按设备、来源、级别和关键词筛选；每条记录同时显示 AIX 版本、模式和会话。断网日志会在眼镜本地保留最多 500 条、7 天，恢复网络后自动补传。

云日志不会上传 ASR 原文、配置需求原文、Agent 回复、token 或密码。它覆盖的是 RabiLink AIUI 应用层日志，不等于系统全量日志。Android/YodaOS `logcat`、内核和其他应用私有日志仍需要眼镜 ADB 或未来具备系统权限的设备桥：

只有眼镜本身出现在 `adb devices -l` 且已在眼镜端接受 RSA 调试授权时，电脑才能读取实时日志。手机连上 ADB 不等于眼镜已连上。当前配置链会输出不含用户原句的安全标记：`configuration-asr:start/result/end` 和 `configuration-ai:dispatch:<command>`。

```powershell
$adb = Resolve-Path ..\android-rabi-link-probe\out\tools\android-sdk\platform-tools\adb.exe
& $adb devices -l
& $adb logcat -c
& $adb logcat -v threadtime |
  Select-String -Pattern "RabiLink AIUI|SpeechRecognition|QuickJS|InkWebView" |
  Tee-Object .\dist\rabilink-aiui-glasses.log
```

复现一次“滑到配置助手 -> 说话 -> 等待下一轮”，再按 `Ctrl+C` 停止。若设备列表为空，不能把 PC/Relay 日志冒充眼镜日志；此时只能用 Relay 是否收到新输入来缩小范围。

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
- 只有模式切换使用 1px 有界重排并重放 HUD 可见字段；时钟、ASR、模型、消息和电量等普通 `setData` 不隐藏整帧。
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

Craft 在线重绘验收记录在 `dist/craft-render-acceptance.json`。模式切换和模拟 ASR 回写都连续采样 3 秒，每 10ms 分类一次；1.0.16 起不把黑帧当作正常遮罩期，接受条件应同时是 `partial_frames = 0` 和 `black_frames = 0`。当前文件仍是历史 AIX 的报告，包大小、AIX VERSION 和 SHA256 都不等于本页列出的 1.0.18，不能借它宣称当前包已通过 Craft；重新上传后必须生成同包报告。该报告即使更新，也只证明 Craft 浏览器 Interactive InkView，不证明真实眼镜已经运行。

## 6. 电量与充电链路

页面只接受以下可证明来自眼镜的状态链：

```text
手机 Rokid CXR GlassInfo
  -> RabiLink Relay mobile device-status
  -> AIUI 状态角标
```

手机状态服务只读取 `GlassInfo.batteryLevel / ischarging`，不创建 CXR display session，也不打开 Custom View。验证命令：

```powershell
npm run device-status:e2e
```

报告只保存电量、充电布尔值、来源和时间，不保存 token。

当前已完成的链路证据包括手机 CXR 回调、编译 AIUI 读取 Relay 状态，以及生产公网 Relay 已部署 device-status 路由。手机或眼镜离线、状态超过 3 分钟时，页面仍会诚实显示 `--`，不会把浏览器或手机本机电量冒充眼镜电量。

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
- [ ] 已绑定灵珠智能体能以明确 `intent` 调起并执行配置助手。
- [ ] 滑到配置助手后直接说两条受支持命令，两轮都能识别和执行，不停在第一句。
- [ ] 左下时间正确。
- [ ] 右下电量正确，充电标记与手机眼镜状态一致。
- [ ] HUD 位于视野下沿，中央视野没有被遮挡。

业务链路：

- [ ] 连续 ASR 能跨多轮工作。
- [ ] 断网队列能恢复上传。
- [ ] 普通 Agent 回复能进入持续下行队列并由原生 TTS 播报。
- [ ] 没有前置语音时，`proactive=true` 消息也能唤醒队列并播报。
- [ ] TTS 期间 ASR 已释放；即使宿主不触发 utterance 生命周期事件，watchdog 后 ASR 也会自动恢复，且不会截断实际播报。
- [ ] 配置助手能直接执行已绑定灵珠智能体传入的明确配置指令。
- [ ] 配置助手 ASR、原生 `LanguageModel`、白名单工具、配置 TTS 和下一轮 ASR 能顺序交接，期间没有并发识别。
- [ ] 高风险写入仍需要确认。
- [ ] `npm run runtime:proof` 生成 `proved=true`。
- [ ] `npm run goal:evidence` 显示 complete。

## 8. 当前现场状态

完整的原始需求验收矩阵、自动化证据和设备回来后的最终步骤见 [acceptance-report.md](acceptance-report.md)。

截至 2026-07-14：

- 本地 1.0.18 的 record-first 连接对话、重启后 observation 自动补传、持续下行流、48 小时离线 backlog、按 token 指纹隔离的持久 observation/cursor/TTS 队列、无任务主动投递、AIUI 原生 ASR/TTS Adapter、配置助手原生 `LanguageModel`/外层 Agent 双入口、无 TTS 生命周期事件时的 watchdog 恢复、坏消息让出队首/触摸板重试、旧 token 缓存与片段键迁移、眼镜云日志离线补传和双重脱敏、单树滑轨 HUD、时钟、可见版本、真实 CXR 电量、无黑帧转场、125% 字体压力和 Ink 0.13/0.14 resize 测试已通过。
- `npm run check`、`npm run acceptance:local` 的 21 项矩阵和 `npm run delivery:verify` 已通过；其中主动智能核心项会单独验证 record-first 分类、无任务主动下行、统一账本分卷恢复、空闲/周期审阅和触摸板引导，原生语音项会验证 capability、统一 DTO、无 API key 和无隐藏网络 fallback，常驻转写项会验证 FenneNote/命名 Webhook 写入同一账本、带稳定 ID/生产端时间的重试去重且不逐段触发 Agent；视觉回归会检查模式标题完整度和左右安全区像素。
- Craft 顶部“运行智能体”曾成功初始化历史 AIX；现有 `dist/craft-render-acceptance.json` 也只对应历史 AIX，不能作为 1.0.18 证据。当前 1.0.18 等待真机体验；`/debug` 的 Rokid 上游 DNS/fetch 故障与 AIX 初始化已分开记录。
- 本地 1.0.18 最终 AIX 的 VERSION 和 SHA256 以本次重新打包文件为准；主包嵌入已部署 Relay 入口。
- 历史真实公网 Relay + 本机 Rabi + 绑定 `RabiActive` 人格的 Codex record-first 双向队列曾通过：无输入主动投递 184ms，observation 落盘并释放上行 435ms，触摸板审阅后真实 Codex 约 68 秒以无 `taskId` 主动消息独立回复；用户 observation 与 Agent 下行同处一个 JSONL，重复数为 0；远程配置写入、读回与精确回滚通过。当前实现增加常驻 record-first 入口和可直接执行的审阅回复合同后，旧报告已因发布版本、AIX、实现摘要或时效不匹配被 `goal-evidence` 判为 `stale-live-e2e`；重新授权运行前不能把历史报告当作当前证明。
- 历史版本的上传记录不代表本次 1.0.18 已上传；云端版本和审核状态需要在 Craft 中重新读取。
- 命令行、普通浏览器和内嵌浏览器三个上传入口已统一补齐 `RECORD_AUDIO`、自动/受审计的 `index` tool，并拒绝“HTTP 200 但没有 done”或流内 `error`；Windows PowerShell 5.1 的 JSON 数组序列化也已实际 dry-run 验证。
- 已确认必须从本地工程切到云端 RabiLink，提审才会启用。
- Craft 云端版本、提审状态和手机端安装状态当前未重新读取；不能从本地包推断线上状态。
- 生产 Relay 已更新到本轮服务版本；最终电量仍必须等手机与眼镜重新连接后，用未过期 CXR 状态核验。
- 手机和眼镜在 2026-07-13 已物理断开；最终手机添加、眼镜运行、真实 ASR 和真实电量/充电证据尚未完成，因此不能把当前状态写成全部验收通过。
- 可选 FenneNote 常驻转写只提供 PC 麦克风的 record-first 输入，并复用同一 JSONL 与审阅器；它不改变 AIUI 的前台生命周期，也不能替代眼镜麦克风、后台录音或真机运行证据。

## 9. 相关资料

- [RabiLink AIUI 项目 README](../README.md)
- [AIUI 框架与逻辑开发笔记](aiui-framework-and-logic-development.md)
- [AIUI 快速开始](https://js.rokid.com/AIUI/guide/quickstart?lang=zh-CN)
- [第一个沉浸式 AIUI](https://js.rokid.com/AIUI/guide/quickstart-first-immersive?lang=zh-CN)
- [AIUI ASR 指南](https://js.rokid.com/AIUI/guide/basic-ai-asr?lang=zh-CN)
- [AIUI SpeechRecognition API](https://js.rokid.com/AIUI/api/ai-speech-recognition?lang=zh-CN)
