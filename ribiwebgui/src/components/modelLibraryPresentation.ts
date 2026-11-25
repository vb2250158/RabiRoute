import type { SpeechManagedModel } from "@shared/speechModelManagement";
import { speechModelDetails } from "./speechModelLibraryDetails";

export type ModelLibraryCapability = { id: string; label: string; description: string; detail?: string; icon?: string; sourceUrl?: string };
export type ModelLibraryLabels = { modelLibrary: string; model: string; capability: string; size: string; runtime: string; source: string; action: string; empty: string; close: string };
export type ModelLibraryRow = {
  id: string;
  name: string;
  abilities: ModelLibraryCapability[];
  size: string;
  runtime: string;
  runtimeIcon: string;
  sourceUrl?: string;
  error?: string;
};

type BilingualAbility = { zh: string; en: string; zhDescription: string; enDescription: string };
const capabilities = {
  multilingual: { zh: "多语言", en: "Multilingual", zhDescription: "同一模型支持多种语言，具体语言见模型的官方说明。", enDescription: "The same model supports multiple languages. See its documentation for the supported languages." },
  voiceClone: { zh: "音色复刻", en: "Voice cloning", zhDescription: "用参考语音复现音色，再合成新的文本。", enDescription: "Use reference speech to reproduce its voice when synthesizing new text." },
  shortReference: { zh: "少样本复刻", en: "Short voice reference", zhDescription: "使用约 3–10 秒的参考音频复刻说话人的音色。", enDescription: "Clone a speaker's voice from approximately 3–10 seconds of reference audio." },
  lightweight: { zh: "轻量", en: "Lightweight", zhDescription: "适用于资源有限的设备或快速验证，实际性能取决于设备。", enDescription: "Designed for limited hardware or quick validation. Performance depends on the device." },
  instructions: { zh: "指令控制", en: "Instruction control", zhDescription: "可用文本指令指定合成语音的表达方式。", enDescription: "Use text instructions to guide the delivery of synthesized speech." },
  streaming: { zh: "流式合成（未接入）", en: "Streaming (not integrated)", zhDescription: "官方提供流式接口，当前本地接入一次返回完整音频。", enDescription: "Upstream offers streaming. The current local integration returns complete audio." },
  emotion: { zh: "情绪控制", en: "Emotion control", zhDescription: "生成语音时可控制情绪表达。", enDescription: "Guide emotional expression when synthesizing speech." },
  duration: { zh: "时长控制（未开放）", en: "Duration control (unavailable)", zhDescription: "当前公开推理未启用精确时长控制。", enDescription: "Exact duration control is disabled in the public inference release." },
  dialects: { zh: "方言识别", en: "Dialect recognition", zhDescription: "可识别模型支持的方言，覆盖范围见官方说明。", enDescription: "Recognize supported dialects. The model documentation lists coverage." },
  audioEvents: { zh: "情绪与音频事件", en: "Emotion and audio events", zhDescription: "除文字外，模型可检测情绪和部分音频事件。", enDescription: "In addition to text, the model can detect emotion and some audio events." },
  timestamps: { zh: "时间戳", en: "Timestamps", zhDescription: "在转写内容中返回音频内的时间位置。", enDescription: "Return positions within the audio alongside the transcript." },
  singing: { zh: "歌声识别", en: "Singing recognition", zhDescription: "可识别含歌声的输入音频。", enDescription: "Recognize input audio containing singing." },
  speakerFeatures: { zh: "说话人特征", en: "Speaker embeddings", zhDescription: "从语音提取说话人特征，可用于比较不同音频中的声音。", enDescription: "Extract speaker features for comparing voices across recordings." },
  speakerGroups: { zh: "声音聚类", en: "Speaker clustering", zhDescription: "可将未知声音按说话人特征分组，分组结果不代表实名身份。", enDescription: "Group unknown voices by similarity without assigning a real-world identity." },
  textImage: { zh: "文生图", en: "Text to image", zhDescription: "在工作台输入文字、选择画幅和尺寸，生成 PNG。Z-Image Turbo 擅长写实画面和中英文画面文字，生成的字仍需校对。当前接入支持 256–2048 像素，宽高各为 32 的倍数。可写明主体、构图和光线，例如「偏暖的窗边光，一只白猫在书架旁」。此入口只接收文字提示。", enDescription: "Enter a prompt and an aspect ratio in the Workbench to generate a PNG. Z-Image Turbo is designed for photorealistic images and Chinese or English lettering. Check generated lettering before reuse. Each side can be 256–2048 pixels in multiples of 32. Describe the subject, composition, and lighting. This entry accepts text prompts." },
  textVideo: { zh: "文生视频", en: "Text to video", zhDescription: "MiniMax H3 FL2VA 可只用文字生成短片，无需上传首尾帧。提示可依次写主体、动作和镜头，例如「橘猫跳上窗台，镜头缓慢靠近」。工作台输出 24 FPS，提供约 0.92–10.83 秒的时长档位。宽高按 32 像素对齐，面积上限 1,032,192 像素。", enDescription: "MiniMax H3 FL2VA creates a short clip from text alone. Describe the subject, action, and camera movement, such as an orange cat jumping onto a sill while the camera pushes in. The Workbench offers about 0.92–10.83 seconds at 24 FPS. Dimensions align to multiples of 32 pixels, with an area cap of 1,032,192 pixels." },
  frames: { zh: "首尾帧", en: "First and last frames", zhDescription: "可以上传一张首帧、一张尾帧，或两张都上传，再用文字描述中间的动作和镜头。每张需为 PNG，最多 9 MB、4096×4096。当前工作流等比缩放并居中补边以适配输出尺寸，保留原图。首尾帧入口与多模态参考入口分开使用。", enDescription: "Upload a first frame, a last frame, or both, then describe the motion between them. Each input must be a PNG up to 9 MB and 4096×4096. The workflow scales and pads it to the output frame without overwriting the source. Use the separate reference workflow for multimodal input." },
  references: { zh: "图／视频／音频参考", en: "Image, video and audio references", zhDescription: "MiniMax H3 Ref2VA 可在提示里用 <Picture 1>、<Video 1>、<Audio 1> 引用素材。最多 9 张 PNG（每张 9 MB、4096×4096），3 段 H.264 MP4（每段 64 MB、2–15 秒、24 FPS、最大 1080p），3 段 WAV（每段 16 MB、最长 15 秒）。素材用于引导生成，原音复现和口型同步需检查。", enDescription: "In MiniMax H3 Ref2VA use <Picture 1>, <Video 1>, and <Audio 1> to reference assets in the prompt. Limits are 9 PNGs (9 MB and 4096×4096 each), 3 H.264 MP4 clips (64 MB each, 2–15 seconds, 24 FPS, up to 1080p), and 3 WAV clips (16 MB and 15 seconds each). References guide generation. Check any voice matching and lip sync in the output." },
  generatedAudio: { zh: "生成音频", en: "Generate audio", zhDescription: "在支持的 MiniMax H3 工作流中勾选生成音频，模型会随画面合成一条音轨，适合尝试场景音和与画面配合的声音。需要音频 VAE 权重。生成音轨应试听核对，涉及对白、指定声线或口型时尤其如此。原生画幅 4 步预览只出画面。", enDescription: "Enable audio on a compatible MiniMax H3 workflow to produce a soundtrack alongside the video. It requires the audio VAE and can be used for scene sounds or audio that follows the action. Review the soundtrack, especially dialogue, voice matching, or lip sync. The 4-step native-size preview produces video only." },
} satisfies Record<string, BilingualAbility>;

