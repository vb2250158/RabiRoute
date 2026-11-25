type Copy = readonly [zh: string, en: string];
type ModelDetails = { usage: Copy; abilities: Record<string, Copy> };

const qwenLanguages: Copy = [
  "支持 10 种输出语言：中文、英语、日语、韩语、德语、法语、俄语、葡萄牙语、西班牙语、意大利语。在合成请求里指定目标语言，或用 Auto 自动判断。参考录音的语言可以和目标语言不同，例如用中文参考声线朗读英文。文本按原文朗读，翻译需另行完成。",
  "Synthesizes Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, and Italian. Pick an output language or use Auto. The reference can be in a different language, such as using a Chinese speaker sample to read English text. Provide the final text in the target language."
];
const qwenClone: Copy = [
  "选一段清晰、单人、没有背景音乐的参考录音。Qwen 将约 3 秒的音频作为短参考示例。有参考录音的准确逐字稿时，RabiSpeech 可以同时用录音和原文建提示；只给录音时会使用说话人特征，音色还原可能弱一些。输出读的是新文本。",
  "Use a clean, single-speaker clip without background music. Qwen demonstrates cloning from roughly three seconds of audio. RabiSpeech can use both the clip and its exact transcript. With audio alone it uses speaker features, which may reproduce the voice less closely. The output reads the new text."
];
const qwenAsrLanguages: Copy = [
  "两种参数规模的 Qwen3-ASR 都支持 30 种语言：中文、粤语、英语、日语、韩语、德语、法语、西班牙语、葡萄牙语、俄语、意大利语、阿拉伯语、印尼语、泰语、越南语、土耳其语、印地语、马来语、荷兰语、瑞典语、丹麦语、芬兰语、波兰语、捷克语、菲律宾语、波斯语、希腊语、匈牙利语、马其顿语、罗马尼亚语。留空让模型识别语言；已知语言时可以指定。",
  "Both Qwen3-ASR checkpoint sizes recognize 30 languages: Mandarin, Cantonese, English, Japanese, Korean, German, French, Spanish, Portuguese, Russian, Italian, Arabic, Indonesian, Thai, Vietnamese, Turkish, Hindi, Malay, Dutch, Swedish, Danish, Finnish, Polish, Czech, Filipino, Persian, Greek, Hungarian, Macedonian, and Romanian. Leave the language unset for detection or specify it when known."
];
const qwenDialects: Copy = [
  "官方列出 22 种中文方言或口音：安徽、东北、福建、甘肃、贵州、河北、河南、湖北、湖南、江西、宁夏、山东、陕西、山西、四川、天津、云南、浙江、香港粤语、广东粤语、吴语、闽南语。RabiSpeech 返回转写文字和语言结果，当前本地接入没有单独的方言标签输出。",
  "The published set spans 22 varieties, including Anhui, Northeastern, Fujian, Gansu, Guizhou, Hebei, Henan, Hubei, Hunan, Jiangxi, Ningxia, Shandong, Shaanxi, Shanxi, Sichuan, Tianjin, Yunnan, Zhejiang, Hong Kong and Guangdong Cantonese, Wu, and Minnan. RabiSpeech returns text and a language result. It exposes no separate dialect label."
];
const whisperLanguages: Copy = [
  "可转写包括中文、英语、日语、韩语、法语、德语、西班牙语和俄语在内的多种语言。知道原音频的语言时可指定，例如日语录音指定 ja；不确定时交给自动检测。短片段、背景噪声和同段换语言都会使检测更难。",
  "Transcribes languages including Chinese, English, Japanese, Korean, French, German, Spanish, and Russian. Specify the language when known, such as ja for Japanese recordings, or let the runtime detect it. Short clips, noise, and code-switching make detection harder."
];
const speakerInput: Copy = [
  "使用面向中文的 16 kHz 说话人模型。输入一段尽量只含一个人的语音，输出可用于相似度比较的向量。录音设备、噪声、重叠讲话和样本长度都会影响结果。声音相似度应作为辅助线索。",
  "This speaker model targets Chinese speech at 16 kHz. Give it a clip containing one speaker and it returns a vector for similarity comparison. Recording equipment, noise, overlapping speech, and clip length affect the result. Use similarity as supporting evidence."
];

