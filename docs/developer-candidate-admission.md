简体中文 | [English](./developer-candidate-admission_en.md)

# 开发候选匹配验证

开发源码根沿用 Host 的 `RABIROUTE_HOT_PATCH_SOURCE_ROOT`，未设置时使用现有 packageRoot。在该根放置 `developer-verification.json`，结构见 [示例](../examples/development-verification.json)。不新增环境变量或网络配置接口。缺配置、配置不可读或结构错误时，记录开发验证不可用的诊断并继续原正式验证，不把它记为开发测试通过。

`plugins` 规则以 `packageId`、`candidateRoot` 和 `verificationConfig` 选择本地开发插件。相对路径以绑定源码根为准；P2 验证配置内部的输入根、缓存根仍相对其配置文件。插件 `candidateRoot` 是目标构建目录，包含 `build-evidence.json` 与 `packages/<id>/<version>`。`sourcePatches` 按唯一 `moduleId` 指定验证配置；`web` 指定 Web 验证配置。这三类规则均可省略。验证配置声明匹配测试和输入闭包，不含秘密。

规则仅匹配 PackageCatalog 已核验的实际来源目录。匹配后执行源码根中现有 `scripts/verify-plugin-candidate.mjs`，缺少测试证明会运行验证；网络提交的 `passed`、路径或命令不能代替实际执行。未配置规则、既有发行包与其他来源的合法插件继续走原安装及 Loader 合同。

测试证明的整个候选摘要与 Loader 的单包 revision 含义不同。准入分别核对整个构建摘要、真实包内容及 Loader 准备的运行副本；发布前复核本地配置、准确候选对象、运行内容及 application/Manager/plugin generation。身份变化后重新准备，不换原操作 ID 重放。

源码 watcher 与本地 Web 构建导入在原候选存储的 `developer-provenance` 目录记录来源，文件绑定候选类型、原 hash 和可信源码根。Web 来源先于候选对发布入口可见；同 hash 手工发布和重启后发布均读同一来源。HTTP 只能引用候选，不接受来源路径。没有这份本地来源的旧发行候选沿原正式合同；已记录来源的某个候选元数据损坏只拒绝该 hash 的新发布，不阻断当前版本和其他候选。修复入口是从同一绑定源码根重新构建或导入。

源码证明使用原 `HotPatchCandidateStore` 的校验与候选 hash，Web 证明使用原 `verifyWebPatch` 的 manifest、逐文件校验和 manifest hash。验证工具冻结正式构建的校验实现，将实现摘要和测试输入一同纳入证明；不复制第二套候选 schema。准入传递真实托管候选路径，测试从 `RABI_CANDIDATE_ROOT` 读取候选，原插件环境名仍兼容。测试后和提交前校验同一份候选字节。

插件验证失败只保留对应实例的上一候选；没有旧版本的新候选不进入发布，无关候选继续。源码或 Web 验证失败保留原服务及发布状态。新模块准备失败后可用下一次修正继续注册。耗时测试在 generation 提交队列外执行，进入原 owner 后再核对身份、基线与证明。已提交的原操作直接返回原回执；源码 rollback 与 Web previous 回退沿已确认旧版本合同执行。准入不持有发布状态，提交、资源排空、回退与回执仍归原 owner。停止时通过验证 CLI 的 IPC 取消测试 runner，等待其退出后清理临时副本。

当前匹配验证覆盖配置命中的插件、watcher 生成的源码模块候选及本地导入的 Web 候选。源码 bundle 各候选均准备后才进入原事务；其中一个失败不会写半份提交。自动 code/Web 联合发布中的 Web 候选受此验证，自动 code revision 本身仍由原 code owner 校验，不能用 Web 的通过证明宣称代码行为测试已覆盖。源码逻辑、CLI 集成、正式包 Loader、Manager 接线与安装版验收分别记录。性能门槛仍需配对排演和连续样本证明。