type AbilityId = keyof typeof capabilities;
const speechFeatures: Record<string, AbilityId[]> = {
  "tts-qwen3-0.6b": ["voiceClone", "multilingual", "lightweight"],
  "tts-qwen3-1.7b": ["voiceClone", "multilingual"],
  "tts-cosyvoice3-0.5b": ["multilingual", "instructions", "streaming"],
  "tts-gpt-sovits": ["shortReference"],
  "tts-indextts2": ["voiceClone", "emotion", "duration"],
  "asr-whisper-tiny": ["lightweight"],
  "asr-whisper-small": ["multilingual"],
  "asr-whisper-large-v3-turbo": ["multilingual"],
  "asr-qwen3-0.6b": ["multilingual", "dialects"],
  "asr-qwen3-1.7b": ["multilingual", "dialects"],
  "asr-sensevoice-small": ["multilingual", "audioEvents"],
  "asr-fireredasr2-aed": ["dialects", "singing", "timestamps"],
  "speaker-eres2netv2-zh": ["speakerFeatures", "speakerGroups"],
  "speaker-campplus-zh": ["speakerFeatures"],
};

function ability(id: AbilityId, english: boolean): ModelLibraryCapability {
  const copy = capabilities[id];
  return { id, label: english ? copy.en : copy.zh, description: english ? copy.enDescription : copy.zhDescription };
}

