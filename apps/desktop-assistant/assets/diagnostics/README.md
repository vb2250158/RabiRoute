[English](README_en.md)

# 识别诊断资源

`recognition-zh-CN.wav` 是应用内“识别示例”的公开固定输入，中文内容为“今天天气怎么样？”，不是用户录音或人格参考音频。该资源随应用分发，开发测试也读取同一文件；仅供开发的假数据仍放在 `test/fixtures`。

来源为 Microsoft 官方 [Speech SDK 示例仓库](https://github.com/Azure-Samples/cognitive-services-speech-sdk)，固定提交、原文件路径、Git blob、SHA256、格式和文本见 [source.json](source.json)。保留了上游原始字节；只有 PCM 格式与音频数据块，没有用户路径、凭据或应用运行元数据。来源仓库根目录的 MIT 许可允许复制和分发，完整版权及许可随资源保存在 [LICENSE.Microsoft.txt](LICENSE.Microsoft.txt)。上游第三方通知及样本目录没有该音频的另行许可声明。

运行时直接读取文件，不调用 PowerShell、系统语音、Azure SDK 或联网下载。样本需要当前 ASR 支持中文；测试用于验证当前识别链路，不能代表识别准确率。资源缺失或损坏会明确报错，不伪造识别结果。
