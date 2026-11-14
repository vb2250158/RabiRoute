[English](README_en.md)

# PC 共用语音服务壳

供 DSH 和后续 Rabi 适配器复用的 Windows x64 音频服务。宿主进程持有音频子进程的 Windows Job；GUI、字幕和桌宠仅呈现状态，关闭浏览器不停止已启用的语音。

## 接口

- `./node`：`openDesktopDevice`；枚举输入输出、连续采集、播放 WAV、独立字幕和托盘。
- `./services`：把设备和宿主的 `recognize` / `synthesize` 接到共享 `assistant-runtime`。
- `./providers`：OpenAI 兼容 WAV 识别及播报适配器；可分别提供 ASR/TTS，接口、模型和音色由宿主配置。
- `./speech-providers`：火山双向流 ASR/TTS；PCM 连续上传、增量文本合成和可中断流式播放。
- `./speech-catalog`：模型、音色、参数范围与依赖条件；共享设置页按此目录生成控件。
- `./host` / `./settings`：DSH 与独立桌面入口复用的生命周期、凭据引用和配置。

宿主提供现有 Electron 可执行文件。此包不下载 Electron、模型或用户凭据，也不创建独立开机启动。

```js
const device = await openDesktopDevice({ electronExecutable, signal, inputDeviceId, outputDeviceId });
const recording = device.createRecording();
await recording.start(onError);
recording.markSpeech();
const wave = await recording.take(); // 提取一段，麦克风继续采集
await recording.dispose();          // 等待资源真实释放
await device.close();              // 等待整个 Job 无活动进程
```

## 生命周期与凭据

Job 使用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子附着于 CreateProcess，句柄不可继承；创建时挂起，宿主准备好后才恢复。宿主正常退出或被强杀，所属进程树被内核回收。不同宿主持有独立 Job。

具备 nonce 的私有命名管道承载有界消息，不监听 HTTP。子进程环境按白名单传递；API 密钥留在宿主，音频子进程不获得凭据、会话或工具权限。外部服务请求禁止重定向，外网端点要求 TLS。

采集开启过程中暂停会等待不可取消的 getUserMedia 返回，停止迟到 tracks 并关闭 AudioContext；超时由宿主回收整个设备 Job。清理失败不能视为完成，调用方必须保留围栏，禁止启动替代设备。

麦克风在识别 HTTP 请求期间保持开启。识别结果按顺序提交，队列有界；用户开口可先停止 TTS，不需要等下一份识别结果。回声消除请求由系统实现，实际效果需指定设备验收。

字幕支持显示、皮肤、字号、透明度、拖拽、调整大小和锁定。锁定禁用原生移动/缩放与拖拽区域，托盘保留解锁入口。位置/大小变化回调给宿主保存；显示器变化时夹到可见工作区。

## 构建与验证

`npm run build` 构建隔离 renderer 和产品图标；`npm test` 验证连续采集与真实 Windows Job 生命周期。Windows Job 测试仅创建和强杀测试进程，不操作正式宿主。

当前已验证：Job 正常退出、强杀、挂起创建、孙进程回收及另一 owner 存活；设备枚举、WAV 采集、生成音调的 PCM 流播放、迟到音频拒收、释放和重开。协议测试使用离线替身；真实提供商识别、合成与声学打断仍待验收。

设置页支持按提供商和模型保存参数，分组搜索、音色筛选及数值校验。当前详细能力目录以火山为首个适配；兼容服务尚无完整参数目录。协议未接入的能力明确显示为不可用。范围与扩展要求见 [能力契约](SPEECH_CAPABILITIES.md)。

### 设置草稿与导航

设置分为对话、语音识别、语音播报、设备和外观。提供商、模型、识别模式与参数先进入草稿，点击“保存设置”后生效；关闭时可继续编辑、放弃或保存并关闭。模型列表刷新、试听及麦克风测试需要当前草稿时，按钮明确标为“保存并…”。DSH 宿主模型选择仍即时更新默认模型，并在控件旁说明。

宿主通过 `previewSettings(patches)` 与 `saveSettingsBatch(patches)` 提供同一套校验及模型配置归并逻辑。预览不持久化、不停止语音；批量保存最多 64 个补丁，在一次存储提交中应用，禁止直接写配置档案。连接密钥按实际提供商和地址另行保存。界面区分未保存状态、配置缺项与连接中断。