export function speechLibraryAbilities(model: SpeechManagedModel, label: string, icon: string, english: boolean) {
  const details = speechModelDetails[model.alias];
  const language = english ? 1 : 0;
  // The speaker catalog points to an ONNX download. The help dialog should open the author's documentation.
  const sourceUrl = model.alias === "speaker-eres2netv2-zh" || model.alias === "speaker-campplus-zh"
    ? "https://github.com/modelscope/3D-Speaker" : model.sourceUrl;
  return [{ id: model.capability, label, icon, sourceUrl, description: details?.usage[language] ?? (english ? model.purposeEn : model.purposeZh) },
    ...(speechFeatures[model.alias] ?? []).map(id => {
      const feature = ability(id, english);
      return { ...feature, sourceUrl, description: details?.abilities[id]?.[language] ?? feature.description };
    })];
}

export type MediaModelCatalogEntry = {
  id: string;
  mode?: string;
  steps?: number;
  files?: { audioVae?: string };
  workflowSource?: string;
  downloadBase?: string;
  workflows?: Record<string, { steps: number; kind?: string; conditions?: { minShortEdge?: number; generateAudio?: boolean } }>;
};
export type MediaWorkflow = { id: string; label: string; installed: boolean; missingFiles: string[] };
export type MediaModelFile = { name: string; installed: boolean; state: string };

