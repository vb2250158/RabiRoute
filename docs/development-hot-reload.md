<!-- docs-language-switch -->
<div align="center">
<a href="./development-hot-reload_en.md">English</a> | 简体中文
</div>
<!-- /docs-language-switch -->

# RabiRoute 开发热重载

开发反馈和正式验收分开：

- WebGUI 使用 Vite HMR，入口为 `http://127.0.0.1:8793/`。
- RabiSpeech 可以显式使用 Uvicorn reload；启动前必须先停止占用 `8781` 的正式实例。
- Manager 不进入安全热重载循环。Manager 拥有 Route 子进程，重启会连带抖动 NapCat、RabiLink、个人微信和角色会话，可能使来源会话 token 失效。
- Android 原生代码不支持这套热重载，改动后仍要重新构建 APK。
- 功能定稿后运行匹配测试和完整构建；激活复用[源码热补丁](source-hot-patches.md)或[Web热补丁](web-hot-patches.md)的支持矩阵。完整打包仅用于明确交付安装包或必要的生命周期切换。

常用命令：

```powershell
# 仅 WebGUI，默认且安全
npm run dev:hot

# WebGUI + RabiSpeech；只在 8781 正式实例已经停止时使用
npm run dev:hot:speech

# 仅 RabiSpeech
npm run speech:dev

# Manager 只允许在隔离的数据目录/端口中人工启动
npm run manager:dev:isolated
```

`npm run dev:hot -- --check` 只检查本轮需要的端口，不启动服务。安全启动器拒绝 `--manager`，避免误把常驻消息端纳入文件监视重启。

## 单个插件的隔离构建

仅准备指定包时，使用已有构建入口并指定独立候选目录：

```powershell
node scripts/build-plugin-packages.mjs --package io.rabiroute.manager.route-control --output-directory ../route-control-candidate
```

`--package` 可重复；包必须来自当前构建profile。目标构建保留输出中的无关包，不生成完整desktop profile，也不自动补齐运行依赖。SDK类型在暂存目录生成，不回写源码。默认无参数构建仍处理完整profile。

输出的 `build-evidence.json` 记录实际暂存输入、产物摘要、工具版本与阶段耗时，仅证明构建内容。它不代表测试缓存资格、正式Loader验收或安装生效；现行匹配测试与完整构建要求继续执行。候选输出由单个任务写入，失败恢复原输出；实际发布仍交原发布owner。

## 本批源码改动

性能诊断未安装sink时直接执行原操作，避免时间戳与计时开销；可选sink抛错不会改变业务结果，失败计数由 `performanceOperationStatus()` 回读。操作日志可在消费者初始化时用 `bind(group, level)` 绑定惰性detail工厂，过滤变化经 `configureFilter()` 更新。旧 `record()` 调用仍兼容，调用者提前构造的detail不会自动变为惰性。

角色聊天记录按摘要分页，长正文按需展开，页面缓存有界并支持向前、向后继续读取；切换角色取消旧请求。断线补齐保留继续入口，新消息仍可刷新。消息检索的索引、稳定顺序及容量证据见[消息历史检索](message-history-search.md)。

这些是源码与隔离验证的行为说明；安装版生效由原发布owner另行回读。

## 候选测试证明与发布准入

`node scripts/verify-plugin-candidate.mjs --config <本地配置.json>` 在临时目录中冻结声明输入与构建候选，然后执行 Node 测试；现有完整构建及发布流程继续生效。配置示例：

```json
{
  "sourceRoot": "../source",
  "candidateRoot": "../candidate",
  "cacheRoot": "../verification-cache",
  "inputs": ["tests/plugin", "packages/shared-contract"],
  "tests": ["tests/plugin/behavior.test.mjs"],
  "deterministic": false,
  "completeInputClosure": false
}
```

路径相对配置文件；inputs 相对 sourceRoot。测试通过 `RABI_PLUGIN_CANDIDATE_ROOT` 访问冻结产物；相对导入所需源码、资源及依赖必须包含在 inputs，目录成员也纳入摘要。链接先由调用者物化，不默认借用工作区 node_modules。工具执行可信本地 Node 测试，不是安全沙箱，不接受网络提交的执行指令。

