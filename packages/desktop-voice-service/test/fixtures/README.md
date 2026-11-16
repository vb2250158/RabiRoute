# 公开测试素材 / Public test fixtures

- `pcm-wave.mjs`：从现有 `speech-sample.test.mjs` 提取的静音 PCM/WAV 生成配方，只在内存中产生协议测试输入，不含人声。
- `job-parent.mjs`、`job-child.mjs`：已有的进程所有权测试程序。PID 和结果文件在测试时临时生成，不保存真人或会话数据。

这些自编测试代码按仓库 [LICENSE](../../../../LICENSE) 分发。目录本身不证明素材可公开；第三方素材须另列来源和分发条件，含个人信息的输入留在 Git 忽略目录或仓库外。无需新增音频文件。

`pcm-wave.mjs` extracts the existing silent PCM/WAV recipe for in-memory protocol tests. The existing job programs create temporary process-test state. These authored fixtures follow the repository license and contain no personal recordings or real conversations. Third-party fixtures require documented source and distribution terms; private input stays outside tracked source.