export function mediaLibraryAbilities(model: MediaModelCatalogEntry, workflows: MediaWorkflow[], files: MediaModelFile[], english: boolean) {
  const ids: AbilityId[] = model.mode === "image" ? ["textImage"] : model.mode === "frames" ? ["textVideo", "frames"] : model.mode === "reference" ? ["references"] : [];
  if (model.files?.audioVae) ids.push("generatedAudio");
  const sourceUrl = model.id === "z-image-turbo" ? "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo" : mediaLibrarySource(model);
  const result = ids.map(id => ({ ...ability(id, english), sourceUrl }));
  const invalid = new Set(files.filter(file => file.state === "invalid").map(file => file.name));
  const fileDetails = (names: string[]) => names.map(name => invalid.has(name) ?
    `${name} (${english ? "invalid or wrong size" : "损坏或大小不符"})` : name).join(english ? ", " : "、");
  if (model.mode === "image" && result[0]) {
    const missing = files.filter(file => !file.installed).map(file => file.name);
    const installed = missing.length ? `${english ? "Files to download: " : "待下载文件："}${fileDetails(missing)}` : "";
    const steps = model.steps ? (english ? `${model.steps} sampling steps.` : `采样 ${model.steps} 步。`) : "";
    result[0].detail = [steps, installed].filter(Boolean).join(" ");
  }
  const references = result.find(item => item.id === "references");
  if (references) references.detail = english
    ? "Use original audio controls whether an uploaded video's soundtrack is included as input. Generate audio separately controls whether the result includes a generated soundtrack."
    : "「使用视频原声」决定是否把参考视频的原声送入模型。「生成音频」另行控制输出视频是否带生成音轨。";
  const audio = result.find(item => item.id === "generatedAudio");
  if (audio) {
    const audioVae = files.find(file => file.name === model.files?.audioVae);
    const requirement = model.mode === "reference"
      ? (english ? "Ref2VA uses the audio VAE in its reference input node, even with soundtrack generation off." : "Ref2VA 的参考输入节点需要音频 VAE，关闭输出音轨后仍要安装。")
      : (english ? "FL2VA needs the audio VAE only when generating a soundtrack. Silent text or frame generation can run without it." : "FL2VA 只有在生成音轨时才需要音频 VAE。无声的文生视频和首尾帧工作流可以省掉这一项。");
    const status = audioVae && (audioVae.installed ? (english ? "Audio VAE file is present." : "音频 VAE 文件已到位。")
      : `${english ? "Audio VAE to download: " : "待下载的音频 VAE："}${fileDetails([audioVae.name])}`);
    audio.detail = [requirement, status].filter(Boolean).join("\n");
  }
  for (const workflow of workflows) {
    const profile = model.workflows?.[workflow.id];
    const mode = model.mode === "reference"
      ? (english ? "Ref2VA accepts image, video, or audio references." : "这条路线使用 Ref2VA，可输入图片、视频或音频参考。")
      : (english ? "FL2VA accepts text and optional first or last frames." : "这条路线使用 FL2VA，可只输入文字，也可提供首帧或尾帧。");
    const use = profile?.conditions?.minShortEdge
      ? (english ? "Workbench quick generation prefers this profile when the short-edge and audio settings match and its LoRA is available. Otherwise FL2VA can use its compatible fast profile." : "工作台的快速生成在短边、音频选项都符合条件且 LoRA 文件齐全时优先选用此配置。条件不符或缺少该 LoRA 时可走 FL2VA 的兼容快速配置。")
      : profile?.kind === "fast"
      ? (english ? "Uses acceleration weights to try a prompt, reference, or camera move with fewer sampling steps. Compare on the same prompt and dimensions before using the result." : "用加速权重减少采样步数，适合先试提示词、参考素材和镜头。可以固定提示词和尺寸，再与标准工作流对照效果。")
      : (english ? "Runs without the Turbo LoRA and uses the base model, text encoder, and video VAE. Compare it with the quick preview on the same inputs." : "使用底模、文本编码器和视频 VAE，无需 Turbo LoRA。可以固定输入和尺寸，与快速预览对照画面细节。");
    const description = profile ? `${english ? `${profile.steps} sampling steps. ` : `采样 ${profile.steps} 步。`}${mode}\n${use}` : mode;
    const conditions = [
      profile?.conditions?.minShortEdge && (english ? `Shortest edge at least ${profile.conditions.minShortEdge}px.` : `短边至少 ${profile.conditions.minShortEdge} 像素。`),
      profile?.conditions?.generateAudio === false && (english ? "Video only." : "仅生成画面。"),
    ].filter(Boolean).join(" ");
    const readiness = workflow.installed ? (english ? "Base workflow files are present." : "基础工作流文件已齐全。") :
      `${english ? "Files to download: " : "待下载文件："}${fileDetails(workflow.missingFiles)}`;
    const extraAudio = model.mode === "frames" && model.files?.audioVae && profile?.conditions?.generateAudio !== false
      ? (english ? "For sound output, also check the audio VAE listed under Generate audio." : "输出音轨还需检查「生成音频」标签里的音频 VAE。") : "";
    result.push({ id: `workflow:${workflow.id}`, label: english && profile ? `${profile.kind === "fast" ? "Fast" : "Standard"} · ${profile.steps} steps` : workflow.label,
      description: [description, conditions].filter(Boolean).join("\n"), detail: [readiness, extraAudio].filter(Boolean).join("\n"), sourceUrl });
  }
  return result;
}

export function mediaLibrarySource(model: MediaModelCatalogEntry) {
  const source = model.workflowSource || model.downloadBase?.split("/resolve/")[0];
  return source?.startsWith("https://") ? source : undefined;
}