export const speechModelDetails: Partial<Record<string, ModelDetails>> = {
  "tts-qwen3-0.6b": {
    usage: ["输入要朗读的文字、输出语言和一段说话人的参考录音，生成沿用参考音色的语音。0.6B Base 是较小的复刻检查点，适合先用几句短文本验证读音和音色。需要独立运行环境。", "Provide text, an output language, and a speaker recording to generate speech in the reference voice. The smaller 0.6B Base checkpoint is a good starting point for checking pronunciation and timbre on a few short lines. It requires an isolated runtime."],
    abilities: { multilingual: qwenLanguages, voiceClone: qwenClone,
      lightweight: ["0.6B 表示约 6 亿参数，模型库估算下载体积约 2.34 GiB。可以先用它验证参考声线、专有名词和不同语言读音，再和 1.7B 做同句对比。下载体积不等于运行显存，实际占用还包含推理依赖、精度和缓存。", "0.6B means roughly 600 million parameters. The catalog estimates a 2.34 GiB download. Start here when comparing a reference voice, proper names, and target languages with the 1.7B checkpoint. Runtime memory also depends on precision, dependencies, and caches."] }
  },
  "tts-qwen3-1.7b": {
    usage: ["用参考语音合成新文本，和 0.6B Base 输入方式相同，模型库估算权重约 4.23 GiB。可用同一段参考、同一段台词比较两种规模的音色与读音。Base 走参考录音复刻流程，描述式设计新音色属于另一款 VoiceDesign 型号。", "Synthesizes new text from a recording using the same inputs as 0.6B Base. The catalog estimates a 4.23 GiB download. Compare both sizes with the same recording and lines. Base clones a reference voice. Designing a voice from a description is a separate VoiceDesign checkpoint."],
    abilities: { multilingual: qwenLanguages, voiceClone: qwenClone }
  },
  "tts-cosyvoice3-0.5b": {
    usage: ["2512 权重可根据参考录音合成新文本。RabiSpeech 根据是否输入指令、是否有参考原文选择指令合成或参考音色合成路径。适合用一段参考声线尝试普通朗读和不同说话方式。", "The 2512 checkpoint synthesizes new text using a reference recording. RabiSpeech selects the instruction or reference-based path based on whether you supply a style instruction and reference transcript. Try the same recording with regular narration and a different delivery style."],
    abilities: {
      multilingual: ["官方列出中文、英语、日语、韩语、德语、西班牙语、法语、意大利语、俄语 9 种语言，也覆盖包括广东、闽南、四川、东北和上海在内的 18 种以上中文方言或口音。可跨语言使用参考声线，输出语言由要朗读的文本决定。", "The model card lists nine languages: Chinese, English, Japanese, Korean, German, Spanish, French, Italian, and Russian. It also covers more than 18 Chinese dialects or accents, including Guangdong, Minnan, Sichuan, Northeastern, and Shanghai varieties. Cross-language cloning uses the reference voice with new target-language text."],
      instructions: ["在合成请求的指令里描述表达方式，例如「放慢一点，像讲故事一样」。指令只指导说话方式，要读出的内容单独填在正文里。建议用同一句文本对照试听，再决定指令和参考录音。", "Describe delivery in the instruction field, such as “speak a little more slowly, like telling a story.” Put the words to be read in the text field. Compare the same phrase with and without the instruction before settling on a reference."],
      streaming: ["上游 CosyVoice 支持流式接口。当前 RabiSpeech 的本地工作进程以非流式方式调用这款模型，等本段完整合成后才返回音频。多段台词可以分别提交，但单次请求不会边生成边返回。", "Upstream CosyVoice has a streaming interface. The current RabiSpeech local worker requests complete utterances and returns the audio after each finishes. You can submit several shorter lines separately. A single request does not yield partial audio."]
    }
  },
  "tts-gpt-sovits": {
    usage: ["用参考录音和对应原文合成新台词。适合固定角色声线配短句。当前本地流程使用预训练权重进行参考式合成，较稳定的结果应使用同一套干净参考，而不是把不同人物的录音混用。", "Generate new lines from a reference recording and its transcript. It suits short lines with a consistent character voice. The local workflow uses pretrained weights for reference-based synthesis. Keep the reference clean and consistent across lines."],
    abilities: { shortReference: ["当前模型库推荐约 3–10 秒的干净单人录音。参考录音、对应原文和参考语言应匹配，例如中文应当给实际读出的中文原句。背景音乐、混响、多人说话和长静音会混进声线特征，建议先剪掉。", "Use approximately 3–10 seconds of clean, single-speaker speech. Match the transcript and reference language to what the person actually said. Music, room echo, other speakers, and long pauses can contaminate the voice reference."] }
  },
  "tts-indextts2": {
    usage: ["把参考音色和说话情绪分开指定。可以先固定一条角色音色参考，再对同一句中文台词尝试不同情绪。当前接入返回合成音频，未提供精确秒数对齐。", "Choose the reference voice separately from the delivery. Keep one character recording, then try the same Mandarin line with different emotions. The current integration returns audio without exact duration alignment."],
    abilities: {
      voiceClone: ["参考录音用于提取说话人的音色，正文用于生成新的台词。可以反复用同一条干净的单人录音，以保持多句中文配音的音色一致。情绪通过单独的设置控制。", "The reference recording supplies the voice and the text supplies the new line. Reuse the same clean, single-speaker recording across Mandarin lines for a consistent voice. Emotion is controlled separately."],
      emotion: ["RabiSpeech 支持情绪描述或 8 维情绪向量。填写文字指令时，本地工作进程会优先用指令；未填时用传入向量或默认情绪。可以用「紧张但压低声音」这样的短指令试同一句台词，参考音色保持不变。", "RabiSpeech accepts a written emotion instruction or an eight-value emotion vector. A text instruction takes priority. With no instruction, the worker uses the supplied vector or defaults. Try a short direction such as “tense, in a lowered voice” with the same recording."],
      duration: ["IndexTTS2 论文介绍了精确时长控制，但公开的 IndexTTS2 推理未启用这项功能，RabiSpeech 当前也没有传入目标秒数。配合固定视频时长时，先生成后测量音频，再通过分句、调整文本或剪辑对齐。", "The IndexTTS2 paper describes exact duration control. The public IndexTTS2 inference release leaves it disabled, and RabiSpeech supplies no target seconds. For fixed-length video, generate and measure the clip, then align by editing the script, segmenting, or trimming."]
    }
  },
  "asr-whisper-tiny": {
    usage: ["接收音频并返回转写文字。权重约 0.08 GiB，可先用于弱硬件、短录音和接口连通性验证。多人重叠、噪声、地名与行业专名难度更高，重要结果应对照原始录音。", "Returns text from an audio recording. At about 0.08 GiB in the catalog, use it to check basic transcription on limited hardware or short clips. Review difficult speech, overlap, noisy clips, and specialized names against the original recording."],
    abilities: { lightweight: ["Tiny 是当前 faster-whisper 目录里下载体积最小的档位，约 0.08 GiB 对比 small 的约 0.46 GiB。适合先跑通本机转写，再用同一段录音比较准确率和耗时。下载大小只反映权重占用。", "Tiny has the smallest faster-whisper download in this catalog, about 0.08 GiB versus about 0.46 GiB for small. Use it to validate local transcription, then compare speed and accuracy on the same audio. These figures describe download size."] }
  },
  "asr-whisper-small": {
    usage: ["接受录音文件并输出转写文字，约 0.46 GiB。比 tiny 多占用一些资源，适合日常会议、语音备忘等较清晰录音。多人同一时刻讲话时，需要回听核对文字。", "Produces transcripts from audio files, with a catalog download of about 0.46 GiB. It uses more resources than tiny and is a practical option for clear meetings and voice notes. Review overlapping speech against the recording."],
    abilities: { multilingual: whisperLanguages }
  },
  "asr-whisper-large-v3-turbo": {
    usage: ["面向语音转写优化的 Whisper large-v3 Turbo，当前目录下载约 1.51 GiB。适合较长的内容和通用多语言转写。这里的转写输出原语言文字，需要英文译文时另外使用翻译。", "Whisper large-v3 Turbo is optimized for transcription. This catalog lists a download of about 1.51 GiB. Use it for longer general multilingual transcription. This workflow outputs the transcript in the original language. Translate separately if needed."],
    abilities: { multilingual: whisperLanguages }
  },
  "asr-qwen3-0.6b": {
    usage: ["把音频转成文字，返回文字和识别出的语言。约 1.75 GiB，可用于需要普通话、方言和其他语言的录音；识别界面可传入上下文词汇。当前本机工作进程未配置 ForcedAligner，因此没有逐字时间轴。", "Returns text and detected language. The roughly 1.75 GiB model covers Mandarin, dialects, and other languages and can take context terms. The current local worker does not configure the ForcedAligner, so it exposes no word timeline."],
    abilities: { multilingual: qwenAsrLanguages, dialects: qwenDialects }
  },
  "asr-qwen3-1.7b": {
    usage: ["和 0.6B 使用相同的语言范围和输入字段。此版本约 4.38 GiB，可用同一段带方言、专名或混合语言的录音与 0.6B 比较。当前接入返回转写和语言，逐字时间需要另接对齐模型。", "Uses the same language coverage and input fields as 0.6B. The download is about 4.38 GiB. Compare both sizes with the same dialect, names, or mixed-language recording. This integration returns text and language. Word-level timing requires a separate aligner."],
    abilities: { multilingual: qwenAsrLanguages, dialects: qwenDialects }
  },
  "asr-sensevoice-small": {
    usage: ["将音频转成文字，并对部分声音事件做标注，例如语音里出现笑声或掌声。RabiSpeech 对结果做文本后处理，可能把这些标记保留在转写文字中，当前不提供单独的事件时间轴。", "Transcribes audio and can annotate some sound events, such as laughter or applause. RabiSpeech postprocesses the text, which may retain event markers in the transcript. It exposes no separate event timeline."],
    abilities: {
      multilingual: ["当前 SenseVoiceSmall 权重的公开识别范围是普通话、粤语、英语、日语、韩语 5 种。知道录音语言时可手动选中，例如纯粤语访谈选粤语；短片段或多语言混说时建议回听核对。", "The released SenseVoiceSmall checkpoint covers five languages: Mandarin, Cantonese, English, Japanese, and Korean. Select the language when known, such as Cantonese for a Cantonese interview. Review short or mixed-language audio against the transcript."],
      audioEvents: ["官方模型同时识别语音情绪和部分音频事件。RabiSpeech 会把模型标记转成富文本转写结果，可见的哭笑、掌声等标记只反映模型判断。当前不会独立返回每类事件的置信度、起止时间或结构化列表。", "The model recognizes speech emotion and some sound events. RabiSpeech renders model tags in its rich transcript. Markers for laughter, crying, or applause reflect model predictions. The local output exposes no separate confidence values, event timing, or structured event list."]
    }
  },
  "asr-fireredasr2-aed": {
    usage: ["适用普通话、中文方言、英文及中英混说，也可转写含歌声的音频。RabiSpeech 会把输入转成 16 kHz WAV 后送入 AED 模型。需要字幕对齐时可启用词级时间戳。", "Handles Mandarin, Chinese dialects, English, Chinese–English code-switching, and singing. RabiSpeech converts input to 16 kHz WAV before calling AED. Enable word timestamps when aligning captions."],
    abilities: {
      dialects: ["官方覆盖普通话、20 多种中文方言或口音，以及英文和中英混说。适合用带地方口音的真实录音试转写，再核对姓名、地名与专用词。输出是转写文字，当前接入没有单独的方言分类字段。", "The project reports Mandarin, more than 20 Chinese dialects or accents, English, and Chinese–English code-switching. Check names, places, and technical terms on real audio. This integration produces text without a separate dialect classification field."],
      singing: ["可尝试把录音中的歌词转成文字，适合做字幕草稿。伴奏、重叠人声和拉长的唱腔会影响结果。输出不包含分离后的人声、音符或曲谱。", "Can turn sung words into a draft transcript for captions. Accompaniment, overlapping vocals, and elongated notes affect accuracy. It outputs text without isolated vocals, notes, or sheet music."],
      timestamps: ["打开词级时间戳后，RabiSpeech 会返回模型给出的词或字及起止秒数，便于定位录音和对齐字幕。未开启时仍返回整段文本和区间。时间点是模型估计，剪辑对齐时需要检查边界。", "When word timestamps are requested, RabiSpeech returns the model's spoken units and their start and end times in seconds. Otherwise it returns the transcript and segment interval. Timing is estimated, so review the cuts when aligning audio or captions."]
    }
  },
  "speaker-eres2netv2-zh": {
    usage: speakerInput,
    abilities: { speakerFeatures: speakerInput, speakerGroups: ["在 RabiSpeech 的聚类流程里，可以先对不同语音片段提取特征，再把相近片段归到一个未知说话人。重叠讲话、噪声和不同麦克风可能把同一个人拆成两组，也可能把音色相近的人合并。需要实名时仍要单独确认。", "RabiSpeech can group similar embeddings from separate clips into an unknown speaker. Crosstalk, noise, and different microphones can split the same person or merge similar voices. Confirm names separately when they matter."] }
  },
  "speaker-campplus-zh": {
    usage: ["中文 16 kHz CAM++ 说话人模型。可对两段单人语音提取特征做相似度比较，适合作为 ERes2NetV2 的备选。比较时应使用同一个模型生成的向量。", "CAM++ targets Chinese single-speaker audio at 16 kHz. It extracts vectors for similarity comparison and is an alternative to ERes2NetV2. Use embeddings produced by the same model on both sides of a comparison."],
    abilities: { speakerFeatures: speakerInput }
  }
};