只在审查确认测试不依赖网络、时钟、随机、未声明文件、用户环境或可变外部能力，且全部依赖已声明时，将两个声明设为 true。普通未声明测试仍正常执行，只是不复用。缓存只记录成功结果，绑定输入、测试、候选文件、Node 可执行文件、工具代码、平台与架构；损坏缓存重新执行，缓存写入失败保留真实测试结果。输出保留最后 16 KiB 测试诊断，测试使用合成数据，勿输出凭据。

此工具验证目标构建证据中的实际文件，也拒绝包内额外文件；测试改变输入或产物后不得形成通过证明。原发布 owner 已对本地配置命中的插件、带来源记录的源码及 Web 候选执行准入，实际调用此 CLI，并在提交前复核候选字节、身份与基线。完整配置、适用来源、失败保旧和取消退出合同统一见[开发候选匹配验证](developer-candidate-admission.md)。缺少规则的既有发行包或合法其他来源继续原正式合同；正式 Loader、资源释放、外部依赖及激活回读仍实际执行。

回执中的 `mode=shadow` 是验证工具保留的标记，不表示原 owner 尚未接入，也不能单独授权发布。影响图当前仍作影子对照，实际运行配置 `tests` 全集；准入使用真实测试结果及候选摘要，不把 `selectedTests` 当作已执行证明。不宣称所有发布来源都已获得增量测试覆盖，源码自动 code revision 的边界见上述准入文档。
`RABI_PLUGIN_CANDIDATE_ROOT` 只暴露本次证据覆盖的包和共享合同，不暴露输出中无关包或构建回执。继承的系统/用户目录环境参与缓存指纹；测试若依赖这些目录里的可变内容，或依赖临时目录的绝对名称，仍不可声明为封闭确定性测试。

### 自动影响闭包的影子对照

配置可加入 `impact.units`，每个单元声明 `id`、自身 `inputs` 路径与 `tests`，插件再声明 `manifest` 路径和实际 `bindings`（服务名到 provider 单元 ID）。工具从冻结文件解析静态 import/re-export、类型引用、字面量动态导入和 URL 资源，合并 manifest 的 provides/requires/optional、实际绑定与反向消费者。`runtimeInputs` 声明运行时文件读取闭包，`dynamicInputs` 声明动态加载/目录发现闭包；这些是经审查的完整依赖声明，不是绕过未知依赖的开关。必要宿主服务可用 `impact.externalServices` 声明，当前可用性仍须运行验收。

首次运行无基线扩大到完整声明集；下次将前次 `impact.snapshot` 放入 `impact.baseline`。摘要比较自动识别新增、删除和重命名的两侧，旧依赖边保留用于计算受影响消费者。解析错误、未归属输入、未解析导入或未声明动态读取都会给出 `reasons` 并扩大到完整验证。当前不解析任意别名/裸包解析语义，此类依赖明确扩大，不假定安全。

`selectedUnits`/`selectedTests` 是影子建议，实际仍运行配置 `tests` 全集；`missingCoverage` 对照单元声明测例和真实完整执行集。用例已证明独立单元不会因无关 provider 改动被选中，但这不等于完成全仓依赖声明或允许跳过现行完整构建。基线和声明变化也进入验证缓存键。
Vue/Svelte/Astro/HTML/MDX及样式等尚未解析的源码类型会明确扩大验证；通过node:module获取的createRequire（包括别名）须声明dynamicInputs，否则同样扩大。影子分析不把未支持语法静默当作无依赖。

### 原生源码与 Web 产物

同一验证配置可显式选择 `artifactKind: "source-patch"` 或 `"web-patch"` 并给出 `artifactSha256`。源码候选目录为原 managed directory，hash 对应 `<hash>.json` 的完整字节；Web目录为原 `manifest.json` 所在目录，hash仍是该manifest完整字节。未设置时仍处理 plugin-build。

源码/Web验证复用正式后端构建的 `HotPatchCandidateStore` / `verifyWebPatch` 及其原校验，冻结本轮读取的owner产物字节并纳入指纹；需先有 `npm run build:backend` 产物，缺失时报出真实依赖错误，不另写宽松schema或转成插件证明。测试只获得原owner实际验证的产物闭包，使用 `RABI_CANDIDATE_ROOT`；原插件环境变量继续兼容。回执明确区分 `artifactKind`、原始 `candidateSha256`、独立 `inputSha256` 和 `coveredArtifactRoots`。兼容性、当前身份/基线以及正式发布事务仍由对应原owner执行。
