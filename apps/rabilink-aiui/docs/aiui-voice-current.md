[English](aiui-voice-current_en.md) | 简体中文

# AIUI 对话、语音与真机排查

2026-11-07 工具链再次联网核验：npm 当前稳定版 AIX/AIX CLI 为 `0.12.0`，manifest、lockfile 与本机隔离构建依赖已升级；Ink 仍为 `0.19.1`。官方 Skill `main` 仍指向 `00c6ec71ee313817705683248b3ebe2acf0937f0`，项目/全局各 58 文件审计通过。新版通过源码与指定 AIX 各 48 项合同、完整 Agent 检查和包审计；同步打包了新增任务跟进维护说明。官方 CLI `check` 零错误，仍有下述 `AIX033` 警告。此升级没有更新 Studio 或眼镜运行时；工具用法以[官方 CLI 文档](https://yodaos-project.github.io/aix/cli)为准。

同日补查 Studio 原位编辑路径：原“拉比连续对话联调”仍显示已同步，文件树和 `pages/home/index.js` 可读，右键及命令面板可操作。编辑器使用 `native-edit-context`，可见代码行可聚焦，但内置浏览器 `locator.press` 始终超时，未能复制完整旧源码；原生 CDP 输入方法也被工具明确拒绝。命令面板未提供可用的全选命令，因此未覆盖任何文件，也未新增工程。桌面备用控制受当前 computer-use 技能禁止操作 ChatGPT 桌面 UI 的规则限制。本轮 ADB 仍无设备。当前需要恢复受支持的浏览器编辑/文件上传能力，或由用户将本页列明的 AIX 导入既有工程，才能继续新版官方模拟器验收。

2026-11-07 当前本地候选已接入普通异步任务跟进：`rabi_task_follow` 保存原任务 GET 查询合同，页面前台读取终态，经同一助手生成并保存摘要，再等用户空闲及页面更新回调后确认通知。隐藏停止、原绑定重开恢复；停止跟进不取消后端任务。13 项专项回归、源码与指定 AIX 各 48 项页面合同、完整 Agent 检查和包审计通过。AIX 为 133216 字节，VERSION `7209ef26-79c2-412c-8375-854b2f73f97a`，SHA-256 `793c922369e748846f6daa1ec667ce3804a4446c8da4675a7d7b1983324f2045`。共享 SDK 0.9.0 与主后端未变。本轮未重新尝试已确认失效的 Studio 文件选择器；云端仍以此前实测为准，新包未导入或安装。测试使用模型/网络/存储夹具，不能证明真实任务、麦克风或声音。详见[任务跟进合同](generic-api-transport.md#普通异步任务跟进)。

2026-11-06 前一分页候选交付复核：当时 SHA-256 `7fcdc365…` 文件与已验证包一致。内置浏览器能读取主工程并打开 `.aix导入`，但立即提交文件仍返回 `No node found for given backend id`；页面未出现覆盖确认，也未更新工程。工具未提供 Studio WebMCP 导入能力，切换原生文件选择的 CDP 方法也明确不支持，因此没有绕过到脚本注入或抓取登录凭据。当时 `adb devices -l` 为空，未完成模拟器新版验证或设备安装。已在[执行循环](agent-turn-runtime.md)列明各项实现与缺口，修正旧版本说明冒充当前状态的问题。

2026-11-06 当前本地候选增加接口目录分页：`rabi_api_help` 默认每页 32 条简短索引，找到编号后再读完整合同。真实 Manager 注册表/隔离 HTTP 的 43 接口夹具完整目录为 1,254,942 字符，分页后两次索引观察为 10,021 / 4,262 字符，目标接口只调用一次。3 项分页/错误回归、29 项循环/传输回归、源码与指定 AIX 各 47 项页面合同、完整 Agent 检查和包审计通过。未修改主后端或共享 SDK。内置浏览器可读取原主工程，仍保留 5 个工程；本候选未导入或安装，上一候选导入曾遇到文件选择器失效。详见[接口分页与恢复编号](generic-api-transport.md)。

2026-11-06 当前本地修复：工具传输抛错及回执结算保存失败原来会让模型丢失自动生成的操作编号。现在 `requestIdentity` 随实际结果或未确认状态返回，保留原编号与目标供读取回执；重复记录明确 `resultAvailable=false`，不冒充原业务结果。2 项回归先失败后通过，助手循环/通用传输/角色/手机桥共 45 项通过，源码与实际 AIX 各 46 项页面合同、完整 Agent 检查和包审计通过。项目和全局 Skill 各 58 文件与锁定官方提交一致，共享 SDK 0.9.0 未变。原工程的真机页与代码页导入均遇到 `fileChooser.setFiles: No node found for given backend id`，未到覆盖确认步骤；本候选尚未导入，云端仍为下述 1.0.2。模型、网络和存储恢复测试使用夹具，不能证明真实 PC 或眼镜验收。

2026-11-06 前一账本恢复候选的 Studio 实测（本地 SHA-256 `0b151ffb…`）：通过内置浏览器 DOM 接口，在原“拉比连续对话联调”导入该候选，未新建草稿。官方模拟器初始化成功，模拟转写驱动真实宿主模型完成“记住了”及正确口令“青竹四九”两轮回复，均自动续听；TTS 均报 `Host capability speech.synthesize is not configured on Web host`。原工程随后重新打包保存为云端调试版本 `1.0.2`，界面显示“调试版本已就绪”，资源 `521911add4924faca1daae75e6e4a451-1793975531936.aix`、99.80 KB。云包下载工具超时，未取得文件路径，尚未逐文件核验云端重打包内容。手机同步、眼镜安装、物理 ASR 和声音仍未验收。截图：`studio-ledger-first.png`、`studio-ledger-second.png`、`studio-ledger-cloud-ready.png`。

2026-11-06 工具回执复核：同一 `callId` 的冲突校验原来只使用内存 Map，恢复持久化记录后，改变目标、路径、正文或操作编号仍可能得到旧的完成状态。现为读写请求都保存摘要指纹，恢复时核对原指纹；旧记录缺少指纹时返回未确认且不重放。账本已满时仍先核对已有操作，再拒绝新增记录。3 项回归先复现后通过，通用传输/角色集成共 17 项、源码及指定 AIX 各 44 项、完整 Agent 检查及包审计通过。

后续页面恢复修复已补齐：`prepareRabiApiTools()` 通过独立账本模块按连接范围恢复操作摘要，模型重建和页面重开只更新会话身份及清理旧读取记录，不清空写入历史。旧单范围账本先复制、读回验证，再迁移计数器；中途失败可继续迁移。每次写前保存并读回，旧 owner 和 `/meta` 等待期间释放的 runtime 都不能继续派发。28 项传输/角色/手机桥测试通过，新增编译页面测试验证在途写入只派发一次、重开不重放且旧 owner 迟到回执不覆盖新账本；源码和指定 AIX 各 45 项、完整 Agent 检查及包审计通过。网络和设备存储为夹具，真机持久化仍需验收。

当前容量限制：每个连接范围最多保留 128 个操作摘要，另有每会话 128 个读取记录。达到写入限额时拒绝新写入，但已有操作核对和独立读取仍可用；不会靠重开模型清除原操作。尚未提供用户侧的账本归档/清理流程，不能把这一有界候选称为无限期运行验收。

2026-11-06 Web 模拟器复核：修复音频写入等待 ASR HTTP 请求完成的问题，写入现在只排队，识别请求串行返回；正常停止会排空尾段，取消立即结束并忽略迟到结果。包含在途请求在内最多保留 4 段，积压超限或网络失败会明确报错并停止收音，不静默丢弃输入。宿主/服务端共 7 项测试通过，覆盖串行写入、结果顺序、尾段、取消、同 ID 重开、积压及服务端隔离；这是夹具证据，不能证明真人双工或回声消除。

内置浏览器已实际打开本机测试台并显示 Ink `0.19.1` 页面加载完成，但当前服务尚未配置 API，因此对话、真实麦克风及声音未验收。官方 Studio 标签仍读取超时。本次仅改模拟器宿主，没有重新生成 AIX、更新云端主工程或安装设备。

Studio 清理记录（2026-11-06）：在内置浏览器删除 18 个重复测试草稿，刷新后仅保留“拉比连续对话联调”、用户原有“夜雨小助手”（原“夜雨对话”）、“Rabi”、“蓝牙测试”和“weather-forecast”。后续只更新“拉比连续对话联调”；下文旧云端草稿均为历史实验记录，不再作为测试入口。清理没有更新主工程代码或安装眼镜。

状态核对日期：2026-11-06。官方文档的 `latest` 在先前核对时解析到 `main`，不是设备运行时版本；以下 API 合同不能证明某副眼镜已支持或正在运行该版本。

当前本地页面已接入[逐条插话回执](input-receipts.md)、只读记录视图和共享助手 `0.9.0` 的监听/独立播报生命周期，新工具任务按原 ID/绑定重新决策。记录视图支持查看完整原话、保存答案和状态，浏览不重放、不停止现有推理或收音。480×352 与 448×150 实际 Ink 夹具验证了翻页、换条、返回和安全边距。历史 protocol-scope 候选验证过官方模型的两轮文字上下文及本地工具派发，独立诊断包验证过工具等待插话。最新候选及切句修复仍在本地，未更新主工程云包或安装眼镜。

共享播报迁移候选的实际 Ink 检查完成 20 次模式往返，215 个配置画面采样无黑帧或残帧；随后的切句修复通过 43 项源码构建及指定 AIX 页面合同。记录内容和语音合同使用隔离夹具，不能替代设备存储或真人语音验收。

2026-11-06 工具链复核：官方 `main` 仍为锁定提交 `00c6ec71ee313817705683248b3ebe2acf0937f0`，项目/全局 Skill 内容审计一致。npm 的 AIX 与 AIX CLI 已发布 `0.11.0`，本项目 manifest/lockfile 和本机构建依赖已升级；Ink 仍为 `0.19.1`。补齐本机隔离快照所需的 WebGUI、Android 合同源码及锁定依赖后，统一 `Check-Agent.mjs` 完整通过，包括两个真实 HTTP/PC 回执存储恢复测试；这不是根仓库全量构建或正式 Host 验收。新工具下源码和指定 AIX 各 44 项页面合同通过，重新生成相同 VERSION 的包得到相同 SHA-256，无需新增候选身份。

官方 CLI `aix check dist/craft-upload --format json` 返回零错误及一项 `AIX033` 警告：使用网络 API 但未声明 `INTERNET`。当前锁定 Skill 的权限表只列出 `GEOLOCATION`、`CAMERA`、`RECORD_AUDIO`，Ink 类型未找到 `INTERNET` 合同，因此保留并记录工具/运行时说明差异，不仅为消除警告而添加未证实权限。该检查不证明网络调用或声音已在眼镜上运行。

### 2026-11-06：对照 Studio 对话记录复核

后续工具播报审查：编译页面复现工具 `onResult` 先播固定状态、模型答案随后排队的问题。现已移除工具回调的直接播报，保留状态/结果视图与交给模型的完整回执。新增同一编译页面回归覆盖成功、未确认结果、工具等待时用户停播：只播模型回答，停播时保留文字及原工具结算。源码与指定 AIX 各 44 项通过，另有 5 项角色/API 集成及 15 项执行循环检查；网络、模型和 TTS 为夹具。共享 SDK 0.9.0 未改。

用户提供的 Studio 对话记录是问题线索，不是运行时合同；其中多次声称静态验证通过，随后又出现首字后停播、第二轮无输入及转录消失。对照当前[官方语音 API](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-dev/references/apis/ai.md)与本项目实现：

- `synthesize()` 接收该次完整文本，不能向同一任务追加后续模型片段。正文按句送入独立播报队列，末尾无标点文字在模型完成后补交；不能只提交首个片段，也不为了完整性把所有普通文本都延迟到流结束。
- 官方没有共享 `speechSynthesis.cancel()` 或 utterance 生命周期事件。需要取消、字幕和完成事件时使用 `synthesize()`、`SpeechAudioPlayer` 及底层播放器事件。任务 `finished` 是合成完成，计时器是失败看门狗，均不作播放成功证据。
- 用户开口只停止播报，保留当前 ASR、文字结果、模型和已派发工作；不采用“哨兵识别到开口后销毁它再启动另一轮”的输入切换，避免把首段用户语音丢在切换中。固定 1500ms 禁止打断不能证明回声消除或随时可打断，声学效果仍须设备验证。
- `interimResults` 是请求，不是跨宿主支持保证。当前适配器在能力接口存在时按 `getCapabilities()` 降级；没有接口时不凭一条泛化的 `network` 错误来回切换配置。最终结果与 interim 显示分别处理，不把临时文本当最终指令。
- 复现并修复了数据块末尾 `.` 被提前当句号的问题：`3.` + `14`、`example.` + `com`、`v1.` + `2` 现在保持连续。增加 `؟`、`؛`、`۔`、`।`、`॥` 句末符号；这只是标点分段，不承诺所有语言缩写和语义边界识别，也不证明宿主有对应语言音色。
- 普通正文流可分句播报；严格 JSON 动作/最终回复仍等完整校验后才释放文字，不播读协议字段。该路径仍有首音延迟，不能用通过分句测试来宣称已消除。字幕由 cue 更新，当前也未完成 GPT 级实时语音的声学验收。

本轮新增两项编译页面回归先失败、修复后通过；源码及指定 AIX 各 43 项，另有 9 项插话/引导和 6 项模型生命周期回归通过。项目与全局 Skill 各 58 文件均匹配锁定提交 `00c6ec71ee313817705683248b3ebe2acf0937f0`；本轮联网核对了官方语音 API，未把此项检查说成整套上游已重新更新。

现有主工程的 `.aix导入` 曾在立即提交文件时报告 `No node found for given backend id`。用户关闭批注后，重试确认“更多操作”可以展开，但文件选择仍超时，随后重新读取标签也超时。未写入编辑器、未创建新草稿，不能把菜单恢复当作包已导入。

### 2026-11-06 独立对话与跨宿主输入复测

PC 领凭据成功、失败、鉴权失效及连接成功现在只更新连接状态，不覆盖原生用户输入、回答和聆听意图。实际 OpenAI 测试宿主完成两轮记忆口令，Ink 页面显示第二轮回答且播放器均报告结束；输入是模拟文字，不能证明真人听见或 Rokid 语音能力。

长回复中模拟开口已取消正在合成的句子，旧队列未继续提交；下一轮文字生成后没有新 TTS 记录。随后发现测试中的 Ctrl+Home 被原页面“任意按键停播”处理，不能据此认定声音会自动恢复。新增隔离回归复现 12 次无关按键触发停播，修复后只接受既有镜腿键。当前 41 项页面合同通过；执行环境切换后原浏览器不可用，尚未完成该修复的真实页面复测。

共享助手 0.7.3 修正 final JSON 外出现全局前缀的提示歧义，严格解析不变。真实 OpenAI 同题复测完成接口发现和一次只读调用，最终 text 的前缀、随机计数和回执正确。仅一次模型实测，不代表任意模型稳定遵循。此前电脑的私有凭据、6063 模拟器和本地产物未迁移；本机只建立无凭据的构建快照，不将旧服务地址称为当前可访问入口。

## 当前源码的对话路径

### 当前交付与验收状态

以本节选择测试包。下文逐次实验中的“当前”“最新”“尚未上传”只描述该实验当时的状态。

| 对象或要求 | 当前证据与缺口 |
| --- | --- |
| 最新本地候选 | `rabilink-aiui.aix`；SHA-256 `793c922369e748846f6daa1ec667ce3804a4446c8da4675a7d7b1983324f2045`；VERSION `7209ef26-79c2-412c-8375-854b2f73f97a`；133216 字节，共享助手 `0.9.0`。保留接口分页，新增原任务查询与持久通知；48 项源码/指定 AIX 合同、13 项任务跟进回归、完整 Agent 检查和包审计通过。共享 SDK 未改。尚未导入或安装；账本及订阅容量限制仍在。 |
| 云端与安装 | 原主工程“拉比连续对话联调”已原位导入并重新打包保存为 `1.0.2`，资源尾号 `1793975531936.aix`、99.80 KB；显示已同步及调试版本已就绪。仍保留 5 个工程，没有新建草稿。云包下载未取得文件路径，未逐文件核验云端产物；眼镜安装未验收。 |
| 连续对话与打断 | 前一账本恢复候选（本地 SHA-256 `0b151ffb…`）导入后在官方 Studio 通过模拟转写完成“记住了”及“青竹四九”两轮真实模型回复，并自动续听。TTS 两轮均报告 Web 宿主未配置 `speech.synthesize`。本机 Ink 合成夹具验证只停播、保留原模型工作；本次原请求身份修复尚未进入官方模拟器，真人 ASR、实际声音、回声及声学打断未验证。 |
| 全局提示与接口调用 | 官方 Rokid 模型诊断验证自然语言前缀和本地关闭工具派发；关闭仅被接受，页面未退出。真实 OpenAI 联测验证接口发现与调用测试 HTTP 接口。当前 Rabi Manager 不可发现，实际 PC 业务接口端到端验收未完成。 |
| 后台工作与双工体验 | 0.7.2 独立诊断包使用真实乐奇模型完成等待工具时回答插话、工具请求延后、原任务结束后处理新任务，两工具各一次且结果独立；工具后端、转写及记录存储是夹具。Rabi 页面的任务事件订阅与通知呈现仍未完成，真实 PC 长任务和声音未验收，不能宣称达到 GPT 实时语音体验。 |
| 设备条件 | 本次 `adb devices -l` 无设备；此前“只见手机”的记录已过时。官方 Web host 最后语音测试报未配置 `speech.synthesize`，不能代替眼镜声音验收。 |

回执恢复在注册及成功续租后查询原 delivery/session/epoch。PC 仍为 claimed 且原身份有效时，可按原键补交已保存的完整结果；确认结果一致后继续领取，不重跑模型或工具。源码与验证细节见[设备 Agent](device-agent.md)。正式发布、主 Host 重启和具体工具仓库改动均不在本次操作中。

### 工具等待期间插话：真实模型诊断

SDK 0.7.1 的第二条工具请求因 defer 附带 text 被记为未确认。0.7.2 将可选有界说明纳入合同，但不把说明作为答案、完成回执或执行指令。官方 Studio 诊断随后完整通过，全局前缀在普通回复和插话中保留。详见[探针边界、复现命令及实际证据](tool-wait-probe.md)。通过的是独立诊断包，本节正式候选另行构建；不把模拟工具说成真实 PC 接口。

### 普通回答误用插话格式：实测与修复

input-review 候选首轮出现 `TURN_DECISION_INVALID`。仅增加诊断的 protocol-diagnostics 候选同题复现 `unexpected-interjection`，确认返回的是插话专用类型。0.7.1 将该格式从长期 system 提示移到实际独立输入请求的 `responseFormats`，编号由应用填写，保留原严格校验。

protocol-scope 候选随后同题显示“记住了”，第二轮追问返回“松林七五”；第三轮完整自然语言关闭请求产生 `tool:dispatch close_app` → `exit:requested` → `exit:accepted`。页面仍显示，不能称实际关闭。三轮均报 Web host 未配置 `speech.synthesize`，不证明声音或声学打断。证据为本机 `studio-unexpected-interjection-20261106.png` 与 `studio-protocol-scope-{first,second,tool}-20261106.png`。当时未验证长工具等待插话；后续 0.7.2 诊断结果见上节。

### 2026-11-06 当前候选与真实宿主提示词验证

**当前设备调试入口：拉比连续对话联调。** 生命周期修复包已通过独立 AIX 导入并云端保存，Agent ID `521911add4924faca1daae75e6e4a451`，表单版本 `1.0.1`，云端资源 `521911add4924faca1daae75e6e4a451-1793899167720.aix`（91.11 KB）。Studio 显示已同步、调试版本已就绪，截图为本机 `studio-owner-storage-cloud-ready-20261106.png`。云端重打包内容尚未下载比对，手机资源同步、眼镜安装与声音验收未完成；未提审发布。

现有工程的 `.aix导入` 文件选择器返回已失效节点，生成脚本的编辑控件为只读，完整文本复制结果为空，因此未通过编辑器写入旧工程。改用“新建智能体 → .aix导入”成功，再保存为上述独立调试草稿。旧「拉比助手联调」保留输入优先权候选，不再作为本轮设备更新目标；下文未上传等描述保留原时间点含义。

后续生命周期修复候选为 `rabilink-aiui-1.0.39-owner-storage.aix`，SHA-256 `5ae12eb0577a8b3f5cf0393c92eca8d65c373fa31f73b3dea172f08677fb07d6`、VERSION `9ab83b7a-794a-47f7-8584-12b5affc38fd`。修复旧设备注册启动影响新连接、等待期间的存储快照覆盖新任务记录。18 项设备 Agent 回归、`check:agent`、34 项实际 AIX 页面语音合同及 `delivery:verify` 通过；实际 Ink 完成 20 次模式往返、220 个配置样本，无黑帧/残帧。此为最新本地候选，尚未导入 Studio 或安装眼镜；下述云端 `1.0.2` 仍是输入优先权候选。ADB 手机在线但前台为其他应用，本轮未切换；Manager 动态发现未成功。

输入优先权候选为应用 `1.0.39`、共享助手 `0.5.3`，AIX SHA-256 `972d5f2d77256c3d464b5133e150bb3faed511aee28f4d7e7f00840bb7974f48`。设备调试草稿「拉比助手联调」已保存为表单版本 `1.0.2`，资源 `4cffb4fb90114c579dbec982535b3fdd-1793894703811.aix`（91.04 KB），界面显示已同步、调试版本已就绪。云端包下载超时，重打包内容与本地候选的比对未完成；尚未安装眼镜或发布。

00:39–00:41（Asia/Hong_Kong），在官方 Studio 独立诊断草稿验证自定义全局提示。诊断包只更改已构建包的备用 `systemPrompt` 与 VERSION，不修改正式源码或上述设备草稿；SHA-256 `7db6199918db257ad6413249f77199d33198e7f1e517999560d9f494b651f466`。提示要求所有自然语言字段以「青竹四二：」开头，工具 JSON 外层不变。实际 Ink 加载检查通过（20 次模式往返、207 个配置样本无黑帧或残帧）；生产包一致性审计因这项有意的代码差异拒绝该诊断包，不将它当正式交付候选。

- 输入「请算一下17乘以23是多少，用一句话回答。」后，真实宿主模型显示「青竹四二：17乘以23等于391。」。
- 未再次轻触，输入非快捷口令「这轮测试已经完成，请调用你已有的工具关闭当前应用，回到系统界面。」，显示「青竹四二：正在关闭应用。」，日志依次出现 `tool:dispatch close_app`、`exit:requested`、`exit:accepted`。因此本次全局格式要求与模型生成的应用工具协议兼容；页面仍显示，实际关闭未验收。
- 两轮均报告 `Host capability speech.synthesize is not configured on Web host`。这证明提示词及本地工具派发，不证明出声、声学打断或 PC 接口调用；输入使用模拟转写。诊断草稿为 `rabilink-global-prompt-probe-20261106`，仅本地导入、未保存到设备调试云包。

证据保存在本机 `studio-global-prompt-reply-20261106.png`、`studio-global-prompt-tool-20261106.png` 与同名工具日志文本。手机 profile 和启动参数传入自定义提示的真实设备链路仍需单独验证。下方保留旧候选在各时间点的状态，不能作为当前版本选择依据。

### 较早候选记录

最新退出回执候选 SHA-256 为 `6b207692594fb6d2d9c64e483a4d20387748fad98178ae26443db1e7a3ff900a`（应用 `1.0.39`，共享助手 `0.5.2`）。快捷口令、模型工具和配置助手共用退出入口，等待 `wx.exitMiniProgram` 的 success/fail；3 秒未回调报未确认，重复请求合并，仅记录阶段和工具名。`Page.finish()` 只在 wx 接口不存在时使用，返回仍只表示已提交请求。4 项退出合同、`check:agent`、打包和实际 AIX `delivery:verify` 通过（20 次模式往返、207 个样本无黑帧/残帧）。此候选已导入 Studio 并保存为云端调试草稿，尚未安装眼镜。

2026-11-05 23:21（Asia/Hong_Kong）在新候选提交同一句非快捷关闭请求，依次观察到 `tool:dispatch close_app`、`exit:requested`、`exit:accepted`。这证明真实乐奇宿主模型已产生可解析动作、应用已派发本地关闭工具、wx 已调用 success 回调；页面仍然显示，未观察到 onHide/onUnload，因此不能称实际退出成功。TTS 仍报 Web host 未配置 `speech.synthesize`。证据截图为本机 `studio-1039-native-tool-exit-accepted.jpg`。PC 工具调用、全局回答格式、眼镜声音和声学打断仍待验收。

当前设备验收草稿为 **拉比助手联调**，Agent ID `4cffb4fb90114c579dbec982535b3fdd`，云端表单版本 `1.0.1`，AIX `4cffb4fb90114c579dbec982535b3fdd-1793892389050.aix`，90.84 KB。Studio 已显示“调试版本已就绪 / 可进行真机调试”；未提审或安装设备。云端重打包与本地 AIX 哈希分开核对。旧“拉比对话测试”保留为此前候选。

2026-11-05 22:52–23:02（Asia/Hong_Kong），前一提示词候选 `203693...` 已导入官方 Studio。一次点击启动后，两轮模拟识别输入分别得到“记住了。”和“银杏九号”，第二轮没有重新点击；两轮均进入 TTS，但 Web host 仍报告未配置 `speech.synthesize`。自然语言“这轮测试已经完成，请调用你已有的工具关闭当前应用，回到系统界面。”不匹配本地快捷口令，显示“正在关闭应用”后仍留在页面。网络面板显示 Rokid 模型请求 HTTP 200，但未采集 SSE 正文，无法据此证明工具动作已派发。退出回执候选新增日志用于区分这两个阶段；原生工具、全局格式要求与真实声音仍未验收。截图为本机 `studio-1039-prompt-order-context.jpg`、`studio-1039-prompt-order-exit-attempt.jpg`。

提示词顺序候选使用共享助手 `0.5.2`：协议和工具目录在同一条 system 消息前部，全局提示原文在末尾且只出现一次。2026-11-05 22:38（Asia/Hong_Kong）真实 OpenAI 中间件联测通过接口发现、随机只读调用、回执核对及最终回答前缀要求；此前的顺序对照和失败记录保留为历史证据。源码及归档各 45 项共享测试、严格类型、AIUI `check:agent` 和实际 AIX `delivery:verify` 通过（20 次模式往返，209 个样本无黑帧/残帧）。AIX SHA-256：`203693a0dcb4541e83afd4323ba335d73b170680d8a2c662b68e3a4d1bffc585`。此候选已导入 Studio，未云端保存或安装眼镜；云端“拉比对话测试”仍是下述 `e6b0bb...` 候选。OpenAI 结果不代表乐奇模型或真机验收。

以下为此前各阶段的验证记录，包哈希与当时状态分别保留。

2026-11-05 当前共享助手已到 `0.5.1`。按轮 `assertCurrent` 在出队、模型初始化及工具派发边界校验原任务，失败返还原输入与未消费引导。`supportsTurnGuard` 同时核验协调器和底层会话，旧会话混装时拒绝启用。源码与独立解包各 45 项助手测试及严格类型检查通过，完整 AIUI `npm run check` 和 `delivery:verify` 通过。DSH 已回报固定包集成通过，覆盖排队、等待模型回复以及 `executing-tool` 回调后切换任务，三种场景均保留原文且工具调用为零。其正式 UI 和设备入口仍待启用验收。

随后修复了原生 ASR 构造失败时仍保留聆听意图、缺少明确失败提示的问题。转写和配置入口现在均清理聆听状态，显示“麦克风初始化失败”，并允许用户再次轻触重试。原生语音合同测试 26/26 通过，`check:agent`、重新打包及 `delivery:verify` 通过；实际 Ink 加载完成 20 次同页模式往返，109 个配置画面样本中无黑帧或残帧。这些检查尚不能证明用户设备上的卡住或无声原因。

网络状态修复候选为 AIUI `1.0.39`，AIX SHA-256 `1d5c13e10e3738c277cfe8e21ade6d875932aa2ebddb680ffa6c807900e010be`。`check:agent`、打包及 `delivery:verify` 通过，实际 Ink 完成 20 次页面模式往返，208 个配置画面样本无黑帧或残帧。该候选已在官方 Studio 取得实际模型文字回复并保存为云端调试草稿；真机安装、实际声音和双工验收仍未完成。

### 播报队列后续修复

审查“夜雨对话”后继续核对本页面，复现并修复了两项队列问题：下一句错误地把队列条目当成语音选项，丢失所选 voice/volume；已经播放结束的上一句仍接受迟到字幕，覆盖当前句。现在出队传递原 options，字幕回调同时核验完成、页面可见性、销毁和取消状态。两个新增回归先失败再通过，原生语音合同共 28/28 通过。

播报队列候选为 `1.0.39`，SHA-256 `b577f4a9eb38d932495daa167006c4afa47dcf3cbc64d43e0a0ef4898eacb542`。`check:agent`、打包及 `delivery:verify` 通过；实际 Ink 完成 20 次页内模式往返，200 个配置画面样本无黑帧或残帧。

随后在官方 Studio 导入该包，首轮输入“请记住本轮测试口令是蓝鲸七号，只回答：记住了。”，模型回答“记住了。”；重新轻触后输入“刚才的测试口令是什么？只回答口令。”，模型回答“蓝鲸七号”。两轮均使用模拟识别输入，均出现 Web 宿主缺少 `speech.synthesize` 的错误，识别通道也在本轮后结束。此结果证明两轮模型上下文，不证明连续收音或真实出声。截图：本机 `studio-1039-queue-fix-two-rounds.jpg`。

该队列候选已保存为 `rabilink-aiui-1.0.39-speech-queue-fix` 云端调试草稿，页面显示调试版本就绪；Agent ID `078f8ec682544ac9a1d950c7e85151e2`，表单版本 `1.0.1`，云端 AIX `078f8ec682544ac9a1d950c7e85151e2-1793885261489.aix`，90.48 KB。未提审、未安装真机，云端重打包不沿用本地哈希。

### 前台续听修复

上述测试促使进一步审查：旧 `scheduleTranscriptionRestart()` 实际清除聆听意图，并不续听。当前改为首次交互后，在可见页面保留聆听意图，正常结束延迟至少 220ms 重新启动；暂停、隐藏、模式切换或宿主错误后停止。连续三次不足 1 秒且没有结果的结束也暂停并提示重试。每次启动仍由宿主校验 interactive 状态及权限，不模拟用户激活、不绕过拒绝。

新增测试先复现旧逻辑不续听，再验证模型工作期间恢复收音、暂停/隐藏取消续听、宿主拒绝不循环重试，以及空结束次数上限。源码与 AIX 解包的原生语音合同均为 30/30；`check:agent` 通过，实际 Ink 启动检查验证首个错误后停止，第二次唤醒后有界续听。续听候选 AIX SHA-256 为 `1fb23f51d56bb55d12782041963bf5bb357d4590373b9961cd25bca78b954fe4`，`delivery:verify` 通过（20 次模式往返、202 个样本无黑帧或残帧）。

2026-11-05 21:45（Asia/Hong_Kong），该包已导入官方 Studio，首次轻触后输入“请记住测试口令是星河八号，只回复记住了。”，第一轮 end 后自动出现新的 start-requested/start-dispatched；未再次轻触即提交第二句“刚才的口令是什么？只回复口令。”，画面显示“星河八号”且仍处于识别状态。截图为本机 `studio-1039-continuation-two-rounds.jpg`。这证明官方模拟输入链路自动续轮及模型上下文；不证明真实声学输入、无间隙收音或出声。该次没有观察到 TTS 失败日志，不能据此认定 TTS 已恢复；需要新的停播原因日志区分语音是否被抑制。此候选仅导入，云端已保存包仍为队列修复版。

### 手动打断保留后台任务

进一步审查发现旧 `interruptConversation()` 在轻触和按键入口销毁模型、清空引导，与语音输入只停播的行为不一致。当前轻触、镜腿按键和语音唤醒均使用同一停播入口，保留原模型请求、引导队列、识别器和任务代次；缺少识别器时才由本次真实交互启动。正常结束仍等待原模型返回。另修复自动续听用启动提示覆盖用户原话的问题。

新增回归先复现取消原任务和覆盖原文，再验证三个手动入口及续听；源码和打包 AIX 合同均为 32/32。`check:agent`、打包与 `delivery:verify` 通过（20 次模式往返、206 个样本无黑帧或残帧）。最新本地候选 SHA-256 为 `76c4607107ec745b9bf521e119870b66eb119015e7b3490daefef88f963da0f4`，尚未导入 Studio 或安装眼镜。停播日志仅记录 wakeup、speech-onset、transcript 或手势来源，不包含对话正文。真实声音、回声抑制、工具执行期间打断及此候选的 Studio 复测仍待验收。

### 修复后官方 Studio 验收

后续停播诊断（2026-11-05 22:02–22:17，Asia/Hong_Kong）定位并修复了自动续听后的整轮误静音。`76c460...` 候选在 Studio 正常显示“现在开始语音播放测试。”，但新识别流启动后出现 `speech:suppressed speech-onset`，未进入 TTS 调用。单独的本地 Ink 启动夹具未复现该 onset，不能把它概括为所有宿主的行为。

当前仅在已有播报或合成输出时响应 speech onset 停播；无输出时等待实际识别文字再抑制旧轮回答，显式手势/唤醒仍可停播。新增回归先失败后通过，源码及 AIX 解包的语音合同均为 33/33。最新候选 SHA-256 `e6b0bbef48780978d7d49de37ee3762413f421b11511b6b0c37098220a4f44cd`，`check:agent`、打包及 `delivery:verify` 通过（20 次模式往返、201 个配置画面样本无黑帧或残帧）。

同句官方 Studio 复测已显示模型回答，并进入 TTS 调用，返回 `Host capability speech.synthesize is not configured on Web host`，没有再次出现该起始事件抑制日志。自动续听仍保持识别状态；这是误抑制修复和合成调用证据，不是实际音频成功。证据为本机 `studio-1039-speech-onset-suppressed.jpg` 与 `studio-1039-onset-fixed-tts-request.jpg`。播报期间重新开流是否产生误停播、声学回声与真人打断仍需验收。

该候选已保存为云端草稿 **拉比对话测试**，显示已同步、调试版本已就绪；Agent ID `b747363c22e648adb3d12a21e0be5aa7`，云端表单版本 `1.0.1`，AIX `b747363c22e648adb3d12a21e0be5aa7-1793888245351.aix`，90.66 KB。本地应用版本仍为 `1.0.39`，云端重打包哈希另计；未提审、未安装到眼镜。保存证据为本机 `studio-1039-onset-fix-cloud-ready.jpg`。

2026-11-05 20:52（Asia/Hong_Kong），内置浏览器独立标签运行 `rabilink-aiui-1.0.39-network-fix`，初始化和识别通道启动成功。提交“你好，请只回答：语音测试成功。”后，眼镜模拟画面显示用户原文及模型回答“语音测试成功。”，本轮无 `host turn failed`。因此原生 `LanguageModel` 在当前 Studio 可以完成这次对话；无需换成平台智能体 API 来解决此前的网络误判。输入仍是模拟文本，不算真人声学识别验收。

本轮唯一可见语音失败为 `Host capability speech.synthesize is not configured on Web host`。模型回答与 TTS 能力分别验收，不能据此声称眼镜原生宿主也不支持播放。证据：本机 `studio-1039-model-reply-fixed.jpg`。

随后“真机调试 → 打包并保存”成功，草稿已同步、调试版本就绪；Agent ID `c54f32a5e6de4b44b1ef18cac26e270e`，云端表单版本 `1.0.1`，包大小 90.49 KB。云端重新打包与本地 AIX 哈希分别记录。未提审或发布。官方[快速入门](https://github.com/yodaos-project/AIUI/blob/main/documentation/0-guide/quickstart/quickstart.md)要求随后在 Rokid AI App 的“设置 → 开发者 → 更新眼镜资源包”，看到下载成功后唤起对应智能体；本次尚未执行设备更新。

### 平台智能体与原生模型的差别

用户提供的“夜雨对话”包使用 `createOpenAPI().agent.invokeAgentApi()`。官方 [aiui-cloud-apis Skill](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-cloud-apis/SKILL.md)及[调用合同](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-cloud-apis/references/invoke-agent-api.md)定义了 agent_id、question、conversation_id 和图片字段；没有独立 system prompt 或客户端 tools 参数。它调用平台已配置的智能体，不能在未核对提示词和工具归属时当成同等的 LanguageModel 替代。当前保留已验证的原生模型路径及共享助手循环。

### 网络状态误判修复

进一步追查发现，先前日志中的“网络不可用，请检查网络连接”来自页面自己的 `navigator.onLine === false` 前置拦截；`executeLingzhuAgentPrompt` 和 `ensureChatModel` 都有此判断，catch 还会以该状态覆盖实际失败。此前据此称宿主模型请求失败不够准确：页面可能根本未调用模型。

实际 Ink `0.19.1` Page VM 网络探针报告 `onLine=false`、`connection.type=unknown`，同时两次 HTTP 二进制往返均为 200，错误列表为空。官方 Navigator 文档也未把网络提示定义成模型服务可达性合同。当前已移除两处前置拦截与错误覆盖，继续由 `LanguageModel.availability()`、创建/请求超时和真实结果决定是否可用，不绕过鉴权或更换模型。

新增回归先复现了零模型调用，再验证离线提示下可完成宿主回答，以及真实 `TURN_TIMEOUT` 不被覆盖；6 项模型生命周期回归和 26 项原生语音合同通过。此证据纠正页面误判，不证明官方模型或眼镜已经可用；官方 Web 宿主缺少 `speech.synthesize` 是独立的已观测故障。

### 内置浏览器实测（1.0.39）

2026-11-05 19:32 后（Asia/Hong_Kong），按用户要求切换内置浏览器。首次选择 AppData 下候选时，Studio 读取文件报错；将同一哈希候选复制到 Downloads 并以正斜杠绝对路径交给文件选择器后，成功导入 `rabilink-aiui-1.0.39-c0efdefe-simulator`。目录和路径格式同时变化，尚不能确定首次读取失败的单一原因。此操作只建立浏览器内存中的可编辑草稿，不代表云端上传或设备安装。

“直接运行智能体”初始化成功。唤醒后应用在 15 秒记录 `transcription-asr:start-timeout`；先提交测试文字暂存、再模拟镜腿单击，仍未建立识别通道。另导入只增加启动阶段日志的诊断包 `rabilink-aiui-1.0.39-asr-diagnostic.aix`，SHA-256 `f33d19901cd76f78a6242c57022e6924379844f17b0866ab0d585dd72fe8e69a`，VERSION `b1b9d80f-d163-44ee-b60b-904b31597348`，AIX 审计及 26 项原生语音合同测试通过。诊断日志顺序为 `start-requested`、`start-dispatched`、`start-timeout`：其中 `start-dispatched` 仅表示适配器的启动调用返回，不证明宿主接收了音频或建立了通道。

页面已经声明 `RECORD_AUDIO`。此前浏览器公开 Permissions API 返回 `microphone=prompt`、`secureContext=true`，正常 `getUserMedia({audio:true})` 短探测未返回；成功回调会立即停止全部音轨。用户随后明确确认已允许麦克风。19:56 后同一诊断草稿的镜腿单击成功建立识别通道，系统日志出现 `openRecognitionStream`，输入框变为“输入文字并回车，模拟语音识别结果”。提交“你好，请只回答：语音测试成功。”后，系统日志确认最终识别结果已提交。这里验证的是麦克风获准后的通道建立和模拟文字提交，尚未验证真人语音的声学识别。

19:57 和 20:12 两轮均记录 `host turn failed: 网络不可用，请检查网络连接`，随后记录 `TTS playback failed: Host capability speech.synthesize is not configured on Web host`。后者是播报错误提示时的失败，不是成功模型回答的播报。两项宿主故障需分别处理；不能由此推定眼镜原生宿主也不支持该 API。网络面板没有宿主请求记录，模型错误的具体服务端或网络原因尚未定位。没有改用共享 `speak()` 来冒充独立停播验收。

两轮之间，在“真机调试”中补全工作类别和测试用途描述后执行“打包并保存”。诊断草稿 `rabilink-aiui-1.0.39-asr-diagnostic` 已显示“已同步／调试版本已就绪”，表单版本 `1.0.1`，Agent ID `5f6ce17d75be4e1fb6b307160bafbdb8`，云端包显示 90.53 KB。此表单版本不同于应用显示的 `1.0.39`；云端重新打包产物也不能沿用本地诊断 AIX 的哈希。保存后复测仍为上述错误，因此“尚未上传”不能解释这次失败。当前真机调试页提供下载 AIX，未显示设备同步按钮，尚未安装到眼镜或完成实际出声、打断及恢复验收。普通候选草稿仍待上传。

本机证据为 `C:\Users\GAN\AppData\Local\RabiLink\aiui-tools\studio-1039-cloud-ready.jpg` 和 `studio-1039-mic-allowed-host-errors.jpg`。Studio 控制已交还 DSH 测试，已同步导入、云端保存步骤与上述验收边界。

### 官方 Studio 模拟实测（旧版 1.0.38）

2026-11-05 15:42–15:47（Asia/Hong_Kong），在 Studio 1.3.0 的 `rabilink-aiui-1.0.38-default-stage` 工程执行“直接运行智能体”，页面报告初始化成功，并产生 `page:onLoad`、`app:launch`、`app:show`、`page:onShow`、`page:onReady` 日志。模拟画面显示版本 1.0.38。

“触发语音唤醒”后，系统日志记录已向 Interactive InkView 派发“乐奇”。提交“你好，请只回答：语音测试成功。”后，系统日志显示“ASR 调试输入已暂存，将在语音识别通道建立后自动提交。”画面仍显示“正在聆听 / 等待语音”，没有新增模型回复或应用语音日志。随后取消唤醒，系统日志确认取消。此证据把本次旧版阻塞定位到识别通道建立之前；它不证明物理设备故障原因，也不代表新版行为。

为核对入口差异，后续将 `Smoke-RabiLinkAiuiInkRuntime.mjs` 的主视图改为不传 `mode` 参数，并派发中文“乐奇”唤醒，紧凑视图继续覆盖显式转写模式。对上述同一 SHA-256 的 1.0.39 AIX 重跑通过：交互前 ASR 调用为零，唤醒后实际 Ink 向测试宿主发起一次 PCM 识别请求，20 次页面模式往返通过，108 个配置画面样本无黑帧或残帧。识别结果仍由本地测试宿主提供，此项仅排除本地检查依赖显式模式参数的疑点，不能替代 Studio 服务或物理麦克风验收。

尝试用 `.aix 导入` 上传已核验哈希的 1.0.39 候选时，浏览器扩展拒绝设置本地文件，要求启用“允许访问文件网址”。未成功导入、未创建新版工程、未修改旧工程代码。用户启用权限后继续新版验收。现场截图保存在本机 `C:\Users\GAN\AppData\Local\RabiLink\aiui-tools\studio-1038-asr-pending.jpg`。

### 前一阶段记录

2026-11-05 后续代码进展已到共享助手 `0.4.1` 和语音包 `0.3.0`。助手提供用户优先排队、原作用域任务观察和独立的持久呈现确认，37 项共享测试及严格类型检查通过。语音包提供异步草稿交接，保存期间继续收集下一批，失败保留原 ID 与原文，18 项测试及严格类型检查通过。DSH 已回报 `0.4.1` 持久通知确认与语音 `0.3.0` 加密草稿交接联调通过，覆盖写入延迟期间接收下一批，以及退出后迟到结果保持原任务归属。Rabi 页面仍需对接真实任务事件与通知呈现，跨任务订阅和离线补齐由后端提供。

本轮候选 `dist/rabilink-aiui.aix` 的 SHA-256 为 `ab19aee53b94dd875638d5c7e6c67a912403d6b28b6f02143b0f28f98dd6b247`，完整 `npm run check`、AIX 审计和实际 Ink 加载通过。最近一次 ADB 检查无设备，用户选择暂时继续代码工作。下方保留较早阶段的测试记录及旧候选哈希，真机检查在设备恢复后继续。

页面接收用户交互后启动宿主 `SpeechRecognition`，将识别出的文字交给宿主 `LanguageModel`，并把模型回复展示和分句播报。默认对话不要求 Rabi PC 在线，但依赖实际宿主、权限和网络；宿主模型不等于离线模型。执行循环及其尚未验收的部分见[执行循环](agent-turn-runtime.md)。

当前源码的对话播报使用 `speechSynthesis.synthesize()` 创建任务，再用 `new SpeechAudioPlayer(task)` 和 `player.play()` 播放。合成任务本身不会发声。应用需要独立停止播放以支持打断，因此不会在缺少独立播放器时静默改用共享 `speak()`。代码入口是 `utils/voice-runtime.js` 和 `pages/home/index.ink`；这说明源码意图，不代表已安装的包相同或眼镜已发声。

## Ink 网络能力实测

2026-11-05 在 `@yodaos-pkg/ink` 0.19.1 的 Web/WASM Page 虚拟机内运行独立探针，使用本地同源 HTTP 回显服务。探针通过 Page 的 `onLoad` 执行，宿主没有向页面虚拟机注入 polyfill。

- `btoa` / `atob` 对含零字节与高位字节的数据往返一致。`Buffer` 的类型为 `undefined`。
- `crypto.getRandomValues` 接受 32 字节数组并返回同一对象。此检查覆盖 API 行为，随机源的安全属性依据官方合同。
- `AbortController` / `AbortSignal` 可用，取消事件触发一次，带 signal 的延迟 `fetch` 以 `AbortError` 拒绝。
- `ArrayBuffer` 与带偏移的 `Uint8Array.subarray` 均准确发送六字节，服务器实收与 `response.arrayBuffer()` 回读一致。
- `response.headers.get()` 能读取大小写两种 `Content-Length` 名称及自定义响应头。

重跑命令为 `node scripts/Probe-InkNetworkCapabilities.mjs`。脚本输出能力报告，并断言上述往返行为。网络接入继续使用安全随机源和加密协议。官方 Web API 合同见 [Web networking and encoding](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-dev/references/apis/web.md)。

DSH 随后将实际 `eye-noise.ts` 与 `@dsh-remote/crypto` 打包到同版本 Ink Page VM。2026-11-05 本侧复核并重跑其独立探针，Noise IK 握手、双向加解密和密文篡改拒绝均通过，VM 错误列表为空。两端在同一 VM 中运行，静态身份密钥使用固定测试种子；此结果覆盖库打包与协议互操作。跨设备 HTTP、真实配对、跨源策略及眼镜原生宿主仍待验收。

同日进一步复核并重跑 DSH 的跨运行时 HTTP 探针。Ink Page VM 中的实际 `eye-noise`、`eye-http-client` 与语音交接适配器，通过本机 HTTP 连接 Node 中的实际 Noise responder 和 `eye-tool-endpoint`。任务回执为 `accepted`，语音交接回执为 `retained`，模拟手机端分别调用一次，VM 错误列表为空。该实验使用固定测试身份、空身份代际校验、内存操作账本和模拟工具及存储接收器；回执中的 `journalSaved` 与 `retained` 仅验证调用协议。持久化、真实授权、重试恢复、Android 原生服务和物理设备链路仍待对应测试。

随后同一探针接入共享助手 `0.5.1` 和语音 `0.3.0`，本侧复核并重跑语音归并、`retained`、手机端轮次预留、共享模型决策、加密 `task_send`、结束回执及重复调用。实际输出为 `retained`、`processed`、`receiptSaved=true`，第二次返回 `already-reserved`；工具派发、语音接收和轮次结束各一次，模型请求共两次，VM 错误为空。模型回复和预留/持久化接收器仍为夹具，预留夹具按调用次数返回重复状态，因此这里只验证客户端遵守预留回执，以及整个适配链能在 Ink 中运行。跨重启持久去重还需真实存储测试。

## 与官方最新版的合同

### Craft 内置 `aiui-dev` Skill

本机已同步官方完整 Skill 到项目 `.agents/skills/aiui-dev/` 与 Codex 技能目录，共 58 个文件；旧版 10 文件布局已退出加载路径，恢复备份留在项目外。来源提交与逐文件 Git blob 哈希记录在 `.agents/aiui-dev-source.json`，`npm run check:skill` 校验完整文件集合和内容，已接入 `check:agent`。官方文件保持原样，项目补充规则写在本项目 `AGENTS.md` 和 `skills/rokid-development/SKILL.md`；全局 RabiLink 技能仅作当前规范入口。这里核验的是本地副本，不证明 Studio 云端内置 Skill 已更新。

同日后续回归再次发现全局目录与项目版本不一致：全局副本缺少新版参考文件并保留旧 `references/apis/geo.md`。旧副本已完整备份至加载目录之外，再从已校验的项目副本同步。同步后两处 58 个文件的集合及 Git blob 哈希均通过；重新查询官方 `main` 仍为下述提交。此次没有证据确定是谁改写了全局副本。

官方仓库是 [yodaos-project/AIUI](https://github.com/yodaos-project/AIUI)，旧的 `jsar-project/AIUI` 入口已重定向。2026-11-05 查询的 `main` 为 `00c6ec71ee313817705683248b3ebe2acf0937f0`。本轮已读 [SKILL.md](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-dev/SKILL.md)、`references/framework.md`、`events.md`、`apis/index.md`、`apis/ai.md` 和 `checklist.md`；SDK 包版本与这个文档仓库版本分别记录。

- 普通对话流卡片只供展示；需要按键与麦克风交互时，必须确认打开的是受支持的交互式全屏 Page。不能把本地夹具调用 `setInteractive(true)` 当成设备卡片可交互的证明。
- `onVoiceWakeup` 同时接收语音与触摸唤醒，包含 `clickAiAssist`；当前 RabiLink 不按唤醒词过滤，符合该规则。`onReady` 在首帧呈现后运行一次，不代表网络或语音已经就绪。
- [当前 AI/语音参考](https://github.com/yodaos-project/AIUI/blob/main/skills/aiui-dev/references/apis/ai.md) 说明音量赋值可保留小数，实际音量、语速、音调取决于服务；这与下方 API 页面“0–10 整数”的描述存在差异。保留现有默认值 1，禁止据此直接诊断无声。
- Skill 将 `SpeechRecognition.start()` 的条件描述为所属 InkView 保持 interactive；下方早先读取的 API 页面强调每次用户交互触发。续听修复采用当前 Skill 合同：首次交互后在前台续听，宿主拒绝即停止。实际 Ink 已验证非交互预览不采集、交互运行时有界续听；官方 Studio 和眼镜仍需复测。

### API 页面复核

- [语音识别](https://js.rokid.com/AIUI/api/ai/speech-recognition?lang=zh-CN&version=latest)：每次 `SpeechRecognition.start()` 必须由用户交互触发；采集麦克风需要声明并获得 `RECORD_AUDIO`，外部音频识别会话自身不打开麦克风。旧的独立 `SPEECH_RECOGNITION` 权限不再要求。实际包的声明和运行授权仍需分别核对。
- [大语言模型](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=latest)：先检查宿主可用性，创建会话后可用 `prompt()` 或 `promptStreaming()`；是否能在当前设备使用须检查实际返回值。
- [语音播报](https://js.rokid.com/AIUI/api/ai/speech-synthesis?lang=zh-CN&version=latest)：`speak()` 使用共享播放器直接播报；`synthesize()` 返回独立任务，需要 `SpeechAudioPlayer` 播放。两条路径独立，不应为同一段文字同时调用。独立播放器提供 `stop()`、`destroy()`；共享 `speak()` 没有文档承诺的 `cancel()` 或完整 utterance 生命周期事件。
- 官方文档列出 `utterance.volume` 为 0–10 的整数，默认 1；`lang` 当前不改变生成语言。当前适配器显式设置 `volume=1`，并设置 `lang`。不能仅凭这个默认值判断用户的无声原因，应在相同设备、相同内容下验证实际输出与音量。
- [AIUI Studio 真机调试](https://js.rokid.com/AIUI/guide/quickstart/quickstart?version=latest)：需先打包并同步资源，再在设备上运行；模拟器结果不代替眼镜验收。不同地区或 App 版本的入口可能不同，应以实际界面为准。

## 无声或没有回答时

### 依赖与修正复核：AIUI 2026-11-06，Android 记录为 2026-11-05

| 层级 | 项目当前依赖 | 官方发布查询 |
| --- | --- | --- |
| AIX 读取与校验工具 | `@yodaos-pkg/aix@0.11.0` | 本轮 npm latest `0.11.0` |
| AIX CLI | `@yodaos-pkg/aix-cli@0.11.0` | 本轮 npm latest `0.11.0` |
| Ink 本地渲染工具 | `@yodaos-pkg/ink@0.19.1`；daily 兼容别名也锁定 `0.19.1` | npm latest `0.19.1` |
| Android CXR-L | `client-l:1.1.2` | 官方 Maven release `1.1.2`；latest 为 `1.2.X-SNAPSHOT`，不是稳定版 |
| 眼镜 CXR bridge | `1.8` | 官方 Maven release `1.8` |
| Phone SDK / Glass3 Open SDK | 均为 `2.6.2-P` | 官方 Maven release `2.6.2-P`，不使用更高编号的 SNAPSHOT |

来源：npm 的 [AIX](https://registry.npmjs.org/@yodaos-pkg%2Faix/latest)、[AIX CLI](https://registry.npmjs.org/@yodaos-pkg%2Faix-cli/latest)、[Ink](https://registry.npmjs.org/@yodaos-pkg%2Fink/latest)，以及官方 Maven 的 [client-l](https://maven.rokid.com/repository/maven-public/com/rokid/cxr/client-l/maven-metadata.xml)、[bridge](https://maven.rokid.com/repository/maven-public/com/rokid/cxr/cxr-service-bridge/maven-metadata.xml)、[Phone SDK](https://maven.rokid.com/repository/maven-public/com/rokid/security/phone.sdk/maven-metadata.xml)、[Glass3 Open SDK](https://maven.rokid.com/repository/maven-public/com/rokid/security/glass3.open.sdk/maven-metadata.xml)。旧 RokidAiSdk 四个本地 AAR 仍为 `1.4.3`，[官方样例](https://github.com/Rokid/RokidAiSdkDemo)未发现更高公开版本。升级本地依赖不会更新眼镜固件或 Studio 运行时。

Ink `0.19.1` 已正式替换本地依赖；测试宿主补齐新版识别能力查询及流式会话接口。页面按能力协商中间识别结果，晚到的能力查询不能重新启动已停止的轮次。真实 Ink 渲染、手势识别、20 次页内切换、启动安全和两种模式的交互缩放均通过。

本次补齐 `RECORD_AUDIO`、空名称过滤、ASR 启动确认和超时；镜腿确认键与轻触均可开始识别。实际 Ink `0.19.1` 的 `SpeechAudioPlayer.audioPlayer` 使用 `onCanplay`、`onEnded`、`onError`，不是 EventTarget。旧代码漏接完成回调，播放结束仍会超时；当前页面按原生回调等待数据和完成事件，保留旧 EventTarget 兼容，重复可播放回调只启动一次，清理后的晚到事件不覆盖结果。缺少完成回执不报成功。

Android 已适配 bridge `1.8` 所需的 Context 构造参数，手机 slim/video 构建及单元测试通过，两个眼镜模块已编译打包。NAS 构建输出曾报协议访问错误，本轮手机输出改至本机目录验证；主题生成脚本同步支持实际构建输出目录。

浏览器用测试 SSE 回复与 PCM 测试音完成两轮对话，官方播放器产生真实 ended，停止和重开通过。这不是正式语音、真实麦克风、用户 API 或眼镜扬声器验收。配置覆盖检查已补齐仍有效的 `agentRecipients`、三个 `grokBot*` 字段，并验证四个退役字段由实际保存规范化器移除。修复 Node 临时夹具的 ESM 声明、首帧生命周期和 ASR 启动回调；无凭据初始化不再误报“手机已连接”。根构建仍报告 `@rabiroute/plugin-sdk`、`ajv-formats` 类型依赖错误。Studio 上传和真机启动尚未完成。

### Rabi 与 DSH 共用语音基础

共享包 `0.1.1` 增加 `onSpeechStart`。当前识别轮的宿主 `speechstart` 可在文字返回前停播，保留模型请求与收音；隐藏页面或已停止轮的晚到事件无效。25 项页面语音合同通过。实际 Ink `0.19.1` 测试通过宿主事件停止正在播放的 8 秒测试音，确认待完成模型 SSE 未取消、未制造转写或新请求，并能接收下一轮。这只验证软件链路，不证明真机 VAD/AEC；无文字的开口事件无法用文本相似度过滤自身回声。

ASR/TTS 适配及转写过滤已提取到 [`packages/rokid-voice`](../../../packages/rokid-voice/README.md)，AIUI 原入口只转发导出，构建时内联同一实现。主链仍是 Rokid ASR/TTS；Codex 实时语音仅作为“边说话边干活”的交互参照。插话与取消任务分开，字幕、已播放音频、后台任务结果分别跟踪；不强制旧回复文字继续播放。`0.2.0` 新增 `task-input`：任务 scope 内默认 5 秒归并、设置下一段生效、立即停播、未接收草稿保留和同 scope 显式恢复；12 项测试与严格类型检查通过。手机设置及任务视图尚未消费，Rabi 普通聊天不启用此延时。完整任务控制、DSH 宿主桥接与真机边播边听尚待验证。

当前 `agent-turn-runtime.js` 仍串行等待同一宿主模型请求及工具结果，再消费引导队列；它能停播并接收新话，但不能证明长任务执行期间已有独立即时语音回应。下一步需将任务的受控投递/状态跟随与前台对话等待分离，保留原任务 ID、权限、回执和结果不明语义；不能用取消旧任务或另建重复任务缩短等待。

模型动作协议和串行执行循环已提取为 [`@rabilink/assistant-runtime`](../../../packages/assistant-runtime/README.md)。Rabi 页面已通过 `0.3.0` AIUI 装配入口接入统一会话，注入全局提示词、宿主模型工厂、工具发现、协议与回执适配；每轮回调连接聊天记录、HUD、TTS 和引导。31 项共用合同、15 项 Rabi 循环及 4 项模型生命周期测试覆盖接口发现/调用、不同 Profile、非 Rabi 工具、未知写入、畸形回执、配置切换、阶段超时、迟到清理和取消。DSH 已完成开发快照与适配器的夹具集成，真实 Host/眼镜链路与独立长任务协调尚待完成。

`0.2.6` 在取消/销毁结果和失败异常中返还未消费的内部引导；异常保留原始 cause，兼容冻结的宿主错误。不会重放已取走的输入或取消后台操作。源码与解包的 23 项测试、严格类型、AIUI `check:agent`、重建和最终包 `delivery:verify` 通过，恢复契约已交给 DSH。此前上传权限、UTF-8 脚本生成及默认打包/暂存同步修复后，完整 AIUI 检查通过。默认打包不再要求或读取私有 PC Relay 配置。


`0.2.5` 通过 `pendingGuidance` 返还终止类工具结束时尚未消费的内部引导，调用方按原会话保留草稿；退出不触发工具重放或新模型请求。源码与独立解包的 20 项测试、严格类型检查、`check:agent` 和重建 AIX 审计通过。已把快照与消费约定交给 DSH，草稿界面消费仍待验证。


本轮页面迁移后完整 `npm run check` 退出码为 0，覆盖官方 Skill 校验、配置与接口、语音合同、页面运行、实际 Ink 渲染、两种模式交互缩放、启动安全、默认 AIX 审计及 Craft 上传接口形状核对。模拟器开口停播和下一轮对话也通过；这些是软件执行证据，不代表设备验收。

### 本机官方 Ink 测试页面

文字模式增加“模拟开口打断”：先唤醒并等待识别就绪，在播报时点击，测试无转写文字的停播事件，再发送完整识别结果。该按钮只注入测试宿主事件，不使用物理麦克风。

麦克风模式现在从 PCM 音量检测开口：连续至少 40ms 的高于阈值音频触发 `speechstart`，无需等待转写接口；800ms 静音触发 `speechend`。12 秒转写分段保留开口状态，避免同一句话反复触发新开口。此算法仅用于本地模拟宿主，不是 Rokid VAD，也不证明回声消除；环境声音和扬声器回声仍可能误触发。2026-11-05 回归验证了开口先于转写、分段不重复、上一段转写等待期间可再次开口，以及释放后丢弃迟到事件；服务器与宿主 4 项测试和实际 Ink 浏览器软件打断回归通过。未验真人麦克风声学效果。

在 `apps/rabilink-aiui` 执行 `npm ci`，再执行 `npm run simulator`，打开打印的 localhost 地址。回归执行 `npm run test:simulator`，需要本机 Chrome。测试页使用同一份编译后的 AIUI 页面与项目锁定的官方 Ink，浏览器宿主补充语音事件和 API 中间件；它不是 Studio 云端模拟调试。以 `_blank` 交互页面打开，不能假定 `_current` 卡片支持播放。

填写 Base URL（含 `/v1` 等前缀）、API Key 和模型，点“应用到本次测试”。表单输入的 Key 只存本机服务内存，停止服务后清除，不写入源码、文件和日志。只有 Base URL 不变时，Key 留空才保留旧值；更换地址会清除旧服务凭据，需为新服务重新填写。服务仅监听 `127.0.0.1`，核对请求来源和本次令牌。

页面后台初始化严格等待官方 `onReady` 首帧回调且页面可见，定时器和直接调用不能伪造就绪；隐藏后晚到的启动定时器不执行。真实用户手势触发识别仍保持原调用链，不为了等待后台初始化丢失激活。

模型需兼容 `/chat/completions` SSE；可另配置 `/audio/transcriptions` 和 `/audio/speech`，后者需返回 24 kHz 单声道 s16 PCM。只有对话 API 可先测文字，不能据此声称语音可用。文字模式不打开物理麦克风；真实麦克风模式需要浏览器授权，并将录音发给配置的识别 API。模拟宿主通过启动参数 `ttsSubtitles=none`、`ttsAudioFormat=pcm` 协商无字幕 PCM；设备默认仍为 word/mp3。

观察识别、回复、音频提交、播放请求和播放结束，再由本人确认听见。本机结果不证明安装、蓝牙、固件或眼镜扬声器正常。

2026-11-05 真实 OpenAI 接口复核：`gpt-4o-mini` 短句对话返回成功；`gpt-4o-mini-tts` 返回 3.25 秒非静音 PCM，`gpt-4o-mini-transcribe` 正确识别该测试语音。官方 Ink 页面随后连续两轮通过真实模型与 TTS 接口，并收到播放器 ended。输入仍为模拟文字和生成音频，未验物理麦克风或眼镜声音。凭据只由本机私有启动器读取 Windows DPAPI 加密文件，不进入项目、浏览器配置响应或测试日志。

### 真机检查顺序

新增可选真实模型循环检查：在已经配置 OpenAI 的本机模拟器运行时，执行 `node simulator/Test-LiveAssistantLoop.mjs --execute`（可用 `--origin` 指定本机地址）。不带 `--execute` 不发请求；此项会使用配置的 API 额度，不进入自动回归。它只向模型发送合成测试内容，并在临时本地 HTTP 服务上发现随机路径、读取随机计数和回执。密钥留在已有本机代理中，报告不含密钥。

2026-11-05 实测中，`gpt-4o-mini` 能完成上述发现、调用和回执回读，但指定回答前缀仍未稳定遵循，完整检查未通过。测试还复现了“人格前缀 + 动作 JSON”被当作普通成功回答的问题；共享循环 `0.2.4` 已修复误判和动作内容播报，19 项共享测试、完整 AIUI 检查及实际 Ink 软件打断回归通过。未通过的模型格式要求不能并入已通过清单，也不据 OpenAI 中间件推断乐奇真机表现。

2026-11-05 22:31（Asia/Hong_Kong）再次运行真实模型循环：三次模型请求完成 `api.find` → `api.call` → 最终回答，随机计数与完整回执均正确；最终回答仍缺少全局提示要求的前缀，因此整项验收仍失败。报告位于 `dist/live-assistant-loop-report.json`。没有用后处理补前缀冒充模型遵循提示词，也没有据此放宽验收。

本次 `1.0.39` 已重新生成到默认 `dist/rabilink-aiui.aix`，包含开口停播和统一助手会话接入，通过 9 文件逐项审计；SHA-256：`d67e1bd6fb7457b743f83da02725a09f55acbc4d4fcb0a6b0fe57e06fe92fc72`。主循环迁移及会话竞争修复后完整 `npm run check` 通过；本轮增加 `speechend` 转发后，12 项共享归并测试、严格类型检查、25 项原生语音合同、`check:agent` 与候选审计通过。实际 Ink 开口停播此前通过，未把新增归并当成真机能力。手机端此前 305 项单元测试已通过；根构建此前因 `@rabiroute/plugin-sdk` 与 `ajv-formats` 类型依赖失败，本轮遵照用户要求未调整正在大改的主仓库。本轮读取现有 Studio 标签及用 Edge 打开官方入口均在 30 秒后超时；CLI 未配置 Craft 登录环境变量，ADB 仅发现手机。候选未上传或安装，以下步骤仍待实机执行。

1. 确认眼镜里**实际打开目标 AIUI**，记录页面版本、进入方式及手机连接状态；手机 ADB 显示在线不代表眼镜 ADB 在线，也不证明当前源码已装入宿主。
2. 在页面内按其提示完成一次用户交互并说短句。先确认页面是否显示识别文字、权限错误或其他状态；未识别时先排查交互触发、麦克风声明和授权，不把问题归为 TTS。
3. 识别成功但无回复时，检查模型可用性、宿主网络和实际错误；不要把缺少 PC 连接直接当作默认对话失败原因。
4. 有回复文字但无声时，检查眼镜实际音量和输出设备，再分别确认合成任务、独立播放器构造、`play()` 与任务错误；必要时用官方最小 `speak()` 和独立 `synthesize()` 示例分别做对照，避免把 API 可用性、生成成功与实际听到声音混为一谈。
5. 记录包版本、运行时、设备型号、精确操作、页面提示及去敏错误；由佩戴者确认听见的内容。播报、打断、恢复识别和第二轮对话均需实际验证。

2026-11-05 本次检查：手机 ADB 可见，Rokid App 显示眼镜连接且音量为 9。用户先前确认尚未打开目标 AIUI，后续报告只有文字、无声且停在等待语音。没有取得匹配当前源码的眼镜安装版本、识别或播报日志，不能宣称实机对话已接通。

## 共用 AIUI 装配（0.3.0）

Rabi 页面已使用 `createAiuiAssistantRuntime` 管理语音资源和创建模型会话。开口时先让页面作废播报代次，再取消原生输出，避免同步取消回调重启旧播报队列。31 项共享测试、严格类型、25 项原生语音合同和实际 Ink 软件打断/下一轮测试通过。角色与工具语义仍由后端适配注入；DSH 可消费同一 `./aiui` 入口，其实际宿主与眼镜链路仍待验证。
