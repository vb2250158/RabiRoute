# 公开测试素材 / Public test fixtures

`diagnostic-inputs.mjs` 从现有测试中整理固定假转写文本和内存字节生成代码，不含真人录音、真实聊天、人物资料、凭据或私人路径。字节模式只用于协议测试，不用于证明识别准确率。

这些自编测试素材随仓库 [LICENSE](../../../../LICENSE) 分发。新增第三方素材需记录来源及分发条件；不能仅凭放进测试目录就认定它可公开。私有输入使用仓库已忽略的 `data/voice-assistant/test-private/` 或仓库外临时目录，不复制到这里。

应用诊断使用 `src/recognition-sample.mjs` 动态合成测试句，属于运行功能；无需在本目录另存音频。公开测试素材可以保留在 Git 中，运行包不引用测试目录。

`diagnostic-inputs.mjs` contains fixed mock transcripts and in-memory byte recipes extracted from existing tests. They contain no captured speech, real chat, personal data, credentials or private paths. The byte pattern tests transport, not recognition accuracy. These authored fixtures use the repository license. Third-party fixtures require source and distribution information; private inputs stay in ignored data or outside the repository. Runtime diagnostics continue generating their sample dynamically, without a stored audio file.
