<script setup lang="ts">
import { browserUuid } from "../../../../../ribiwebgui/src/browserUuid";
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { wireBend } from "../../workbenchThumbnail.mjs";
import TtsModelParameters from "../../../../../ribiwebgui/src/components/TtsModelParameters.vue";
import {normalizeTtsParameters,ttsCommandSettings,type TtsParameters} from "../../../io.rabiroute.manager.speech/web/speech/ttsParameters";
import AudioPromptEditor from "../components/AudioPromptEditor.vue";
import { synthesizeWithPauses } from "../../../io.rabiroute.manager.speech/web/speech/audioPause";
import { createSpeechControlClient } from "../../../io.rabiroute.manager.speech/web/speech/speechControlClient";
import type { SpeechModel } from "@shared/speechControlContract";
import { readDraft, restoreMediaComputeSelection, writeDraft, type DraftRecord } from "./videoDraftStorage";
import { useVideoCanvas, type NodeLayout } from "./useVideoCanvas";
import WorkbenchPanel from "./WorkbenchPanel.vue";
import WorkbenchCliSettings from "./WorkbenchCliSettings.vue";
import { wirePath, connectGraph, linkedText, connectWorkflowInput, workflowArtifactKeys, workflowInputLinks, workflowRunArtifacts, initialFlowNodeConfig, resolveEdgeKind as resolveDropEdgeKind, type CanvasCover, type CanvasPreview, type Point, type FlowNode, type TextPreview, type WorkbenchCanvas, type WorkbenchDefinition, type WorkbenchRunReceipt } from "./workbenchEditor";
import { cardBadges, mergedInputs, artifactKindGlyphs, type ArtifactKind, type MergedInput } from "./workbenchCardView";
function artifactGlyph(kind: ArtifactKind) { return artifactKindGlyphs[kind]; }
/** `@click` here feeds the action wrapper, which expects a promise. */
async function removeMergedInputAction(row: MergedInput, target: string) { await removeMergedInput(row, target); }
import { copiedNodeTitle, createCanvasClipboard, parseCanvasClipboard, pasteLayouts, type CanvasClipboard, type CanvasClipboardEntry } from "./canvasClipboard";
import { managerEventSource, managerResourceUrl } from "../../../../../ribiwebgui/src/managerApi";
import VideoGenerationProgress from "../components/VideoGenerationProgress.vue";
import MediaVideoPlayer from "../components/MediaVideoPlayer.vue";
import type { VideoProgressJob } from "./videoJobProgress";

import PeerServerSelect from "../../../../../ribiwebgui/src/components/PeerServerSelect.vue";
import ComputerModelPicker from "../../../../../ribiwebgui/src/components/ComputerModelPicker.vue";
import { createMediaServiceClient, MediaServiceChangedError } from "./mediaServiceClient";
import { previewAccessDenied, readPreview, writePreview } from "../../../../../ribiwebgui/src/readPreviewCache";
import { loadWorkbenchDefinition } from "./workbenchDefinition";
import { peerManagerPath } from "../../../../../ribiwebgui/src/peerManagerTarget";
const serviceDeviceId = ref("");
const mediaService = createMediaServiceClient(() => serviceDeviceId.value);
const speechControlClient = createSpeechControlClient((input, init) => mediaService.fetchManager(String(input), init));

type WorkflowProfile = { kind?: string; label: string; steps: number };
type Model = { workflows?: Record<string, WorkflowProfile>; defaultWorkflow?: string; id: string; label: string; mode?: string; fps: number; width: number; height: number; frames: number };
type AssetKind = "image" | "video" | "audio";
type Asset = { id: string; kind: AssetKind; width?: number; height?: number; duration?: number; hasAudio?: boolean };
type Job = VideoProgressJob & { quickGeneration?: boolean; workflowId?: string; samplingSteps?: number; id: string; prompt: string; model?: string; width?: number; height?: number; frames?: number; seed?: number; references?: string[]; generateAudio?: boolean; referenceVideoSound?: boolean; hasFirstFrame?: boolean; hasLastFrame?: boolean; progress: number; error?: string; videoUrl?: string; imageUrl?: string; mediaKind?: string };
type Snapshot = { computeError?: string; availableWorkflows?: { model: string; workflowId: string; generateAudio: boolean }[]; online: boolean; availableModels?: string[]; models: Model[]; states: Record<string, { label: string; terminal: boolean }>; jobs: Job[] };
const snapshot = ref<Snapshot>();
const showLibrary = ref(false);
const error = ref("");
const busy = ref(false);
const prompt = ref("");
const model = ref("");
const width = ref(768), height = ref(768), frames = ref(107), seed = ref(1);
const firstFrame = ref(""), lastFrame = ref("");
const firstName = ref(""), lastName = ref("");
const mode = ref("text"), filter = ref("all"), search = ref(""), selectedId = ref("");
const notice = ref("");
const noticeVisible = computed({ get: () => !!notice.value, set: value => { if (!value) notice.value = ""; } });
const references = ref<Asset[]>([]), uploading = ref(false);
const quickGeneration = ref(false);
const generateAudio = ref(false), referenceVideoSound = ref(false);
const referenceKinds: { id: AssetKind; label: string; icon: string; accept: string; limit: number; bytes: number }[] = [
  { id: "image", label: "图片", icon: "mdi-image-outline", accept: "image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif", limit: 9, bytes: 9 * 1024 ** 2 },
  { id: "video", label: "视频", icon: "mdi-video-outline", accept: "video/mp4", limit: 3, bytes: 64 * 1024 ** 2 },
  { id: "audio", label: "音频", icon: "mdi-music-note-outline", accept: ".wav", limit: 3, bytes: 16 * 1024 ** 2 },
];
function videoModels(models: Model[]) {
  return models.filter(item => item.mode !== "image" && (item.mode === "reference") === (mode.value === "reference"));
}
const availableModels = computed(() => videoModels(snapshot.value?.models || []));
const selectedWorkflow = computed(() => snapshot.value?.models.find(item => item.id === model.value)?.workflows?.[quickGeneration.value ? "fast" : "standard"]);
const workflowProblem = computed(() => {
  if (!snapshot.value?.models.find(item => item.id === model.value)?.workflows) return "请更新视频服务以使用标准／快速工作流。";
  if (snapshot.value.online && !snapshot.value.availableWorkflows?.some(item => item.model === model.value && (snapshot.value?.models.find(row => row.id === model.value)?.workflows?.[item.workflowId]?.kind || item.workflowId) === (quickGeneration.value ? "fast" : "standard") && item.generateAudio === generateAudio.value)) return "当前工作流或声音依赖未就绪，请前往「模型服务 → 视频生成模型」检查。";
  return "";
});
function setMode(value: string) {
  mode.value = value;
  if (!availableModels.value.some(item => item.id === model.value)) model.value = availableModels.value[0]?.id || "";
}
function cryptoSeed() { return crypto.getRandomValues(new Uint32Array(1))[0]!; }
function swapFrames() {
  [firstFrame.value, lastFrame.value] = [lastFrame.value, firstFrame.value];
  [firstName.value, lastName.value] = [lastName.value, firstName.value];
  [frameShapes.value.first, frameShapes.value.last] = [frameShapes.value.last!, frameShapes.value.first!];
}
function referenceLabel(asset: Asset) {
  const position = references.value.filter(item => item.kind === asset.kind).findIndex(item => item.id === asset.id) + 1;
  const audioOffset = asset.kind === "audio" && referenceVideoSound.value ? references.value.filter(item => item.kind === "video" && item.hasAudio).length : 0;
  return `<${{ image: "Picture", video: "Video", audio: "Audio" }[asset.kind]} ${position + audioOffset}>`;
}
function changeReferences(change: () => void) {
  const before = referenceTags();
  change();
  const after = new Map([...referenceTags()].map(([tag,id]) => [id,tag]));
  prompt.value = prompt.value.replace(/<(?:Picture|Video|Audio) \d+>/g, tag => before.has(tag) ? after.get(before.get(tag)!) || "" : tag);
}
function videoSoundLabel(asset: Asset) {
  return `<Audio ${references.value.filter(item => item.kind === "video" && item.hasAudio).findIndex(item => item.id === asset.id) + 1}>`;
}
function referenceTags() {
  const result = new Map(references.value.map(asset => [referenceLabel(asset),asset.id]));
  if (referenceVideoSound.value) for (const asset of references.value.filter(item => item.kind === "video" && item.hasAudio)) result.set(videoSoundLabel(asset),`${asset.id}:sound`);
  return result;
}
function removeReference(index: number) { changeReferences(() => references.value.splice(index, 1)); }
function setVideoSound(value: boolean | null) { changeReferences(() => { referenceVideoSound.value = !!value; }); }
async function uploadReferences(event: Event, kind: AssetKind) {
  const input = event.target as HTMLInputElement, files = Array.from(input.files || []); input.value = "";
  if (!files.length || uploading.value) return;
  const rule = referenceKinds.find(item => item.id === kind)!;
  if (references.value.filter(item => item.kind === kind).length + files.length > rule.limit) { error.value = `${rule.label}最多 ${rule.limit} 个。`; return; }
  if (files.some(file => file.size > rule.bytes)) { error.value = `${rule.label}每个文件最大 ${rule.bytes / 1024 ** 2} MB。`; return; }
  uploading.value = true; error.value = "";
  try {
    for (const file of files) {
      const asset = await request<Asset>(`/assets?kind=${kind}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
      changeReferences(() => references.value.push(asset));
    }
  } catch (failure) { error.value = failure instanceof Error ? failure.message : "素材上传失败。"; }
  finally { uploading.value = false; }
}
const frameShapes = ref<Record<string, string>>({});
const ratios = [
  { label: "16:9", width: 1024, height: 576 },
  { label: "4:3", width: 896, height: 672 },
  { label: "1:1", width: 768, height: 768 },
  { label: "3:4", width: 672, height: 896 },
  { label: "9:16", width: 576, height: 1024 },
  { label: "21:9", width: 1120, height: 480 },
];
const resolutions = [{ label: "480P", edge: 480 }, { label: "720P", edge: 720 }];
function resolutionSize(ratio: number, edge: number) {
  return { width: Math.round(edge * Math.max(1, ratio) / 32) * 32, height: Math.round(edge * Math.max(1, 1 / ratio) / 32) * 32 };
}
const selectedRatio = computed(() => ratios.find(item => Math.abs((width.value / height.value) / (item.width / item.height) - 1) < 0.025));
const selectedResolution = computed(() => resolutions.find(item => {
  const ratio = selectedRatio.value;
  if (!ratio) return false;
  const size = resolutionSize(ratio.width / ratio.height, item.edge);
  return size.width === width.value && size.height === height.value;
}));
function resolutionAllowed(edge: number) {
  const ratio = selectedRatio.value;
  const size = resolutionSize(ratio ? ratio.width / ratio.height : width.value / height.value, edge);
  return size.width * size.height <= 1032192;
}
function applyResolution(edge: number) {
  if (!resolutionAllowed(edge)) return;
  const ratio = selectedRatio.value;
  const size = resolutionSize(ratio ? ratio.width / ratio.height : width.value / height.value, edge);
  width.value = size.width; height.value = size.height;
}
function applyRatio(ratio: typeof ratios[number]) {
  const resolution = selectedResolution.value;
  const size = resolution ? resolutionSize(ratio.width / ratio.height, resolution.edge) : ratio;
  if (size.width * size.height > 1032192) {
    notice.value = "此画幅在当前分辨率下超出像素上限，请先选择较低分辨率。";
    return;
  }
  width.value = size.width; height.value = size.height;
}
const filteredJobs = computed(() => (snapshot.value?.jobs || []).filter(job => (filter.value === "all" || (filter.value === "pending" ? !snapshot.value?.states[job.status]?.terminal : job.status === filter.value)) && job.prompt.toLowerCase().includes((search.value || "").trim().toLowerCase())));
const canvas = useVideoCanvas(id => {
  const node = flowNodesById.value.get(id);
  return node && node.config.textOutput !== true ? 76 : 214;
});
const minimapOpen = ref(true);
const minimap = canvas.minimap;
const selectedIds = canvas.selectedIds;
const minimapShapes = computed(() => {
  if (!minimapOpen.value) return { selected: "", unselected: "" };
  const selected = new Set(selectedIds.value);
  const paths = { selected: [] as string[], unselected: [] as string[] };
  for (const card of minimap.value.cards) {
    const bucket = selected.has(card.id) ? paths.selected : paths.unselected;
    bucket.push(`M${card.x.toFixed(2)} ${card.y.toFixed(2)}h${card.width.toFixed(2)}v${card.height.toFixed(2)}h${(-card.width).toFixed(2)}z`);
  }
  return { selected: paths.selected.join(""), unselected: paths.unselected.join("") };
});
const marquee = canvas.marquee;
let minimapGesture: { pointer: number; map: typeof minimap.value; x: number; y: number } | undefined;
function minimapPoint(event: PointerEvent) {
  const matrix = (event.currentTarget as SVGSVGElement).getScreenCTM();
  return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : undefined;
}
function beginMinimap(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  const point = minimapPoint(event);
  if (!point) return;
  event.preventDefault();
  const map = minimap.value, { view } = map;
  const inside = point.x >= view.x && point.x <= view.x + view.width && point.y >= view.y && point.y <= view.y + view.height;
  minimapGesture = { pointer: event.pointerId, map, x: inside ? point.x - view.x - view.width / 2 : 0, y: inside ? point.y - view.y - view.height / 2 : 0 };
  (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  if (!inside) moveMinimap(event);
}
function moveMinimap(event: PointerEvent) {
  const gesture = minimapGesture;
  if (!gesture || gesture.pointer !== event.pointerId) return;
  const point = minimapPoint(event);
  if (point) canvas.locateMinimap(point.x - gesture.x, point.y - gesture.y, gesture.map);
}
function endMinimap(event: PointerEvent) {
  if (minimapGesture?.pointer !== event.pointerId) return;
  if (event.type === "pointerup") moveMinimap(event);
  minimapGesture = undefined;
}
const { viewport, scale, handMode, canPan, dragging, canUndo, canRedo, transform: canvasTransform, grid: canvasGrid } = canvas;
type CanvasKind = "video" | "image" | "audio" | "text";
type CanvasItem = { id: string; kind: CanvasKind; title: string; jobId?: string; asset?: Asset; text: string; imageModel?: string; imageSize?: string; imageTier?: string; imageKey?: string; imageBody?: string; imageComputeDeviceId?: string; audioMode?: "generate" | "reference"; audioModel?: string; audioParameters?: TtsParameters; audioSettingsOpen?: boolean; audioVoiceMode?: "default" | "custom"; audioVoice?: string; audioSpeed?: number; audioUrl?: string; audioError?: string; audioBusy?: boolean };
const canvasItems = ref<CanvasItem[]>([{ id: "draft-1", kind: "video", title: "视频 1", text: "" }]);
const activeVideoId = ref("draft-1");
const selectedCanvasId = ref("draft-1");
const storedMediaSelection = ref(["draft-1"]);
watch(selectedIds, ids => {
  const visible = new Set(canvasItems.value.map(item => item.id));
  const media = ids.filter(id => visible.has(id));
  if (!ids.length || media.length) storedMediaSelection.value = media;
});
canvas.add("draft-1");
const activeVideo = computed(() => canvasItems.value.find(item => item.id === activeVideoId.value));
const otherItems = computed(() => canvasItems.value.filter(item => item.id !== activeVideoId.value));
const visibleMediaItems = computed(() => otherItems.value.filter(item => canvas.visibleCardIds.value.has(item.id)));
const selected = computed(() => snapshot.value?.jobs.find(job => job.id === activeVideo.value?.jobId));
const openPopover = ref("");
function updatePopover(key: string, opened: boolean) {
  if (opened) openPopover.value = key;
  else if (openPopover.value === key) openPopover.value = "";
}
function dismissCanvasPopovers(event: PointerEvent) {
  canvas.clearDragClick();
  const target = event.target as Element;
  if (!target.closest(".canvas-group")) selectedGroupId.value = undefined;
  if (target.closest(".canvas-object,.canvas-tools,.workspace-tools,.canvas-minimap,.canvas-menu,.output-library,.v-overlay")) return;
  openPopover.value = "";
  contextMenu.value = undefined;
}
const contextMenu = ref<{ x: number; y: number; world?: { x: number; y: number }; itemId?: string }>();
const canvasKinds: { kind: CanvasKind; label: string; icon: string }[] = [
  { kind: "text", label: "文本", icon: "mdi-format-text" },
  { kind: "image", label: "图片", icon: "mdi-image-outline" },
  { kind: "video", label: "视频", icon: "mdi-video-outline" },
  { kind: "audio", label: "音频", icon: "mdi-music-note-outline" },
];
// 文本改由可生成的文本节点承担，菜单不再提供纯文本卡片；旧画布里的文本卡片仍照原样显示。
const mediaCanvasKinds = canvasKinds.filter(entry => entry.kind !== "text");
function captureDraft() {
  return { prompt: prompt.value, model: model.value, mode: mode.value, width: width.value, height: height.value, frames: frames.value, seed: seed.value, firstFrame: firstFrame.value, lastFrame: lastFrame.value, firstName: firstName.value, lastName: lastName.value, shapes: { ...frameShapes.value }, references: [...references.value], quickGeneration: quickGeneration.value, generateAudio: generateAudio.value, referenceVideoSound: referenceVideoSound.value };
}
const drafts = new Map<string, ReturnType<typeof captureDraft>>();
function selectCanvasVideo(item: CanvasItem) {
  if (item.kind !== "video" || busy.value || uploading.value || activeVideoId.value === item.id) return;
  drafts.set(activeVideoId.value, captureDraft());
  activeVideoId.value = item.id;
  const draft = drafts.get(item.id);
  prompt.value = draft?.prompt || ""; mode.value = draft?.mode || "text";
  model.value = draft?.model || availableModels.value[0]?.id || "";
  width.value = draft?.width ?? 768; height.value = draft?.height ?? 768;
  frames.value = draft?.frames ?? 107; seed.value = draft?.seed ?? cryptoSeed();
  firstFrame.value = draft?.firstFrame || ""; lastFrame.value = draft?.lastFrame || "";
  firstName.value = draft?.firstName || ""; lastName.value = draft?.lastName || "";
  frameShapes.value = { ...draft?.shapes }; references.value = [...(draft?.references || [])];
  quickGeneration.value = draft?.quickGeneration ?? false;
  generateAudio.value = !!draft?.generateAudio; referenceVideoSound.value = !!draft?.referenceVideoSound;
  error.value = "";
}
function appendCardText(item: CanvasItem) {
  if (!activeVideo.value) return;
  prompt.value += (prompt.value ? "\n" : "") + item.text;
  selectCard(activeVideo.value);
  canvas.center(activeVideoId.value);
}
function selectCard(item: CanvasItem) {
  if (item.kind === "audio" && !audioModels.value.length) void loadAudioModels();
  openPopover.value = "";
  selectedCanvasId.value = item.id;
  selectedIds.value = [item.id];
  selectCanvasVideo(item);
}
function nodePointerDown(event: PointerEvent, id: string, select: () => void) {
  if (event.isPrimary === false || (event.button !== 0 && event.button !== 1)) return;
  const target = event.target as Element;
  if (target.closest(".composer,input,textarea,select,summary,label,a,audio[controls],video[controls],[contenteditable=true],button:not(.canvas-drag-handle)")) return;
  if (workflowWire.value?.pointer !== undefined) return;
  event.stopPropagation();
  cancelPort();
  contextMenu.value = undefined;
  openPopover.value = "";
  canvas.begin(event, id, select);
}
function cardPointerDown(event: PointerEvent, item: CanvasItem) {
  nodePointerDown(event, item.id, () => selectCard(item));
}
function openCanvasMenu(event: MouseEvent) {
  if ((event.target as HTMLElement).closest("input,textarea,video,audio,.v-overlay")) return;
  event.preventDefault();
  openPopover.value = "";
  const element = viewport.value;
  if (!element) return;
  const bounds = element.getBoundingClientRect();
  const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  contextMenu.value = { x: Math.max(8, Math.min(point.x, element.clientWidth - 210)), y: Math.max(8, Math.min(point.y, element.clientHeight - 450)), world: (event.target as HTMLElement).closest(".workspace-tools") ? undefined : canvas.world(point) };
}
function openCardMenu(event: MouseEvent, item: CanvasItem) {
  if ((event.target as HTMLElement).closest("input,textarea,.composer")) return;
  event.stopPropagation(); openCanvasMenu(event);
  if (contextMenu.value) contextMenu.value.itemId = item.id;
}
function duplicateCard(empty: boolean) {
  if (busy.value || uploading.value) return;
  const source = canvasItems.value.find(row => row.id === contextMenu.value?.itemId);
  if (!source) return;
  const item: CanvasItem = { ...source, id: browserUuid(), title: `${source.title} 副本`, ...(empty ? { text: "", asset: undefined, jobId: undefined, audioUrl: undefined, audioError: undefined, audioBusy: false } : {}) };
  const draft = source.id === activeVideoId.value ? captureDraft() : drafts.get(source.id);
  if (!empty && draft) drafts.set(item.id, JSON.parse(JSON.stringify(draft)));
  canvasItems.value.push(item); canvas.add(item.id);
  const origin = canvas.positions.value[source.id]!;
  canvas.positions.value[item.id] = { ...origin, x: origin.x + 60, y: origin.y + 60 };
  contextMenu.value = undefined; selectCard(item);
}
function deleteCard() {
  if (busy.value || uploading.value) return;
  const id = contextMenu.value?.itemId;
  if (!id) return;
  if (id === activeVideoId.value) {
    let next = canvasItems.value.find(row => row.kind === "video" && row.id !== id);
    if (!next) {
      next = { id: browserUuid(), kind: "video", title: "视频 1", text: "" };
      canvasItems.value.push(next); canvas.add(next.id);
    }
    selectCard(next);
  }
  canvasItems.value = canvasItems.value.filter(row => row.id !== id);
  delete canvas.positions.value[id]; drafts.delete(id);
  selectedIds.value = selectedIds.value.filter(key => key !== id);
  contextMenu.value = undefined;
  notice.value = "已移除画布节点，作品历史和素材文件保留。";
}
function exportCard() {
  const item = canvasItems.value.find(row => row.id === contextMenu.value?.itemId);
  if (!item) return;
  const draft = item.id === activeVideoId.value ? captureDraft() : drafts.get(item.id);
  const data = { format: "rabi-video-node", version: 1, title: item.title, kind: item.kind, text: item.text, parameters: draft ? { prompt: draft.prompt, model: draft.model, mode: draft.mode, width: draft.width, height: draft.height, frames: draft.frames, seed: draft.seed, quickGeneration: draft.quickGeneration, generateAudio: draft.generateAudio, referenceVideoSound: draft.referenceVideoSound } : undefined };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "rabi-video-node.json"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  contextMenu.value = undefined; notice.value = "已导出节点参数，不包含参考素材和生成文件。";
}
function addCanvasItem(kind: CanvasKind) {
  if (busy.value || uploading.value) return;
  const count = canvasItems.value.filter(item => item.kind === kind).length + 1;
  const item: CanvasItem = { id: browserUuid(), kind, title: `${canvasKinds.find(entry => entry.kind === kind)!.label} ${count}`, text: "" };
  canvasItems.value.push(item); canvas.add(item.id);
  if (contextMenu.value?.world) canvas.positions.value[item.id] = contextMenu.value.world;
  contextMenu.value = undefined;
  selectCard(item);
  canvas.center(item.id);
}
function addJobToCanvas(job: Job) {
  if (busy.value || uploading.value) return;
  let item = canvasItems.value.find(row => row.jobId === job.id);
  if (!item) {
    item = { id: browserUuid(), kind: job.mediaKind === "image" ? "image" : "video", title: job.mediaKind === "image" ? "生成图片" : `视频 ${canvasItems.value.filter(row=>row.kind==='video').length + 1}`, text: job.prompt, jobId: job.id };
    canvasItems.value.push(item); canvas.add(item.id);
  }
  selectCard(item); showLibrary.value = false; canvas.center(item.id);
}
const imageModels = computed(() => (snapshot.value?.models || []).filter(row => row.mode === "image"));
const imageRatios = [{label:"1:1",w:1024,h:1024},{label:"4:3",w:1152,h:864},{label:"3:4",w:864,h:1152},{label:"16:9",w:1344,h:768},{label:"9:16",w:768,h:1344},{label:"3:2",w:1248,h:832},{label:"2:3",w:832,h:1248}];
function imageRatio(item: CanvasItem) {
  const [w,h]=(item.imageSize || "1024x1024").split("x").map(Number);
  return imageRatios.reduce((best,row)=>Math.abs(row.w/row.h-w!/h!)<Math.abs(best.w/best.h-w!/h!) ? row : best,imageRatios[0]!);
}
function imageQuality(item: CanvasItem) { if (item.imageTier) return item.imageTier; return Math.max(...(item.imageSize || "1024x1024").split("x").map(Number))>=2048 ? "2K" : "1K"; }
function setImageFormat(item: CanvasItem, ratio=imageRatio(item), quality=imageQuality(item)) {
  const factor=quality==="480P" ? 480/Math.min(ratio.w,ratio.h) : quality==="720P" ? 720/Math.min(ratio.w,ratio.h) : quality==="2K" ? 2048/Math.max(ratio.w,ratio.h) : 1;
  item.imageTier=quality;
  item.imageSize=`${Math.round(ratio.w*factor/32)*32}x${Math.round(ratio.h*factor/32)*32}`;
}

function imageJob(item: CanvasItem) { return snapshot.value?.jobs.find(row=>row.id===item.jobId); }
function imageSource(item: CanvasItem) { const url=imageJob(item)?.imageUrl; return url ? managerResourceUrl(url) : item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined; }
async function generateImage(item: CanvasItem) {
  const [w,h]=(item.imageSize || "1024x1024").split("x").map(Number);
  const body=JSON.stringify({model:item.imageModel || imageModels.value[0]?.id,prompt:mediaPrompt(item.id, item.text),width:w,height:h,seed:1});
  if (item.imageKey && item.imageComputeDeviceId !== serviceDeviceId.value) {
    throw new Error("上次图片提交结果未确认，请切回原机器核对任务记录。");
  }
  if (!item.imageKey || item.imageBody !== body) {
    item.imageKey = browserUuid();
    item.imageBody = body;
    item.imageComputeDeviceId = serviceDeviceId.value;
  }
  const job=await request<Job>("/jobs",{method:"POST",headers:{"content-type":"application/json","Idempotency-Key":item.imageKey!},body});
  item.jobId = job.id;
  item.imageKey = item.imageBody = item.imageComputeDeviceId = undefined;
  showSubmittedJob(job);
}
async function useGeneratedImage(item: CanvasItem) {
  const url=imageSource(item); if(!url)return;
  if(imageJob(item)?.imageUrl) {
    const response=await fetch(url); if(!response.ok)throw new Error("读取生成图片失败。");
    const blob=await response.blob(); if(blob.size>9*1024**2)throw new Error("图片超过参考素材 9 MB 上限。");
    item.asset=await request<Asset>("/assets?kind=image",{method:"POST",headers:{"content-type":"application/octet-stream"},body:blob});
  }
  useCanvasReference(item); if (activeVideo.value) selectCard(activeVideo.value);
}
const audioModels = ref<SpeechModel[]>([]);
const audioCatalogError = ref("");
const audioEditors = new Map<string, InstanceType<typeof AudioPromptEditor>>();
const audioInsertGroups = [
  {id:"pause",label:"停顿",items:[{label:"短停顿 0.5s",detail:"<#0.5#>",text:"<#0.5#>"},{label:"中停顿 1s",detail:"<#1#>",text:"<#1#>"},{label:"长停顿 2s",detail:"<#2#>",text:"<#2#>"}]},
  {id:"interjection",label:"语气词",items:[{label:"嗯",detail:"思考 / 应答",text:"<[嗯]>"},{label:"啊",detail:"感叹",text:"<[啊]>"},{label:"哦",detail:"回应",text:"<[哦]>"},{label:"唉",detail:"叹息",text:"<[唉]>"}]}
];
function insertAudioText(item: CanvasItem, text: string) {
  audioEditors.get(item.id)?.insert(text);
  openPopover.value="";
}
const generatedAudio = new Map<string, Blob>();
let audioCatalogFlight: Promise<void> | undefined;
let audioCatalogAt = 0;
function loadAudioModels() {
  if (audioCatalogFlight) return audioCatalogFlight;
  if (Date.now() - audioCatalogAt < 30_000) return Promise.resolve();
  const revision = mediaService.selectionRevision();
  const flight = speechControlClient.models({ signal: AbortSignal.timeout(10000) }).then(({ models }) => {
    if (disposed || revision !== mediaService.selectionRevision()) return;
    audioModels.value = models.filter(row => row.capability === "tts");
    audioCatalogAt = Date.now();
    audioCatalogError.value = "";
  }).catch(cause => {
    if (!disposed && revision === mediaService.selectionRevision() && !(cause instanceof MediaServiceChangedError)) {
      audioCatalogError.value = "所选电脑的 TTS 服务未就绪，请启用后刷新。";
    }
  }).finally(() => { if (audioCatalogFlight === flight) audioCatalogFlight = undefined; });
  audioCatalogFlight = flight;
  return flight;
}
function selectedAudioModel(item:CanvasItem){return audioModels.value.find(row=>row.id===item.audioModel) || (!item.audioModel ? audioModels.value.find(row=>row.available) : undefined);}
async function loadModelOptions(kind: "image" | "video" | "audio", deviceId: string, signal: AbortSignal) {
  const preview = createMediaServiceClient(() => deviceId);
  if (kind === "audio") {
    const speech = createSpeechControlClient((input, init) => preview.fetchManager(String(input), init));
    const models = deviceId === serviceDeviceId.value && Date.now() - audioCatalogAt < 30_000
      ? audioModels.value : (await speech.models({ signal })).models;
    return models.filter(row => row.capability === "tts").map(row => ({
      value: row.id, title: row.name, subtitle: `${row.note || row.family} · ${row.available ? "可用" : "未就绪"}`
    }));
  }
  const status = deviceId === serviceDeviceId.value && !refreshFlight &&
    !statusError.value && Date.now() - snapshotAt < 10_000 ? snapshot.value : undefined;
  const current = status ?? await preview.request<Snapshot>("/status", { signal });
  if (current.computeError) throw new Error(current.computeError);
  const models = kind === "image" ? current.models.filter(row => row.mode === "image") : videoModels(current.models);
  return models.map(row => ({
    value: row.id, title: row.label,
    subtitle: current.availableModels?.includes(row.id) ? "可用" : "未就绪"
  }));
}
async function chooseMediaModel(target: CanvasItem | undefined, deviceId: string, id: string) {
  if (!(await selectModelService(deviceId))) return false;
  if (!target) model.value = id;
  else if (target.kind === "image") target.imageModel = id;
  else {
    if (!audioModels.value.length) await loadAudioModels();
    target.audioModel = id;
    target.audioParameters = normalizeTtsParameters(audioModels.value.find(row => row.id === id));
    target.audioVoice = undefined;
    target.audioSpeed = undefined;
    target.audioError = "";
  }
  return true;
}
function audioParameterValues(item:CanvasItem){return normalizeTtsParameters(selectedAudioModel(item),item.audioParameters || {voice:item.audioVoice,speed:item.audioSpeed});}
function audioSource(item: CanvasItem) { return item.audioUrl || (item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined); }
async function generateAudioCard(item: CanvasItem) {
  const text = mediaPrompt(item.id, item.text);
  if (item.audioBusy || !text.trim()) return;
  const selectionRevision = mediaService.selectionRevision();
  item.audioBusy = true; item.audioError = "";
  try {
    const chosen=selectedAudioModel(item);if(!chosen?.available)throw new Error("所选 TTS 模型尚未就绪。");
    const settings=ttsCommandSettings(chosen,audioParameterValues(item));
    const audio = await synthesizeWithPauses(text, async input=>{
      if (selectionRevision !== mediaService.selectionRevision()) throw new MediaServiceChangedError();
      const result=await speechControlClient.synthesize({...settings,input});
      if(!result.audio?.size)throw new Error("语音服务没有返回音频。");
      return result.audio;
    });
    if (selectionRevision !== mediaService.selectionRevision()) throw new MediaServiceChangedError();
    const url=URL.createObjectURL(audio);generatedAudio.set(url,audio);
    item.audioUrl = url; item.asset = undefined;
  } catch (cause) { item.audioError = cause instanceof Error ? cause.message : String(cause); }
  finally { item.audioBusy = false; }
}
async function useAudioReference(item: CanvasItem) {
  if (item.audioUrl) {
    const blob = generatedAudio.get(item.audioUrl); if (!blob) throw new Error("音频已失效，请重新生成。");
    if (blob.size > 16*1024**2) throw new Error("参考音频最大 16 MB。");
    item.asset = await request<Asset>("/assets?kind=audio",{method:"POST",headers:{"content-type":"application/octet-stream"},body:blob});
  }
  useCanvasReference(item); if (activeVideo.value) selectCard(activeVideo.value);
}
function canvasVideoUrl(item: CanvasItem) {
  const videoUrl = snapshot.value?.jobs.find(job => job.id === item.jobId)?.videoUrl;
  return videoUrl ? managerResourceUrl(videoUrl) : item.asset ? managerResourceUrl(`/api/video/assets/${item.asset.id}`) : undefined;
}
async function uploadCanvasAsset(event: Event, item: CanvasItem) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = "";
  if (!file || item.kind === "text" || uploading.value || busy.value) return;
  const kind = item.kind as AssetKind, rule = referenceKinds.find(row=>row.id===kind)!;
  if (file.size > rule.bytes) { error.value = `${rule.label}文件最大 ${rule.bytes / 1024 ** 2} MB。`; return; }
  uploading.value = true;
  try {
    item.asset = await request<Asset>(`/assets?kind=${kind}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
    item.jobId = undefined;
    if (item.kind === "audio") item.audioUrl = undefined;
    if (item.kind === "video") {
      setMode("reference");
      const asset = item.asset;
      if (references.value.filter(row=>row.kind==='video').length < 3) changeReferences(()=>references.value.push(asset));
      else notice.value = "视频已上传，参考列表已满，请先移除一个视频参考。";
    }
  }
  catch (failure) { error.value = failure instanceof Error ? failure.message : "素材上传失败。"; }
  finally { uploading.value = false; }
}
function useCanvasReference(item: CanvasItem) {
  if (!item.asset || busy.value || uploading.value) return;
  const asset = item.asset, rule = referenceKinds.find(row=>row.id===asset.kind)!;
  if (references.value.some(row=>row.id===asset.id)) { notice.value = "素材已在当前参考列表中。"; return; }
  if (references.value.filter(row=>row.kind===asset.kind).length >= rule.limit) { error.value = `${rule.label}参考已达到上限。`; return; }
  setMode("reference"); changeReferences(()=>references.value.push(asset)); canvas.center(activeVideoId.value);
}
function resetCanvasView() {
  const id = selectedIds.value.length === 1 ? selectedIds.value[0] : activeVideoId.value;
  if (!id) { canvas.fit(); return; }
  canvas.zoom(1);
  canvas.center(id);
}

const inputProblem = computed(() => {
  if (snapshot.value?.computeError) return snapshot.value.computeError;
  if (videoInputPrompt.value.length > 12000) return "当前提示词和连接的文本合计超过 12000 字。";
  if (!model.value) return "当前模式没有可用的生成方案。";
  if (workflowProblem.value) return workflowProblem.value;
  if (mode.value === "reference" && !references.value.length) return "请添加图片、视频或音频参考。";
  if (snapshot.value?.online && !snapshot.value.availableModels?.includes(model.value)) return "当前方案尚未就绪，请前往「模型服务 → 视频生成模型」检查下载。";
  if (mode.value === "image" && !firstFrame.value && !lastFrame.value) return "请添加首帧或尾帧。";
  if (![width.value, height.value].every(value => Number.isSafeInteger(value) && value >= 256 && value % 32 === 0) || width.value * height.value > 1032192) return "宽高须为 32 的倍数，总像素不超过 1032192。";
  if (!Number.isSafeInteger(frames.value) || frames.value < 22 || frames.value > 260 || (frames.value - 5) % 17 !== 0) return "帧数须为 17k+5，范围 22–260。";
  if (!Number.isSafeInteger(seed.value) || seed.value < 0) return "随机种子须为非负整数。";
  return "";
});
function clearImage(first: boolean) {
  if (first) { firstFrame.value = ""; firstName.value = ""; delete frameShapes.value.first; }
  else { lastFrame.value = ""; lastName.value = ""; delete frameShapes.value.last; }
}
async function reuse(job: Job) {
  if (uploading.value || busy.value) return;
  prompt.value = job.prompt;
  if (job.model) model.value = job.model;
  width.value = job.width ?? width.value; height.value = job.height ?? height.value;
  frames.value = job.frames ?? frames.value; seed.value = job.seed ?? seed.value;
  clearImage(true); clearImage(false);
  mode.value = job.references?.length ? "reference" : job.hasFirstFrame || job.hasLastFrame ? "image" : "text";
  quickGeneration.value = job.quickGeneration ?? ((job.workflowId || snapshot.value?.models.find(item => item.id === job.model)?.defaultWorkflow) === "fast");
  references.value = []; generateAudio.value = !!job.generateAudio; referenceVideoSound.value = !!job.referenceVideoSound;
  if (job.references?.length) {
    await action(async () => { references.value = await Promise.all(job.references!.map(id => request<Asset>(`/assets/${id}?metadata=1`))); });
    if (error.value) return;
  }
  notice.value = mode.value === "image" ? "参数已填入，请重新添加参考图片。" : "参数已填入，可修改后再次生成。";
}
async function copyPrompt(job: Job) {
  try { await navigator.clipboard.writeText(job.prompt); notice.value = "提示词已复制。"; }
  catch { error.value = "复制失败，请手动选择提示词复制。"; }
}
function cancelSelected() {
  const job = selected.value;
  if (job?.status === "queued") void action(async () => {
    await request(`/jobs/${job.id}/cancel`, { method: "POST" });
    void refresh(true);
  });
}
let events: EventSource | undefined;
let computeEvents: EventSource | undefined;
let refreshFlight: Promise<void> | undefined;
let pendingSubmission: { body: string; key: string; deviceId: string } | undefined;
let disposed = false;
const duration = computed(() => (frames.value / (snapshot.value?.models.find(item => item.id === model.value)?.fps || 24)).toFixed(2));
async function request<T>(route: string, init?: RequestInit): Promise<T> {
  return mediaService.request<T>(route, init);
}
let statusController: AbortController | undefined;
let statusInvalidated = false;
let snapshotAt = 0;
const statusError = ref("");
function refresh(changed = false): Promise<void> {
  if (disposed) return Promise.resolve();
  if (refreshFlight) {
    statusInvalidated ||= changed;
    return refreshFlight;
  }
  const controller = new AbortController();
  statusController = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  const flight = request<Snapshot>("/status", { signal }).then(value => {
    if (disposed || signal.aborted) return;
    snapshot.value = value;
    snapshotAt = Date.now();
    statusError.value = "";
    if (!model.value) model.value = videoModels(value.models)[0]?.id || "";
  }).catch(failure => {
    if (!disposed && !controller.signal.aborted && !(failure instanceof MediaServiceChangedError)) {
      statusError.value = "服务状态更新失败。";
      if (previewAccessDenied((failure as { status?: number })?.status)) snapshot.value = undefined;
    }
  }).finally(() => {
    if (refreshFlight !== flight) return;
    refreshFlight = undefined;
    statusController = undefined;
    if (statusInvalidated) {
      statusInvalidated = false;
      void refresh();
    }
  });
  refreshFlight = flight;
  return flight;
}
function showSubmittedJob(job: Job) {
  if (snapshot.value) {
    const jobs = snapshot.value.jobs;
    const index = jobs.findIndex(item => item.id === job.id);
    if (index === -1) jobs.unshift(job);
    else jobs[index] = job;
  }
  void refresh(true);
}
async function action(operation: () => Promise<unknown>) {
  if (busy.value || disposed) return;
  busy.value = true; error.value = "";
  try { await operation(); }
  catch (failure) { if (!disposed && !(failure instanceof MediaServiceChangedError)) error.value = failure instanceof Error ? failure.message : "请求失败。"; }
  finally { busy.value = false; }
}
async function pngBase64FromBitmap(bitmap: ImageBitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法编码图片。");
  context.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("无法编码 PNG。")), "image/png"));
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let encoded = "";
  for (let i = 0; i < buffer.length; i += 0x8000) encoded += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  return btoa(encoded);
}
function isPngBase64(value: string) {
  return value.startsWith("iVBORw0KGgo");
}
async function ensurePngBase64(value: string) {
  if (isPngBase64(value)) return value;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try { return await pngBase64FromBitmap(bitmap); } finally { bitmap.close(); }
}
async function loadImage(event: Event, first: boolean) {
  const file = (event.target as HTMLInputElement).files?.[0];
  (event.target as HTMLInputElement).value = "";
  if (!file) return;
  if (file.size > 9 * 1024 * 1024) { error.value = "请选择不超过 9 MB 的图片。"; return; }
  try {
    const bitmap = await createImageBitmap(file);
    const sourceWidth = bitmap.width, sourceHeight = bitmap.height;
    if (sourceWidth > 4096 || sourceHeight > 4096) { bitmap.close(); error.value = "首尾帧图片宽高不能超过 4096 像素。"; return; }
    const encoded = await pngBase64FromBitmap(bitmap); bitmap.close();
    frameShapes.value[first ? "first" : "last"] = `${sourceWidth}×${sourceHeight}`;
    if (first) { firstFrame.value = encoded; firstName.value = file.name; } else { lastFrame.value = encoded; lastName.value = file.name; }
  } catch { error.value = "图片读取失败，请重新选择 PNG、JPEG、WebP 或 GIF。"; }
}
const videoInputPrompt = computed(() => mediaPrompt(activeVideoId.value, prompt.value));
async function submit() {
  if (inputProblem.value) throw new Error(inputProblem.value);
  if (mode.value === "image") {
    if (firstFrame.value) firstFrame.value = await ensurePngBase64(firstFrame.value);
    if (lastFrame.value) lastFrame.value = await ensurePngBase64(lastFrame.value);
  }
  const body = JSON.stringify({ model: model.value, prompt: videoInputPrompt.value, width: width.value, height: height.value, frames: frames.value, seed: seed.value, quickGeneration: quickGeneration.value, generateAudio: generateAudio.value, ...(mode.value === "reference" ? { references: references.value.map(asset => asset.id), referenceVideoSound: referenceVideoSound.value } : {}), ...(mode.value === "image" && firstFrame.value ? { firstFrame: firstFrame.value } : {}), ...(mode.value === "image" && lastFrame.value ? { lastFrame: lastFrame.value } : {}) });
  if (pendingSubmission && pendingSubmission.deviceId !== serviceDeviceId.value) throw new Error("上次提交结果未确认，请切回原模型服务电脑核对任务记录。");
  if (!pendingSubmission || pendingSubmission.body !== body) pendingSubmission = { body, key: browserUuid(), deviceId:serviceDeviceId.value };
  const result = await request<Job>("/jobs", { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": pendingSubmission.key }, body });
  activeVideo.value!.jobId = result.id; selectedId.value = result.id; filter.value = "all"; search.value = ""; notice.value = "已加入生成队列。";
  pendingSubmission = undefined;
  showSubmittedJob(result);
}
type SavedCanvas = { version: 1; modelComputeDeviceId?: string; serviceDeviceId?: string; items: CanvasItem[]; active: string; selected: string[]; positions: Record<string, NodeLayout>; drafts: [string, ReturnType<typeof captureDraft>][]; audio: [string, Blob][] };
const draftLoaded = ref(true);
const draftFailure = ref("");
let draftRevision = 0;
let savingDraft = false;
let draftSaveFlight: Promise<void> | undefined;
let savingGraph = false;
let workflowLayoutFlight: Promise<void> | undefined;
let workflowLayoutRequested = false;
let pendingDraft = false;
let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
let recentDraft: { projectId: string; canvasId: string; record: DraftRecord<SavedCanvas> } | undefined;
const projectId = ref(new URL(location.href).searchParams.get("project") || "");
const projectTitle = ref("未命名画布");
const workbenchProjectTitle = ref("");
const projectHome = ref(!projectId.value);
const mediaCanvasId = ref("");
const workflowPanel = ref<"settings" | "run">();
const showCliSettings = ref(false);
/** §1.1: the content window edits the node's own text and writes it back on save. */
const nodeEditorId = ref("");
const nodeEditorNode = computed(() => nodeEditorId.value ? flowNodesById.value.get(nodeEditorId.value) : undefined);
const nodeEditorDraft = ref("");
const nodeEditorSize = ref(16);
watch(nodeEditorNode, node => { nodeEditorDraft.value = node ? nodeText(node) : ""; }, { immediate: true });
function closeNodeEditor() { nodeEditorId.value = ""; }
async function saveNodeEditor() {
  const node = nodeEditorNode.value;
  if (!node) return;
  node.config = { ...node.config, text: nodeEditorDraft.value };
  await persistNodeText(node);
  closeNodeEditor();
}
const selectedEdgeId = ref("");
// Stored edges still carry three kinds; the canvas only shows one in port and one out port.
// The kind is decided when the drop lands, so the user never picks a port.
type PortKind = "step" | "content" | "input";
const workflowWire = ref<{ from: string; point: Point; pointer?: number }>();
const pendingInput = ref<{ from: string; to: string; keys: string[] }>();
const workspaceGraph = ref<WorkbenchCanvas>();
const workspaceDefinition = ref<WorkbenchDefinition>();
const canvasActivity = ref<{ canvasId: string; runId: string; attemptStates: Record<string, string> }>();
const focusedRunId = ref("");
const activeCanvasRunId = computed(() => focusedRunId.value || (canvasActivity.value?.canvasId === mediaCanvasId.value ? canvasActivity.value.runId : ""));
const flowNodes = computed(() => workspaceGraph.value?.graph.nodes.filter(node => !node.config.legacyCardId) ?? []);
const visibleFlowNodes = computed(() => flowNodes.value.filter(node => canvas.visibleCardIds.value.has(node.id)));
const flowNodesById = computed(() => new Map(flowNodes.value.map(node => [node.id, node])));
const inputLinksByTarget = computed(() => workflowInputLinks(flowNodes.value));
/** §5.3: material links and text links are one list, keyed by the upstream node. */
const mergedInputsByTarget = computed(() => {
  const byTarget = new Map<string, ReturnType<typeof mergedInputs>>();
  const materialByTarget = inputLinksByTarget.value, textByTarget = contentRefs.value;
  for (const node of flowNodes.value) {
    const material = materialByTarget.get(node.id) ?? [];
    const text = (textByTarget.get(node.id) ?? []).map(source => ({ id: source.id, title: source.title }));
    if (!material.length && !text.length) continue;
    byTarget.set(node.id, mergedInputs({ material, text }));
  }
  return byTarget;
});
/** Run artifacts are only loaded for the selected node, so only it can show a real count. */
function nodeBadge(node: FlowNode) {
  const artifacts = selectedWorkflowNodeId.value === node.id ? nodeArtifacts.value : [];
  return cardBadges(node, artifacts, mergedInputsByTarget.value.get(node.id) ?? []);
}
const nodeRunStates = computed(() => {
  const activity = canvasActivity.value;
  return activity?.canvasId === mediaCanvasId.value && activity?.runId === activeCanvasRunId.value ? activity.attemptStates : undefined;
});
const selectedWorkflowNode = computed(() => selectedIds.value.length === 1 ? flowNodesById.value.get(selectedIds.value[0]!) : undefined);
const nodeArtifacts = ref<ReturnType<typeof workflowRunArtifacts>>([]);
const selectedWorkflowNodeId = computed(() => selectedWorkflowNode.value?.id || "");
const selectedAttemptState = computed(() => nodeRunStates.value?.[selectedWorkflowNodeId.value]);
watch([projectId, mediaCanvasId, activeCanvasRunId, selectedWorkflowNodeId, selectedAttemptState],
  async ([selectedProject, selectedCanvas, runId, nodeId], previous, onCleanup) => {
    if (selectedProject !== previous[0] || selectedCanvas !== previous[1] || runId !== previous[2] || nodeId !== previous[3]) nodeArtifacts.value = [];
    if (!selectedProject || !selectedCanvas || !runId || !nodeId) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    try {
      const receipt = await request<WorkbenchRunReceipt>(`/v2/runs/${encodeURIComponent(runId)}`, { signal });
      if (!signal.aborted) nodeArtifacts.value = workflowRunArtifacts(receipt, { runId, projectId: selectedProject, canvasId: selectedCanvas, nodeId });
    } catch {
      if (!controller.signal.aborted) nodeArtifacts.value = [];
    }
  });
const flowPositions = computed(() => Object.fromEntries(flowNodes.value.map(node => [node.id, node.layout ?? { x: 0, y: 0 }])));
// 创作画布只突出「写东西和做素材」的节点；自动化节点默认收起，需要编排时再展开。
type CanvasNodeEntry = { kind: string; label: string; nodeKind: string; group: "creative" | "pipeline"; icon: string; config?: () => Record<string, unknown> };
const workflowCardKinds: CanvasNodeEntry[] = [
  { kind: "text", label: "文本", nodeKind: "agent", group: "creative", icon: "mdi-format-text", config: () => ({ textPrompt: "", textOutput: true }) },
  { kind: "agent", label: "Agent", nodeKind: "agent", group: "creative", icon: "mdi-robot-outline" },
  { kind: "command", label: "命令", nodeKind: "command", group: "pipeline", icon: "mdi-console" },
  { kind: "human", label: "人工检查", nodeKind: "human", group: "pipeline", icon: "mdi-account-check-outline" },
  { kind: "generate", label: "生成", nodeKind: "generate", group: "pipeline", icon: "mdi-creation" },
  // §6.1 预演台：一份可先空跑的 agent 节点，用来验证上下文与产物路径，不产生真实发布动作。
  { kind: "rehearsal", label: "预演台", nodeKind: "agent", group: "creative", icon: "mdi-play-circle-outline", config: () => ({ textPrompt: "", textOutput: false, rehearsal: true }) }
];
const pipelineNodeKinds = workflowCardKinds.filter(entry => entry.group === "pipeline");
const showPipelineNodes = ref(false);
const flowIcons: Record<string, string> = { command: "mdi-console", agent: "mdi-robot-outline", human: "mdi-account-check-outline", asset: "mdi-file-outline", generate: "mdi-creation" };
function nodeIcon(node: { kind: string; config?: Record<string, any> }) {
  if (node.kind === "agent" && node.config?.textOutput === true) return "mdi-format-text";
  return flowIcons[node.kind] || "mdi-sitemap-outline";
}
function portPosition(id: string, direction: "in" | "out") {
  const point = canvas.positions.value[id];
  if (!point) return;
  return { x: point.x + 130 + (direction === "out" ? canvas.cardSize(id).width : 0), y: point.y + canvas.portOffsets(id).io };
}
/** What a drop from `from` onto `to` should create, judged from the source's own results. */
function resolveEdgeKind(from: string, to: string): PortKind | undefined {
  return resolveDropEdgeKind({
    from, to,
    sourceNode: flowNodesById.value.get(from),
    targetNode: flowNodesById.value.get(to),
    textSourceIds: textSources.value.map(row => row.id),
    mediaIds: canvasItems.value.map(row => row.id),
  });
}
const edgeKindLabels: Record<PortKind, string> = { step: "控制", input: "材料", content: "文本" };
const wireTargetKind = ref<PortKind>();
const flowLinks = computed(() => {
  const graph = workspaceGraph.value;
  if (!graph) return [];
  return [
    ...graph.graph.edges.map(edge => ({ ...edge, kind: "step" as const })),
    ...(graph.mediaLinks ?? []).map(link => ({ ...link, id: JSON.stringify([link.from, link.to]), kind: "content" as const, condition: "" })),
    ...Array.from(inputLinksByTarget.value.values()).flatMap(rows => rows.map(link => ({
      ...link,
      id: JSON.stringify(["input", link.from, link.to]),
      kind: "input" as const,
      condition: ""
    })))
  ];
});
type WireGeometry = { x1: number; y1: number; x2: number; y2: number; path: string };
let visibleWireGeometry = new Map<string, WireGeometry>();
const flowWires = computed(() => {
  const view = canvas.visibleBounds.value;
  const next = new Map<string, WireGeometry>();
  const wires = flowLinks.value.flatMap(link => {
    const start = portPosition(link.from, "out"), end = portPosition(link.to, "in");
    if (!start || !end) return [];
    const bend = wireBend(start, end);
    if (Math.min(start.x, end.x - bend) > view.right || Math.max(start.x + bend, end.x) < view.left ||
      Math.min(start.y, end.y) > view.bottom || Math.max(start.y, end.y) < view.top) return [];
    const previous = visibleWireGeometry.get(link.id);
    const geometry = previous && previous.x1 === start.x && previous.y1 === start.y && previous.x2 === end.x && previous.y2 === end.y
      ? previous : { x1: start.x, y1: start.y, x2: end.x, y2: end.y, path: wirePath(start, end) };
    next.set(link.id, geometry);
    return [{ ...link, path: geometry.path }];
  });
  visibleWireGeometry = next;
  return wires;
});
const wirePreview = computed(() => {
  const wire = workflowWire.value;
  const start = wire && portPosition(wire.from, "out");
  return start && wire ? wirePath(start, wire.point) : "";
});
/** §7.3: the two stored conditions, in the brief's own words: 完成 = success, 成功 = completed. */
const edgeLabels: Record<string, string> = { success: "完成", completed: "成功" };
const edgeBadges = computed(() => flowWires.value.flatMap(wire => {
  if (wire.kind !== "step") return [];
  const start = portPosition(wire.from, "out"), end = portPosition(wire.to, "in");
  if (!start || !end) return [];
  return [{ id: wire.id, edgeId: wire.id, label: edgeLabels[wire.condition] ?? wire.condition, condition: wire.condition,
    x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }];
}));
async function toggleEdgeCondition(edgeId: string) {
  const current = workspaceGraph.value;
  const edge = current?.graph.edges.find(row => row.id === edgeId);
  if (!current || !edge) return;
  const next = edge.condition === "completed" ? "success" : "completed";
  await commitWorkflow(graph => ({ ...graph, graph: { ...graph.graph,
    edges: graph.graph.edges.map(row => row.id === edgeId ? { ...row, condition: next } : row) } }));
}
/** Mid-point label that tells the user which edge the drop will create. */
const wireHint = computed(() => {
  const wire = workflowWire.value, kind = wireTargetKind.value;
  const start = wire && portPosition(wire.from, "out");
  if (!wire || !start || !kind) return undefined;
  return { kind, label: edgeKindLabels[kind], x: (start.x + wire.point.x) / 2, y: (start.y + wire.point.y) / 2 };
});
const textSources = computed(() => [
  ...canvasItems.value,
  ...flowNodes.value.filter(node => node.kind === "agent" && node.config.textOutput === true).map(node => ({
    id: node.id, kind: "text", title: node.title || "文本", text: node.textPreview?.text || "", generated: true
  }))
]);
const contentRefs = computed(() => {
  const byId = new Map(textSources.value.map(item => [item.id, item]));
  const refs = new Map<string, typeof textSources.value>();
  for (const link of workspaceGraph.value?.mediaLinks ?? []) {
    const source = byId.get(link.from);
    if (!source) continue;
    const items = refs.get(link.to) ?? [];
    items.push(source);
    refs.set(link.to, items);
  }
  return refs;
});
function mediaPrompt(id: string, value: string) {
  const upstream = linkedText(textSources.value, workspaceGraph.value?.mediaLinks ?? [], id);
  return upstream ? [upstream, value.trim()].filter(Boolean).join("\n\n") : value;
}
type ProjectCard = {
  id: string; title: string; updatedAt: string; cardCount: number;
  version?: number; mediaEditor?: boolean;
  preview?: CanvasPreview;

};
const projectPreviewKey = ["workbench", "projects"];
const projectPreview = readPreview<ProjectCard[]>(projectPreviewKey);
const projects = ref<ProjectCard[]>(projectPreview ?? []);
const catalogProjectId = ref("");
const lastOpenedCanvasId = ref("");
const catalogRevision = ref(0);
const projectsLoading = ref(false);
const projectsLoaded = ref(!!projectPreview);
const projectsError = ref("");
let projectsRequest: AbortController | undefined;
const jobsById = computed(() => new Map(snapshot.value?.jobs.map(job => [job.id, job])));
const previewUnavailable = ref(new Set<string>());
function resolvePreview(preview?: CanvasPreview): CanvasCover | undefined {
  if (preview?.assetId && preview.kind) {
    return { kind: preview.kind, url: managerResourceUrl(`/api/video/assets/${encodeURIComponent(preview.assetId)}`) };
  }
  const job = preview?.jobId ? jobsById.value.get(preview.jobId) : undefined;
  if (job?.imageUrl) return { kind: "image", url: managerResourceUrl(job.imageUrl) };
  if (job?.videoUrl) return { kind: "video", url: managerResourceUrl(job.videoUrl) };
}
const projectPreviews = computed(() => new Map(projects.value.map(project => [project.id, previewUnavailable.value.has(project.id) ? undefined : resolvePreview(project.preview)])));
function failProjectPreview(id: string) { previewUnavailable.value.add(id); }
let projectsFlight: Promise<void> | undefined;
function loadProjects() {
  if (projectsFlight) return projectsFlight;
  const flight = readProjects().finally(() => { if (projectsFlight === flight) projectsFlight = undefined; });
  projectsFlight = flight;
  return flight;
}
async function readProjects() {
  const controller = new AbortController();
  projectsRequest = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
  projectsLoading.value = true;
  projectsError.value = "";
  try {
    const result = await request<{ projects: ProjectCard[] }>("/projects", { signal });
    if (projectsRequest !== controller || signal.aborted) return;
    projects.value = result.projects;
    writePreview(projectPreviewKey, result.projects);
    projectsLoaded.value = true;
    previewUnavailable.value.clear();
  } catch (failure) {
    if (projectsRequest !== controller || controller.signal.aborted) return;
    if (previewAccessDenied((failure as { status?: number })?.status)) {
      projects.value = [];
      projectsLoaded.value = false;
      writePreview(projectPreviewKey, undefined);
    }
    projectsError.value = signal.aborted ? "项目列表加载超时。" : failure instanceof Error ? failure.message : "项目列表加载失败。";
  } finally {
    if (projectsRequest === controller) {
      projectsRequest = undefined;
      projectsLoading.value = false;
    }
  }
}
type CanvasRoute = { canvasId?: string; nodeId?: string; runId?: string; settings?: boolean };
async function openProject(id: string, route?: CanvasRoute) {
  await workflowLayoutFlight;
  await saveCanvasDraft();
  if (savingDraft || savingGraph || draftFailure.value) return;
  const url = new URL(location.href);
  if (!route && url.searchParams.get("project") === id && url.searchParams.get("view") !== "canvases") {
    route = {
      canvasId: url.searchParams.get("canvas") || undefined,
      nodeId: url.searchParams.get("node") || undefined,
      runId: url.searchParams.get("run") || undefined,
      settings: url.searchParams.get("view") === "flow",
    };
  }
  type ProjectIdentity = { defaultCanvasId: string; title: string };
  const needsDefault = !route?.canvasId && Boolean(route?.runId || route?.nodeId || route?.settings);
  const targetCanvas = route?.canvasId;
  const signal = AbortSignal.timeout(15000);
  async function readCanvas(canvasId: string): Promise<[WorkbenchCanvas, DraftRecord<SavedCanvas>]> {
    const graph = request<WorkbenchCanvas>(`/v2/projects/${encodeURIComponent(id)}/canvases/${encodeURIComponent(canvasId)}`, { signal });
    if (recentDraft?.projectId !== id || recentDraft.canvasId !== canvasId) {
      return Promise.all([graph, readDraft<SavedCanvas>(id, canvasId, signal)]);
    }
    const cached = recentDraft.record;
    const result = await graph;
    const record = result.revision === cached.revision ? cached : await readDraft<SavedCanvas>(id, canvasId, signal);
    return [result, record];
  }
  let target = targetCanvas ? readCanvas(targetCanvas) : undefined;
  void target?.catch(() => {});
  if ((targetCanvas || needsDefault) && !workspaceDefinition.value) {
    void loadWorkbenchDefinition().then(value => {
      if (!disposed) workspaceDefinition.value = value;
    }).catch(() => { /* Node definitions can be retried from canvas settings. */ });
  }
  let modern: ProjectIdentity;
  if (id === projectId.value && workbenchProjectTitle.value && !needsDefault) {
    modern = { title: workbenchProjectTitle.value, defaultCanvasId: "" };
  } else {
    const base = `/v2/projects/${encodeURIComponent(id)}`;
    const projectResponse = await fetch(`/api/video${base}`, { signal: AbortSignal.timeout(15000) });
    if (!projectResponse.ok && projectResponse.status !== 409) {
      throw new Error((await projectResponse.json()).message || "项目读取失败。");
    }
    if (projectResponse.status === 409) target = undefined;
    modern = projectResponse.ok ? await projectResponse.json() : await request<ProjectIdentity>(`${base}/migrate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ automatic: true })
    });
  }
  const canvasId = route?.canvasId || (needsDefault ? modern.defaultCanvasId : "");
  let [savedCanvas, draft] = canvasId ? await (target ?? readCanvas(canvasId)) : [];
  if (savedCanvas && draft && savedCanvas.revision !== draft.revision) {
    [savedCanvas, draft] = await readCanvas(canvasId);
    if (savedCanvas.revision !== draft.revision) throw new Error("画布正在其他窗口更新，请重新打开。");
  }
  await saveCanvasDraft();
  if (disposed || draftFailure.value || savingGraph) return;
  if (savedCanvas && id === projectId.value && canvasId === mediaCanvasId.value && savedCanvas.revision < draftRevision) {
    throw new Error("已保存当前编辑，请再次打开画布读取最新版本。");
  }
  if (draft?.value && !isSavedCanvas(draft.value)) throw new Error("草稿格式无法识别，原草稿已保留。");
  if (projectId.value !== id) lastOpenedCanvasId.value = "";
  if (!canvasId) catalogProjectId.value = id;
  else lastOpenedCanvasId.value = canvasId;
  projectId.value = id;
  workbenchProjectTitle.value = modern.title;
  projectTitle.value = savedCanvas?.name || "未命名画布";
  projectHome.value = false;
  workflowPanel.value = undefined;
  selectedEdgeId.value = "";
  cancelPort();
  pendingInput.value = undefined;
  workspaceGraph.value = savedCanvas;
  mediaCanvasId.value = canvasId;
  focusedRunId.value = route?.runId || "";
  canvasActivity.value = undefined;
  url.searchParams.set("project", id);
  for (const key of ["canvas", "view", "run", "node"]) url.searchParams.delete(key);
  if (canvasId) url.searchParams.set("canvas", canvasId);
  if (route?.runId) url.searchParams.set("run", route.runId);
  history.replaceState(null, "", url);
  if (!savedCanvas || !draft) return;
  draftLoaded.value = false;
  recentDraft = { projectId: id, canvasId, record: draft };
  await restoreCanvasDraft(draft);
  if (route?.nodeId && flowNodes.value.some(node => node.id === route.nodeId)) {
    selectedIds.value = [route.nodeId];
    canvas.center(route.nodeId);
  } else if (route?.runId) workflowPanel.value = "run";
  else if (route?.settings) workflowPanel.value = "settings";
}
async function commitWorkflow(editCanvas: (current: WorkbenchCanvas) => WorkbenchCanvas) {
  await saveCanvasDraft();
  if (savingDraft || savingGraph || draftFailure.value) throw new Error("请先完成当前画布的保存。");
  const id = workspaceGraph.value?.id;
  if (!id) throw new Error("画布尚未打开。");
  const endpoint = `/v2/projects/${encodeURIComponent(projectId.value)}/canvases/${id}`;
  savingGraph = true;
  try {
    const current = await request<WorkbenchCanvas>(endpoint);
    if (current.revision !== draftRevision) throw new Error("画布已在其他窗口更新。请重新打开再编辑。");
    const edited = editCanvas(current);
    const positionsAtSubmission = new Map(Object.entries(canvas.positions.value));
    const saved = await request<WorkbenchCanvas>(endpoint, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(edited)
    });
    workspaceGraph.value = saved;
    draftRevision = saved.revision;
    catalogRevision.value++;
    const ids = new Set(saved.graph.nodes.map(node => node.config.legacyCardId || node.id));
    for (const id of Object.keys(canvas.positions.value)) if (!ids.has(id)) delete canvas.positions.value[id];
    for (const node of saved.graph.nodes) {
      if (!node.config.legacyCardId && node.layout && canvas.positions.value[node.id] === positionsAtSubmission.get(node.id)) {
        canvas.positions.value[node.id] = node.layout;
      }
    }
    selectedIds.value = selectedIds.value.filter(id => ids.has(id));
    return saved;
  } finally {
    savingGraph = false;
    if (pendingDraft) void saveCanvasDraft();
    if (workflowLayoutRequested) persistWorkflowLayout();
  }
}
function saveWorkflowNodes(editNodes: (nodes: FlowNode[]) => FlowNode[]) {
  return commitWorkflow(current => ({ ...current, graph: { ...current.graph, nodes: editNodes(current.graph.nodes) } }));
}
function saveInspectorDraft(edited: WorkbenchCanvas, nodeId?: string) {
  return commitWorkflow(current => {
    if (edited.id !== current.id) throw new Error("当前画布已切换。");
    if (!nodeId) {
      if (edited.revision !== current.revision) throw new Error("画布已更新，请重新打开再编辑。");
      return edited;
    }
    if (!current.graph.nodes.some(node => node.id === nodeId)) throw new Error("当前节点已移除。");
    const changed = edited.graph.nodes.find(node => node.id === nodeId);
    const stageId = edited.graph.groups.find(group => group.nodeIds.includes(nodeId))?.id;
    const nodes = current.graph.nodes.flatMap(node => node.id !== nodeId ? [node] : changed ? [{ ...changed, layout: node.layout, textPreview: node.textPreview }] : []);
    const groups = current.graph.groups.map(group => {
      const belongs = !!changed && group.id === stageId;
      if (group.nodeIds.includes(nodeId) === belongs) return group;
      const nodeIds = belongs ? [...group.nodeIds, nodeId] : group.nodeIds.filter(id => id !== nodeId);
      return { ...group, nodeIds };
    });
    const edges = changed ? current.graph.edges : current.graph.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
    const mediaLinks = changed ? current.mediaLinks : current.mediaLinks?.filter(link => link.from !== nodeId && link.to !== nodeId);
    return { ...current, mediaLinks, graph: { ...current.graph, nodes, groups, edges } };
  });
}
async function prepareNodeRun() {
  await workflowLayoutFlight;
  await saveCanvasDraft();
  if (savingDraft || savingGraph || draftFailure.value || !workspaceGraph.value) throw new Error("请先完成当前画布的保存。");
  return draftRevision;
}
async function saveNodeResult(nodeId: string, textPreview: TextPreview) {
  const current = workspaceGraph.value;
  if (!current || !current.graph.nodes.some(node => node.id === nodeId)) throw new Error("当前节点已移除。");
  if (current.graph.nodes.some(node => node.id === nodeId && node.textPreview?.attemptId === textPreview.attemptId)) return current;
  // 生成文本直接成为节点正文，节点上看到的就是最新内容，不需要再区分「预览」和「正文」。
  return saveWorkflowNodes(nodes => nodes.map(node => node.id === nodeId ? { ...node, config: node.config.textOutput === true ? { ...node.config, text: textPreview.text } : node.config, textPreview } : node));
}
function nodeText(node: FlowNode) {
  return typeof node.config.text === "string" && node.config.text.length ? node.config.text : (node.textPreview?.text || "");
}
function writeNodeText(node: FlowNode, value: string) {
  node.config = { ...node.config, text: value };
}
async function persistNodeText(node: FlowNode) {
  const text = typeof node.config.text === "string" ? node.config.text : undefined;
  if (text === undefined) return;
  try {
    await saveWorkflowNodes(nodes => nodes.map(row => row.id === node.id ? { ...row, config: { ...row.config, text } } : row));
  } catch (failure) {
    notice.value = failure instanceof Error ? failure.message : "文本保存失败。";
  }
}
/** §5.2: the toolbar is its own canvas layer above the card, never a second in-card path. */
const TOOLBAR_TEXT_STEPS = [12, 14, 16, 20, 24, 30] as const;
const toolbarTextSize = ref<Record<string, number>>({});
function textSize(nodeId: string) { return toolbarTextSize.value[nodeId] ?? 16; }
function stepTextSize(node: FlowNode, direction: -1 | 1) {
  const current = textSize(node.id);
  const index = TOOLBAR_TEXT_STEPS.findIndex(size => size >= current);
  const from = index < 0 ? TOOLBAR_TEXT_STEPS.length - 1 : index;
  const next = TOOLBAR_TEXT_STEPS[Math.max(0, Math.min(TOOLBAR_TEXT_STEPS.length - 1, from + direction))];
  toolbarTextSize.value = { ...toolbarTextSize.value, [node.id]: next ?? 16 };
}
/** Downloads whatever the card currently holds: its text, or its verified artifact links. */
async function downloadNodeContent(node: FlowNode) {
  const text = nodeText(node);
  if (text.trim()) {
    try {
      const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${(node.title || node.id).replace(/[\\/:*?"<>|]/g, "_")}.txt`;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    } catch { /* fall through to the notice below */ }
  }
  notice.value = nodeArtifacts.value.length
    ? "产物请从参数框的「已核验产物」下载，这里可导出节点正文。"
    : "这个节点还没有可下载的内容。";
}
async function openNodeEditor(node: FlowNode) {
  selectedIds.value = [node.id];
  nodeEditorId.value = node.id;
}
/**
 * The toolbar sits in the workspace layer (outside the zoomed world), so it has to
 * project world coordinates the same way `.canvas-world` does: world * scale + offset.
 */
const toolbarNode = computed(() => selectedWorkflowNode.value);
const toolbarStyle = computed(() => {
  const node = toolbarNode.value, point = node ? canvas.positions.value[node.id] : undefined;
  if (!node || !point) return { left: "0px", top: "0px", display: "none" };
  const scale = canvas.scale.value, offset = canvas.offset.value;
  return { left: `${offset.x + (point.x + 130) * scale}px`, top: `${offset.y + point.y * scale - 44}px` };
});
async function addWorkflowCard(entry: string) {
  const preset = workflowCardKinds.find(row => row.kind === entry);
  const position = contextMenu.value?.world;
  contextMenu.value = undefined;
  if (!preset) throw new Error("无法读取节点类型。");
  if (canvasItems.value.length) pendingDraft = true;
  const current = workspaceGraph.value;
  if (!current) throw new Error("无法读取节点类型。");
  const id = browserUuid();
  canvas.add(id);
  try {
    const layout = position ?? canvas.positions.value[id];
    const count = flowNodes.value.filter(node => (node.title || "").replace(/\s+\d+$/, "") === preset.label).length + 1;
    const node = { id, kind: preset.nodeKind, title: `${preset.label} ${count}`, config: preset.config ? preset.config() : initialFlowNodeConfig(preset.nodeKind), layout, enabled: true };
    await saveWorkflowNodes(nodes => [...nodes, node]);
    if (layout) canvas.positions.value[id] = layout;
    selectedIds.value = [id];
    canvas.center(id);
  } catch (failure) {
    delete canvas.positions.value[id];
    throw failure;
  }
}
function workflowPointerDown(event: PointerEvent, node: FlowNode) {
  if (busy.value || uploading.value) return;
  nodePointerDown(event, node.id, () => { selectedIds.value = [node.id]; });
}
function beginPort(event: PointerEvent, id: string) {
  if (event.isPrimary === false || event.button !== 0 || busy.value || uploading.value || canPan.value || !workspaceGraph.value) return;
  const point = portPosition(id, "out");
  if (!point) return;
  event.preventDefault();
  pendingInput.value = undefined;
  wireTargetKind.value = undefined;
  workflowWire.value = { from: id, point, pointer: event.pointerId };
  viewport.value?.setPointerCapture(event.pointerId);
}
function armPortFromKeyboard(event: MouseEvent, id: string) {
  if (event.detail || busy.value || uploading.value || canPan.value || !workspaceGraph.value) return;
  const point = portPosition(id, "out");
  if (!point) return;
  const previous = workflowWire.value;
  cancelPort();
  pendingInput.value = undefined;
  if (previous?.from !== id) workflowWire.value = { from: id, point };
}
function cancelPort() {
  const pointer = workflowWire.value?.pointer;
  workflowWire.value = undefined;
  wireTargetKind.value = undefined;
  if (pointer !== undefined && viewport.value?.hasPointerCapture(pointer)) viewport.value.releasePointerCapture(pointer);
}
/** The parameter panel is its own canvas layer, so selecting a card never changes its size. */
const parameterNodeId = computed(() => selectedWorkflowNode.value?.id ?? "");
const parameterPanelStyle = computed(() => {
  const id = parameterNodeId.value, point = id ? canvas.positions.value[id] : undefined;
  if (!id || !point) return { left: "0px", top: "0px" };
  return { left: `${point.x}px`, top: `${point.y + 34 + canvas.cardSize(id).height + 10}px` };
});
function closeCanvasOverlays() {
  cancelPort();
  pendingInput.value = undefined;
  showLibrary.value = false;
  contextMenu.value = undefined;
  openPopover.value = "";
  selectedIds.value = [];
}
/** A badge click selects the card so its parameter panel shows the same list. */
async function selectNodeForPanel(id: string) {
  selectedIds.value = [id];
  contextMenu.value = undefined;
}
/** Preview which edge the current pointer position would create. */
function trackWireTarget(event: PointerEvent) {
  const wire = workflowWire.value;
  if (!wire) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-card-port]");
  const target = hit?.dataset.cardId;
  wireTargetKind.value = target && target !== wire.from
    ? (event.altKey ? "step" : resolveEdgeKind(wire.from, target))
    : undefined;
}
function applyWorkspacePointer(event: PointerEvent) {
  if (!workflowWire.value) { canvas.move(event); return; }
  if (workflowWire.value.pointer !== undefined && workflowWire.value.pointer !== event.pointerId) return;
  const bounds = viewport.value?.getBoundingClientRect();
  if (bounds) workflowWire.value.point = canvas.world({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  trackWireTarget(event);
}
// 节点复制粘贴：Ctrl+C 记录选中节点快照，Ctrl+V 以新 id 复原；媒体卡片留在本页，工作流节点随画布保存。
let canvasClipboard: CanvasClipboard | undefined;
let canvasPasteRound = 0;
let pointerWorldPoint: Point | undefined;
let pointerFrame: number | undefined;
let pendingPointer: PointerEvent | undefined;
function finishPointerFrame(pointerId?: number, apply = false) {
  if (pointerId !== undefined && pendingPointer?.pointerId !== pointerId) return;
  if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
  const event = pendingPointer;
  pointerFrame = undefined;
  pendingPointer = undefined;
  if (apply && event) applyWorkspacePointer(event);
}
function moveWorkspacePointer(event: PointerEvent) {
  const bounds = viewport.value?.getBoundingClientRect();
  if (bounds) pointerWorldPoint = canvas.world({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  const wire = workflowWire.value;
  if (!wire && !canvas.moving(event.pointerId)) {
    // Capture the pointer as soon as it crosses the drag threshold, before the next frame.
    canvas.move(event);
    return;
  }
  if (wire?.pointer !== undefined && wire.pointer !== event.pointerId) return;
  pendingPointer = event;
  pointerFrame ??= requestAnimationFrame(() => finishPointerFrame(undefined, true));
}
async function connectPort(target: string, forced?: PortKind) {
  const wire = workflowWire.value;
  if (!wire || wire.from === target) return;
  const kind = forced ?? resolveEdgeKind(wire.from, target);
  cancelPort();
  if (!kind) return;
  if (kind === "content") {
    if (canvasItems.value.length) pendingDraft = true;
    await commitWorkflow(current => ({ ...current, mediaLinks: [...(current.mediaLinks ?? []), { from: wire.from, to: target }] }));
    return;
  }
  if (kind === "input") {
    const keys = workflowArtifactKeys(flowNodesById.value.get(wire.from));
    if (!keys.length) return;
    selectedIds.value = [target];
    const input = { from: wire.from, to: target, keys };
    if (keys.length === 1) await linkWorkflowInput(input, keys[0]!);
    else pendingInput.value = input;
    return;
  }
  const definition = workspaceDefinition.value;
  if (!definition) return;
  await commitWorkflow(current => {
    const edge = connectGraph(current.graph, definition, { id: browserUuid(), from: wire.from, to: target, fromPort: "control", toPort: "control", condition: "success" });
    return { ...current, graph: { ...current.graph, edges: [...current.graph.edges, edge] } };
  });
}
async function confirmPendingInput(key: string) {
  const input = pendingInput.value;
  if (input) await linkWorkflowInput(input, key);
}
async function linkWorkflowInput(input: { from: string; to: string }, artifactKey: string) {
  const definition = workspaceDefinition.value;
  if (!definition) return;
  await commitWorkflow(current => ({ ...current, graph: connectWorkflowInput(current.graph, definition, input.from, input.to, artifactKey) }));
  pendingInput.value = undefined;
}
async function removeWorkflowInput(from: string, to: string) {
  await saveWorkflowNodes(nodes => nodes.map(node => node.id === to ? {
    ...node, inputs: node.inputs?.filter(input => input.producerNodeId !== from)
  } : node));
}
async function removeContentLink(from: string, to: string) {
  await commitWorkflow(current => ({ ...current, mediaLinks: current.mediaLinks?.filter(link => link.from !== from || link.to !== to) }));
}
/** One merged row can carry both a material link and a text link to the same source. */
async function removeMergedInput(row: MergedInput, target: string) {
  if (row.kind === "material" || row.artifactKeys.length) await removeWorkflowInput(row.from, target);
  if (row.kind === "text") await removeContentLink(row.from, target);
}
function selectWire(wire: { id: string; kind: PortKind; from: string; to: string }) {
  if (wire.kind === "step") void action(() => openWorkflowPanel("settings", wire.id));
  else selectedIds.value = [wire.to];
}
/** A log line belongs to a node: select it, center it, and keep the run panel reachable. */
async function focusRunNode(nodeId: string) {
  if (!nodeId || !flowNodesById.value.has(nodeId)) return;
  selectedIds.value = [nodeId];
  canvas.center(nodeId);
}
function focusInputSource(id: string) {
  selectedIds.value = [id];
  canvas.center(id);
}
/** `@click` feeds the action wrapper, which expects a promise. */
async function focusInputSourceAction(id: string) { focusInputSource(id); }
function nodeProcessing(id: string) {
  const state = nodeRunStates.value?.[id];
  return state === "running" || state === "waiting_agent";
}
function backgroundPointerDown(event: PointerEvent) {
  if (event.isPrimary === false) return;
  cancelPort();
  canvas.backgroundDown(event);
  contextMenu.value = undefined;
}
/** The menu's 上传 entry routes each file to the media card kind its extension implies. */
async function uploadFromMenu(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length) return;
  for (const file of files) {
    const kind = /\.(png|jpe?g|webp|gif)$/i.test(file.name) ? "image"
      : /\.(mp4|mov|webm)$/i.test(file.name) ? "video"
      : /\.(wav|mp3|m4a|flac|ogg)$/i.test(file.name) ? "audio" : undefined;
    if (!kind) { notice.value = `无法判断 ${file.name} 的类型，只支持图片、视频和音频。`; continue; }
    addCanvasItem(kind as CanvasKind);
    const created = canvasItems.value[canvasItems.value.length - 1];
    if (created) await uploadCanvasAsset({ target: { files: [file], value: "" } } as unknown as Event, created);
  }
}
/** §6.1: double-clicking empty canvas opens the add-node menu at the pointer. */
function backgroundDoubleClick(event: MouseEvent) {
  if (busy.value || uploading.value || canPan.value) return;
  const target = event.target as HTMLElement;
  if (target.closest(".canvas-object,.canvas-group,.canvas-tools,.workspace-tools,.canvas-minimap,.canvas-menu,.output-library,.v-overlay,.canvas-toolbar,.canvas-editor-backdrop")) return;
  event.preventDefault();
  openCanvasMenu(event);
}
function cancelWorkspaceGesture(event: PointerEvent) {
  finishPointerFrame(event.pointerId);
  if (workflowWire.value?.pointer === event.pointerId) cancelPort();
  canvas.cancel(event);
}
function endWorkspaceGesture(event: PointerEvent) {
  finishPointerFrame(event.pointerId, true);
  const wire = workflowWire.value;
  if (wire?.pointer === event.pointerId) {
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-card-port],[data-card-output]");
    const target = hit?.dataset.cardId;
    if (target && target !== wire.from && hit?.dataset.cardPort) void action(() => connectPort(target, event.altKey ? "step" : undefined));
    else {
      cancelPort();
      if (hit && target === wire.from) workflowWire.value = { ...wire, pointer: undefined };
    }
    return;
  }
  if (canvas.end(event)) persistWorkflowLayout();
}
function resizeCardWithKeyboard(event: KeyboardEvent, id: string) {
  if (canvas.resizeWithKeyboard(event, id)) persistWorkflowLayout();
}
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function writeClipboardText(text: string) {
  try { void navigator.clipboard?.writeText(text).catch(() => {}); } catch { /* 系统剪贴板不可用时，本页仍可粘贴本次复制 */ }
}
async function readClipboardText() {
  try { return await navigator.clipboard?.readText(); } catch { return undefined; }
}
function copySelectedNodes() {
  const entries: CanvasClipboardEntry[] = [];
  for (const id of selectedIds.value) {
    const item = canvasItems.value.find(row => row.id === id);
    if (item) {
      const { id: _id, ...data } = item;
      const draft = id === activeVideoId.value ? captureDraft() : drafts.get(id);
      const layout = canvas.positions.value[id];
      entries.push({ type: "media", data: cloneJson(data) as unknown as Record<string, unknown>,
        ...(draft ? { draft: cloneJson(draft) as unknown as Record<string, unknown> } : {}),
        ...(layout ? { layout: { ...layout } } : {}) });
      continue;
    }
    const node = flowNodesById.value.get(id);
    if (!node) continue;
    const { id: _nodeId, textPreview: _preview, inputs: _inputs, requirements: _requirements, layout: _layout, ...data } = node;
    const layout = canvas.positions.value[id] ?? node.layout;
    entries.push({ type: "workflow", data: cloneJson(data) as unknown as Record<string, unknown>, ...(layout ? { layout: { ...layout } } : {}) });
  }
  if (!entries.length) { notice.value = "先在画布上选中节点，再按 Ctrl+C 复制。"; return; }
  canvasClipboard = createCanvasClipboard(entries);
  canvasPasteRound = 0;
  writeClipboardText(JSON.stringify(canvasClipboard));
  notice.value = `已复制 ${entries.length} 个节点，按 Ctrl+V 粘贴。`;
}
async function pasteNodes() {
  const clipboard = canvasClipboard ?? parseCanvasClipboard(await readClipboardText());
  if (!clipboard?.entries.length) { notice.value = "剪贴板里没有画布节点，先选中节点按 Ctrl+C 复制。"; return; }
  const layouts = pasteLayouts(clipboard.entries, pointerWorldPoint ? { anchor: pointerWorldPoint } : { offset: 40 + canvasPasteRound * 40 });
  canvasPasteRound += 1;
  const nodes = clipboard.entries.flatMap((entry, index) => entry.type !== "workflow" ? [] : [{
    ...cloneJson(entry.data), id: browserUuid(),
    title: copiedNodeTitle(String(entry.data.title ?? ""), workspaceDefinition.value?.capabilities[String(entry.data.kind)]?.label || "节点"),
    enabled: entry.data.enabled !== false, layout: layouts[index]!
  } as unknown as FlowNode]);
  // 先保存流程节点再放媒体卡片，保存失败时画布不会只贴一半。
  if (nodes.length) await saveWorkflowNodes(current => [...current, ...nodes]);
  const media: CanvasItem[] = [];
  for (const [index, entry] of clipboard.entries.entries()) {
    if (entry.type !== "media") continue;
    const item = { ...cloneJson(entry.data), id: browserUuid(), title: copiedNodeTitle(String(entry.data.title ?? ""), "节点") } as unknown as CanvasItem;
    canvasItems.value.push(item); canvas.add(item.id);
    canvas.positions.value[item.id] = layouts[index]!;
    if (entry.draft) drafts.set(item.id, cloneJson(entry.draft) as unknown as ReturnType<typeof captureDraft>);
    media.push(item);
  }
  const pasted = [...media.map(item => item.id), ...nodes.map(node => node.id)];
  if (!pasted.length) return;
  selectedIds.value = pasted;
  const video = media.find(item => item.kind === "video");
  if (video) selectCanvasVideo(video);
  notice.value = `已粘贴 ${pasted.length} 个节点。`;
}
// 画布页面内统一处理复制粘贴：焦点在输入框、编辑器或浮层里时保留浏览器默认行为。
let canvasShortcutsActive = true;
function canvasClipboardShortcut(event: KeyboardEvent) {
  if (!canvasShortcutsActive || event.defaultPrevented || event.isComposing) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
  const key = event.key.toLowerCase();
  if (key !== "c" && key !== "v") return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("input,textarea,select,[contenteditable],.composer,.v-overlay")) return;
  if (document.activeElement instanceof Element && document.activeElement.closest("input,textarea,select,[contenteditable]")) return;
  if (key === "c") {
    // 选中节点内文字时保留浏览器复制文本的行为，没有选中节点时也不接管。
    if (!selectedIds.value.length || (window.getSelection?.()?.toString() ?? "").trim()) return;
    event.preventDefault();
    copySelectedNodes();
    return;
  }
  event.preventDefault();
  void pasteNodes().catch(failure => { notice.value = failure instanceof Error ? failure.message : "粘贴失败。"; });
}
onActivated(() => { canvasShortcutsActive = true; });
onDeactivated(() => { canvasShortcutsActive = false; });
function nudgeCard(event: KeyboardEvent, id?: string) {
  if (canvas.nudge(event, id)) persistWorkflowLayout();
}
function restoreCanvasLayout(reverse: boolean) {
  if (canvas.restoreLayout(reverse)) persistWorkflowLayout();
}
function releaseCanvasSpace(event?: KeyboardEvent) {
  if (!event || event.code === "Space") canvas.spacePan.value = false;
}
function keepCanvasFocus(event: FocusEvent) {
  if (!viewport.value?.contains(event.relatedTarget as Node | null)) releaseCanvasSpace();
}
function canvasKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || (event.target as Element).closest("input,textarea,select,[contenteditable],.composer,.v-overlay")) return;
  if (event.code === "Space" && !(event.target as Element).closest("button,a,summary")) {
    event.preventDefault();
    canvas.spacePan.value = true;
  } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "g") {
    event.preventDefault();
    createGroup();
  } else if ((event.ctrlKey || event.metaKey) && !event.altKey && ["z", "y"].includes(event.key.toLowerCase())) {
    event.preventDefault();
    restoreCanvasLayout(event.key.toLowerCase() === "z" && !event.shiftKey);
  } else if (!(event.target as Element).closest("button,a,summary")) {
    nudgeCard(event);
  }
}
function persistWorkflowLayout() {
  const canvasId = workspaceGraph.value?.id;
  if (!canvasId) return;
  workflowLayoutRequested = true;
  if (savingGraph || workflowLayoutFlight) return;
  workflowLayoutFlight = (async () => {
    try {
      while (workflowLayoutRequested && workspaceGraph.value?.id === canvasId) {
        workflowLayoutRequested = false;
        const changed = flowNodes.value.some(node => {
          const position = canvas.positions.value[node.id];
          return position && (position.x !== (node.layout?.x ?? 0) || position.y !== (node.layout?.y ?? 0) ||
            position.width !== node.layout?.width || position.height !== node.layout?.height);
        });
        if (changed) await saveWorkflowNodes(nodes => nodes.map(node => node.config.legacyCardId ? node : {
          ...node, layout: canvas.positions.value[node.id] ?? node.layout
        }));
      }
    } catch (failure) {
      notice.value = failure instanceof Error ? failure.message : "节点位置与尺寸保存失败。";
    }
  })().finally(() => { workflowLayoutFlight = undefined; });
}
// 画布分组：组框渲染、Ctrl+G 成组、整组拖动、右下角缩放、取消分组
type GroupRect = { x: number; y: number; width: number; height: number };
const GROUP_HEAD = 26;
const groupDraft = ref<{ id: string; rect: GroupRect }>();
function groupRectOf(group: { layout?: GroupRect }): GroupRect | undefined {
  const layout = group.layout;
  return layout && Number.isFinite(layout.x) && Number.isFinite(layout.y)
    && Number.isFinite(layout.width) && Number.isFinite(layout.height) && layout.width > 0 && layout.height > 0 ? layout : undefined;
}
const layoutGroups = computed(() => (workspaceGraph.value?.graph.groups ?? [])
  .filter(group => !!groupRectOf(group as { layout?: GroupRect }))
  .map(group => groupDraft.value?.id === group.id ? { ...group, layout: groupDraft.value.rect } : group));
function groupStyle(group: any) {
  const rect = groupRectOf(group);
  return rect ? { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` } : {};
}
function selectionBounds(ids: string[]): GroupRect | undefined {
  const rows = ids.flatMap(id => {
    const rect = canvas.cardRect(id);
    return rect ? [{ x: rect.x, y: rect.y, width: rect.width, height: rect.height }] : [];
  });
  if (!rows.length) return undefined;
  const left = Math.min(...rows.map(row => row.x)) - 24;
  const top = Math.min(...rows.map(row => row.y)) - GROUP_HEAD - 24;
  return { x: left, y: top, width: Math.max(...rows.map(row => row.x + row.width)) - left + 24,
    height: Math.max(...rows.map(row => row.y + row.height)) - top + 24 };
}
async function saveGroups(edit: (groups: any[]) => any[]) {
  return commitWorkflow(current => ({ ...current, graph: { ...current.graph, groups: edit(current.graph.groups as any[]) } }));
}
function createGroup() {
  const ids = [...selectedIds.value].filter(id => !!canvas.positions.value[id]);
  if (!ids.length) { notice.value = "先选中要成组的节点。"; return; }
  const rect = selectionBounds(ids);
  if (!rect) return;
  const name = `分组${(workspaceGraph.value?.graph.groups.length ?? 0) + 1}`;
  void saveGroups(groups => [...groups, { id: browserUuid(), name, nodeIds: ids, layout: rect }])
    .then(() => { notice.value = `已成组：${name}（${ids.length} 个节点）`; })
    .catch(failure => { notice.value = failure instanceof Error ? failure.message : "成组失败。"; });
}
const selectedGroupId = ref<string>();
function removeGroup(group: { id: string }) {
  selectedGroupId.value = undefined;
  void saveGroups(groups => groups.filter(row => row.id !== group.id));
}
function selectGroup(group: { id: string }) {
  selectedGroupId.value = selectedGroupId.value === group.id ? undefined : group.id;
}
type ArrangeMode = "grid" | "row" | "col";
const ARRANGE_LABELS: Record<ArrangeMode, string> = { grid: "网格排列", row: "横向排列", col: "纵向排列" };
const ARRANGE_MODES: ArrangeMode[] = ["grid", "row", "col"];
function arrangeGroup(group: any, mode: ArrangeMode) {
  const ids = (group.nodeIds as string[]).filter(id => !!canvas.positions.value[id]);
  if (ids.length < 2) { notice.value = "分组里至少要有两个节点才能整理。"; return; }
  const rect = groupRectOf(group) ?? selectionBounds(ids);
  if (!rect) return;
  const sizes = ids.map(id => canvas.cardSize(id));
  const cellW = Math.max(...sizes.map(size => size.width));
  const cellH = Math.max(...sizes.map(size => size.height));
  const gap = 24;
  let columns: number;
  if (mode === "row") columns = ids.length;
  else if (mode === "col") columns = 1;
  else columns = Math.max(1, Math.floor((Math.max(cellW, rect.width - 48) + gap) / (cellW + gap)));
  const rows = Math.ceil(ids.length / columns);
  const contentW = columns * cellW + (columns - 1) * gap;
  const contentH = rows * cellH + (rows - 1) * gap;
  const originX = rect.x + Math.max(24, (rect.width - contentW) / 2);
  const originY = rect.y + GROUP_HEAD + 24;
  const after: Record<string, { x: number; y: number }> = {};
  ids.forEach((id, index) => {
    after[id] = { x: originX + (index % columns) * (cellW + gap), y: originY + Math.floor(index / columns) * (cellH + gap) };
  });
  const nextRect: GroupRect = { ...rect, width: Math.max(rect.width, contentW + 48), height: Math.max(rect.height, contentH + GROUP_HEAD + 48) };
  canvas.applyLayout(after);
  persistWorkflowLayout();
  void saveGroups(groups => groups.map(row => row.id === group.id ? { ...row, layout: nextRect } : row));
  notice.value = `已按${ARRANGE_LABELS[mode]}整理 ${ids.length} 个节点。`;
}
type GroupCorner = "nw" | "ne" | "sw" | "se";
const GROUP_CORNERS: GroupCorner[] = ["nw", "ne", "sw", "se"];
const groupGesture = ref<{ id: string; mode: "move" | "resize"; corner?: GroupCorner; startX: number; startY: number;
  rect: GroupRect; members: Record<string, { x: number; y: number }>; moved: boolean }>();
function beginGroupGesture(event: PointerEvent, group: any, mode: "move" | "resize", corner?: GroupCorner) {
  const rect = groupRectOf(group);
  if (event.button !== 0 || !rect) return;
  event.preventDefault(); event.stopPropagation();
  const members: Record<string, { x: number; y: number }> = {};
  for (const id of group.nodeIds) { const point = canvas.positions.value[id]; if (point) members[id] = { x: point.x, y: point.y }; }
  groupGesture.value = { id: group.id, mode, corner, startX: event.clientX, startY: event.clientY, rect: { ...rect }, members, moved: false };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}
function moveGroupGesture(event: PointerEvent) {
  const gesture = groupGesture.value;
  if (!gesture) return;
  const dx = (event.clientX - gesture.startX) / canvas.scale.value;
  const dy = (event.clientY - gesture.startY) / canvas.scale.value;
  if (gesture.mode === "move") {
    groupDraft.value = { id: gesture.id, rect: { ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy } };
    for (const [id, point] of Object.entries(gesture.members)) {
      canvas.positions.value[id] = { ...(canvas.positions.value[id] ?? {}), x: point.x + dx, y: point.y + dy };
    }
  } else {
    const signX = gesture.corner === "sw" || gesture.corner === "nw" ? -1 : 1;
    const signY = gesture.corner === "ne" || gesture.corner === "nw" ? -1 : 1;
    const width = Math.max(160, gesture.rect.width + dx * signX);
    const height = Math.max(100, gesture.rect.height + dy * signY);
    groupDraft.value = { id: gesture.id, rect: {
      x: signX < 0 ? gesture.rect.x + gesture.rect.width - width : gesture.rect.x,
      y: signY < 0 ? gesture.rect.y + gesture.rect.height - height : gesture.rect.y,
      width, height } };
  }
  gesture.moved = true;
}
function endGroupGesture() {
  const gesture = groupGesture.value;
  if (!gesture) return;
  groupGesture.value = undefined;
  const rect = groupDraft.value?.id === gesture.id ? groupDraft.value.rect : undefined;
  groupDraft.value = undefined;
  if (!gesture.moved) { selectGroup({ id: gesture.id }); return; }
  if (!rect) return;
  void saveGroups(groups => groups.map(row => row.id === gesture.id ? { ...row, layout: rect } : row));
  if (gesture.mode === "move") persistWorkflowLayout();
}
async function createProject() {
  const project = await request<{ id: string }>("/v2/projects", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: browserUuid() })
  });
  await openProject(project.id);
}
function openMediaCanvas(id: string, runId?: string) {
  return openProject(projectId.value, { canvasId: id, runId });
}
function showProjectCanvases() {
  return openProject(projectId.value, {});
}
async function openWorkflowPanel(mode: "settings" | "run", edgeId = "") {
  await workflowLayoutFlight;
  await saveCanvasDraft();
  if (savingDraft || draftFailure.value) return;
  selectedEdgeId.value = edgeId;
  workflowPanel.value = mode;
}
function closeWorkflowPanel() {
  workflowPanel.value = undefined;
  selectedEdgeId.value = "";
}
async function workbenchHome() {
  projectHome.value = true;
  catalogProjectId.value = "";
  closeWorkflowPanel();
  projectId.value = "";
  workbenchProjectTitle.value = "";
  mediaCanvasId.value = "";
  workspaceGraph.value = undefined;
  const url = new URL(location.href);
  for (const key of ["project", "canvas", "view", "run", "node"]) url.searchParams.delete(key);
  history.replaceState(null, "", url);
  void loadProjects();
}
async function showProjects() {
  await workflowLayoutFlight;
  await saveCanvasDraft();
  if (savingDraft || draftFailure.value) return;
  await workbenchHome();
}
function canvasRecord(): SavedCanvas {
  const allDrafts = new Map(drafts);
  if (activeVideoId.value) allDrafts.set(activeVideoId.value, captureDraft());
  const items = JSON.parse(JSON.stringify(canvasItems.value)) as CanvasItem[];
  const audio: [string, Blob][] = [];
  for (const item of items) {
    item.audioBusy = false;
    if (item.audioUrl?.startsWith("blob:")) {
      const blob = generatedAudio.get(item.audioUrl);
      if (blob) audio.push([item.id, blob]);
      delete item.audioUrl;
    }
  }
  const ids = new Set(items.map(item => item.id));
  const positions = Object.fromEntries(Object.entries(canvas.positions.value).filter(([id]) => ids.has(id)));
  return { version: 1, modelComputeDeviceId: serviceDeviceId.value, items, active: activeVideoId.value, selected: storedMediaSelection.value.filter(id => ids.has(id)), positions, drafts: JSON.parse(JSON.stringify([...allDrafts])), audio };
}
async function saveCanvasDraft() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = undefined;
  if (draftSaveFlight) return draftSaveFlight;
  if (savingGraph || draftFailure.value || !pendingDraft) return;
  savingDraft = true;
  const flight = (async () => {
    try {
      while (pendingDraft) {
        const value = canvasRecord();
        pendingDraft = false;
        draftRevision = await writeDraft(projectId.value, value, draftRevision, projectTitle.value, mediaCanvasId.value || undefined);
        catalogRevision.value++;
      }
    } catch (failure) {
      pendingDraft = true;
      draftFailure.value = failure instanceof Error ? failure.message : "草稿保存失败。";
    }
  })();
  draftSaveFlight = flight;
  try { await flight; }
  finally { draftSaveFlight = undefined; savingDraft = false; }
}
watch(() => [captureDraft(), canvasItems.value, canvasItems.value.map(item => canvas.positions.value[item.id]), activeVideoId.value, storedMediaSelection.value, projectTitle.value, serviceDeviceId.value, canvas.changingLayout.value], () => {
  if (!draftLoaded.value || projectHome.value || !mediaCanvasId.value || !canvasItems.value.length || draftFailure.value || canvas.changingLayout.value) return;
  pendingDraft = true;
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(saveCanvasDraft, 350);
}, { deep: true, flush: "post" });
function isSavedCanvas(value: SavedCanvas) {
  if (value.version !== 1 || !Array.isArray(value.items)) return false;
  return value.active
    ? value.items.some(item => item.id === value.active && item.kind === "video")
    : !value.items.some(item => item.kind === "video");
}
async function restoreCanvasDraft(record: DraftRecord<SavedCanvas>) {
  try {
    draftFailure.value = "";
    for (const url of generatedAudio.keys()) URL.revokeObjectURL(url);
    generatedAudio.clear();
    draftRevision = record.revision;
    if (!workspaceGraph.value || record.value || !flowNodes.value.length) projectTitle.value = record.title;
    if (record.value) {
      const value = structuredClone(record.value);
      const compute = restoreMediaComputeSelection(value);
      serviceDeviceId.value = compute.deviceId;
      draftRevision = record.revision;
      canvasItems.value = value.items;
      for (const item of canvasItems.value) {
        if (item.imageKey && item.imageComputeDeviceId === undefined) item.imageComputeDeviceId = compute.pendingImageDeviceId;
      }
      canvas.positions.value = { ...flowPositions.value, ...value.positions };
      drafts.clear(); for (const [id, draft] of value.drafts) drafts.set(id, draft);
      for (const [id, blob] of value.audio || []) {
        const item = canvasItems.value.find(row => row.id === id);
        if (item) { const url = URL.createObjectURL(blob); generatedAudio.set(url, blob); item.audioUrl = url; }
      }
      // Restore through the existing parameter owner without overwriting the saved active draft.
      activeVideoId.value = "";
      const wasBusy = busy.value; busy.value = false;
      const video = canvasItems.value.find(item => item.id === value.active);
      if (video) selectCanvasVideo(video);
      busy.value = wasBusy;
      drafts.delete("");
      selectedIds.value = value.selected.filter(id => value.items.some(item => item.id === id));
      selectedCanvasId.value = selectedIds.value[0] || value.active;
      const focus = value.active || selectedCanvasId.value || value.items[0]?.id;
      if (focus) canvas.center(focus);
    }
    if (!record.value && flowNodes.value.length) {
      serviceDeviceId.value = "";
      drafts.clear();
      canvasItems.value = [];
      activeVideoId.value = "";
      selectedCanvasId.value = "";
      selectedIds.value = [];
      canvas.positions.value = flowPositions.value;
      await nextTick();
      // 步骤多的画布不再一进来就缩成全图：先给一个可读的落点，全貌交给「适应画布」。
      const anchor = flowNodes.value[0]?.id;
      if (flowNodes.value.length > 6 && anchor) { canvas.zoom(1); canvas.center(anchor); }
      else canvas.fit();
    } else if (!record.value) {
      if (mediaCanvasId.value && record.title === "新画布") projectTitle.value = "未命名画布";
      serviceDeviceId.value = "";
      drafts.clear(); canvasItems.value = [{id:"draft-1",kind:"video",title:"视频 1",text:""}];
      canvas.positions.value={};canvas.add("draft-1");
      activeVideoId.value=""; const wasBusy=busy.value;busy.value=false;selectCanvasVideo(canvasItems.value[0]!);busy.value=wasBusy;drafts.delete("");
      selectedIds.value=["draft-1"];selectedCanvasId.value="draft-1";canvas.center("draft-1");
    }
  } catch (failure) {
    draftFailure.value = failure instanceof Error ? failure.message : "草稿恢复失败，原内容未覆盖。";
  } finally { await nextTick(); draftLoaded.value = true; }
  connectModelService();
}
function protectUnsavedDraft(event: BeforeUnloadEvent) {
  if (savingDraft || pendingDraft || draftFailure.value) { event.preventDefault(); event.returnValue = ""; }
}
const serviceBusy = computed(() => busy.value || uploading.value || !draftLoaded.value || canvasItems.value.some(item => item.audioBusy));
async function selectModelService(deviceId: string): Promise<boolean> {
  if (serviceBusy.value) return false;
  if (deviceId === serviceDeviceId.value) return true;
  serviceDeviceId.value = deviceId;
  connectModelService();
  return serviceDeviceId.value === deviceId;
}
let connectedDeviceId: string | undefined;
function connectModelService() {
  if (connectedDeviceId === serviceDeviceId.value) {
    if (statusError.value) void refresh();
    if (canvasItems.value.some(item => item.kind === "audio" && item.id === selectedCanvasId.value)) void loadAudioModels();
    return;
  }
  connectedDeviceId = serviceDeviceId.value;
  mediaService.invalidate();
  statusController?.abort();
  refreshFlight = undefined;
  statusInvalidated = false;
  snapshotAt = 0;
  statusError.value = "";
  computeEvents?.close(); computeEvents = undefined;
  if (snapshot.value) snapshot.value = {...snapshot.value, computeError:undefined, online:false, models:[], availableModels:[], availableWorkflows:[]};
  const revision = mediaService.selectionRevision();
  if (serviceDeviceId.value) {
    computeEvents = managerEventSource(peerManagerPath(serviceDeviceId.value, "/api/video/compute/events"));
    computeEvents.addEventListener("compute", event => {
      if (disposed || revision !== mediaService.selectionRevision()) return;
      const name = JSON.parse((event as MessageEvent).data).name;
      if (name === "video.changed" || name === "video.models") void refresh(true);
    });
    computeEvents.onopen = () => {if (revision === mediaService.selectionRevision()) void refresh();};
    computeEvents.onerror = () => {if (revision === mediaService.selectionRevision() && snapshot.value) snapshot.value={...snapshot.value,online:false};};
  }
  audioCatalogFlight = undefined;
  audioCatalogAt = 0;
  audioModels.value = []; audioCatalogError.value = "";
  void refresh();
  if (canvasItems.value.some(item => item.kind === "audio" && item.id === selectedCanvasId.value)) void loadAudioModels();
}
onMounted(() => {
  if (projectId.value) {
    draftLoaded.value = false;
    void action(async () => {
      try { await openProject(projectId.value); }
      finally { draftLoaded.value = true; }
    });
  } else void loadProjects();
  window.addEventListener("beforeunload", protectUnsavedDraft);
  window.addEventListener("keyup", releaseCanvasSpace);
  document.addEventListener("keydown", canvasClipboardShortcut);
});
onBeforeUnmount(() => {
  finishPointerFrame();
  void saveCanvasDraft();
  projectsRequest?.abort();
  window.removeEventListener("beforeunload", protectUnsavedDraft);
  window.removeEventListener("keyup", releaseCanvasSpace);
  document.removeEventListener("keydown", canvasClipboardShortcut);
});
watch([projectId, mediaCanvasId], () => {
  canvas.clearHistory();
  releaseCanvasSpace();
});
onMounted(() => {
  if (!projectId.value) void connectModelService();
  events = managerEventSource("/api/events");
  events.addEventListener("plugin_event", event => {
    try {
      const payload = JSON.parse((event as MessageEvent).data);
      const value = payload.data?.instanceId ? payload.data : payload;
      if (value.instanceId !== "manager:video") return;
      if (value.name === "workbench.changed") {
        if (value.data?.projectId === projectId.value && value.data?.canvasId === mediaCanvasId.value && typeof value.data.runId === "string" && value.data.attemptStates) {
          canvasActivity.value = { canvasId: value.data.canvasId, runId: value.data.runId, attemptStates: value.data.attemptStates };
        }
        return;
      }
      if (value.name === "video.progress") {
        const job = snapshot.value?.jobs.find(item => item.id === value.data.jobId);
        if (job && ['queued', 'running'].includes(job.status)) {
          const { progress, progressStage, progressValue, progressMax, progressUnit, startedAt } = value.data;
          Object.assign(job, { status: 'running', progress, progressStage, progressValue, progressMax, progressUnit, startedAt: startedAt || job.startedAt });
        }
      } else if (value.name === "video.changed" || (value.name === "video.models" && !serviceDeviceId.value)) void refresh(true);
    } catch { statusError.value = "任务事件读取失败。"; }
  });
  events.onopen = () => { if (connectedDeviceId !== undefined) void refresh(); };
});
onBeforeUnmount(() => { disposed = true; mediaService.invalidate(); statusController?.abort(); events?.close(); computeEvents?.close(); for (const url of generatedAudio.keys()) URL.revokeObjectURL(url); generatedAudio.clear(); });
</script>

<template>
  <v-theme-provider with-background class="video-page">
    <v-dialog v-model="showCliSettings" max-width="520"><WorkbenchCliSettings v-if="showCliSettings" @close="showCliSettings=false"/></v-dialog>
    <p v-if="!draftLoaded && !mediaCanvasId" class="video-hint ma-4" role="status">正在打开工作台…</p>
    <section v-if="projectHome" class="project-home">
      <div class="workbench-project-heading"><h1>我的项目</h1><v-btn variant="text" prepend-icon="mdi-refresh" aria-label="刷新项目列表" @click="loadProjects">刷新</v-btn><v-btn variant="text" prepend-icon="mdi-robot-outline" @click="showCliSettings=true">Agent 设置</v-btn></div>
      <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      <p v-if="projectsLoading && !projectsLoaded" role="status" class="video-hint">正在加载项目…</p>
      <v-alert v-if="projectsError" type="error" variant="tonal">
        {{ projectsError }} <v-btn variant="text" @click="loadProjects">重试</v-btn>
      </v-alert>
      <p v-if="projectsLoaded && !projectsLoading && !projectsError && !projects.length" class="video-hint">还没有项目。</p>
      <div class="project-grid">
        <button class="project-tile project-new" :disabled="busy" @click="action(createProject)"><v-icon icon="mdi-plus" size="30" /><span>新建项目</span></button>
        <button v-for="project in projects" :key="project.id" class="project-tile" :disabled="busy"
          @click="action(() => openProject(project.id))">
          <div class="project-cover">
            <img v-if="projectPreviews.get(project.id)?.kind === 'image'" :src="projectPreviews.get(project.id)?.url" alt="" loading="lazy" @error="failProjectPreview(project.id)"/>
            <video v-else-if="projectPreviews.get(project.id)?.kind === 'video'" :src="projectPreviews.get(project.id)?.url" muted playsinline preload="metadata" aria-hidden="true" @error="failProjectPreview(project.id)"/>
            <v-icon v-else :icon="project.version === 2 && !project.mediaEditor && project.cardCount ? 'mdi-sitemap-outline' : 'mdi-movie-open-outline'" size="44"/>
          </div>
          <strong>{{project.title}}</strong>
          <small>{{ project.version === 2 && !project.mediaEditor && project.cardCount ? `${project.cardCount} 个节点` : `${project.cardCount} 张卡片` }} · {{ new Date(project.updatedAt).toLocaleString() }}</small>
        </button>
      </div>
    </section>
    <section v-else-if="catalogProjectId === projectId && workbenchProjectTitle" v-show="!mediaCanvasId" class="project-home">
      <v-alert v-if="error" type="error" variant="tonal">{{ error }}</v-alert>
      <WorkbenchPanel :key="projectId" :project-id="projectId" :project-title="workbenchProjectTitle" :resolve-cover="resolvePreview" :list-hidden="!!mediaCanvasId" :list-revision="catalogRevision" :last-opened-canvas-id="lastOpenedCanvasId" mode="list" @back="action(showProjects)"
        @media="(id,runId) => action(() => openMediaCanvas(id,runId))" @cli-settings="showCliSettings=true"/>
    </section>
    <section v-else-if="!mediaCanvasId && error" class="project-home">
      <v-btn prepend-icon="mdi-arrow-left" variant="text" @click="action(showProjects)">我的项目</v-btn>
      <v-alert type="error" variant="tonal">{{ error }}</v-alert>
    </section>
    <v-dialog v-if="workflowPanel && mediaCanvasId && !projectHome" :model-value="true" persistent max-width="760" scrollable>
      <v-card><v-card-text class="workflow-dialog-content">
        <WorkbenchPanel :key="workflowPanel + mediaCanvasId" :project-id="projectId" :canvas-id="mediaCanvasId" :mode="workflowPanel" :edge-id="selectedEdgeId" :commit="saveInspectorDraft" @back="closeWorkflowPanel" @media="(id,runId)=>action(()=>openMediaCanvas(id,runId))" @run-selected="focusedRunId = $event" @focus-node="focusRunNode"/>
      </v-card-text></v-card>
    </v-dialog>
    <PeerServerSelect :model-value="serviceDeviceId" v-slot="computers">
    <div v-show="!projectHome && !!mediaCanvasId">
    <Teleport v-if="!projectHome && !!mediaCanvasId" to="#page-topbar-controls" defer>
    <div class="video-heading workspace-heading">
      <v-btn prepend-icon="mdi-arrow-left" variant="text" size="small" @click="action(showProjectCanvases)">画布列表</v-btn>
      <strong v-if="flowNodes.length && !canvasItems.length">{{projectTitle}}</strong>
      <input v-else v-model="projectTitle" class="project-title" aria-label="画布名称" maxlength="100" />
      <span class="canvas-status">{{ statusError || (snapshot ? (snapshot.computeError ? '服务暂不可用' : snapshot.online ? '服务已就绪' : '按需启动') : '正在连接') }}</span>
      <v-btn v-if="statusError" variant="text" size="small" @click="refresh()">重试连接</v-btn>
      <v-spacer />
      <v-btn v-if="mediaCanvasId" variant="text" size="small" @click="action(() => openWorkflowPanel('settings'))">画布设置</v-btn>
      <v-btn v-if="flowNodes.length" variant="text" size="small" @click="action(() => openWorkflowPanel('run'))">运行</v-btn>
      <v-btn variant="text" size="small" prepend-icon="mdi-robot-outline" @click="showCliSettings=true">Agent 设置</v-btn>
    </div>
    </Teleport>
    <v-alert v-if="draftFailure" type="error" variant="tonal">{{ draftFailure }}</v-alert>
    <v-alert v-if="error || snapshot?.computeError" type="error" variant="tonal" class="mb-4">{{ error || snapshot?.computeError }}</v-alert>
    <div ref="viewport" class="video-workspace" tabindex="0" aria-label="画布编辑区" :class="{'canvas-dragging':dragging,'canvas-hand':canPan,'linking-port':!!workflowWire}" :style="canvasGrid" @contextmenu="openCanvasMenu" @pointerdown.capture="dismissCanvasPopovers" @pointerdown="backgroundPointerDown" @dblclick="backgroundDoubleClick" @pointermove="moveWorkspacePointer" @pointerup="endWorkspaceGesture" @pointercancel="cancelWorkspaceGesture" @lostpointercapture.self="cancelWorkspaceGesture" @pointerleave="canvas.leave" @click.capture="canvas.preventDragClick" @wheel="canvas.wheel" @focusout="keepCanvasFocus" @keydown="canvasKeyDown" @keydown.esc="closeCanvasOverlays">
      <nav class="workspace-tools" aria-label="创作工具"><button aria-label="添加画布卡片" @click="openCanvasMenu"><v-icon icon="mdi-plus" size="23" /></button><button :class="{active:showLibrary}" :aria-expanded="showLibrary" aria-controls="video-history-panel" aria-label="作品历史" @click="showLibrary=!showLibrary"><v-icon icon="mdi-history" size="23" /></button></nav>
      <div v-if="marquee" class="canvas-selection-box" :style="{left:marquee.x+'px',top:marquee.y+'px',width:marquee.width+'px',height:marquee.height+'px'}" />
      <div class="canvas-world" :style="canvasTransform">
      <section v-for="group in layoutGroups" :key="group.id" class="canvas-group" :class="{ selected: selectedGroupId === group.id }" :style="groupStyle(group)"
        @pointerdown.stop="beginGroupGesture($event, group, 'move')" @pointermove="moveGroupGesture"
        @pointerup="endGroupGesture" @pointercancel="endGroupGesture">
        <header class="canvas-group-head" :aria-pressed="selectedGroupId === group.id">
          <v-icon icon="mdi-group" size="14" />
          <span>{{ group.name || '分组' }}</span>
          <small>{{ group.nodeIds.length }}</small>
        </header>
        <div v-if="selectedGroupId === group.id" class="canvas-group-toolbar" role="toolbar" :aria-label="`${group.name || '分组'}操作`" @pointerdown.stop @click.stop>
          <details class="group-arrange">
            <summary><v-icon icon="mdi-view-grid-outline" size="14" />整理<v-icon icon="mdi-chevron-down" size="13" /></summary>
            <div class="group-arrange-menu" role="menu">
              <button v-for="mode in ARRANGE_MODES" :key="mode" type="button" role="menuitem" @click="arrangeGroup(group, mode)">{{ ARRANGE_LABELS[mode] }}</button>
            </div>
          </details>
          <span class="group-tool-divider" />
          <button type="button" class="group-tool-danger" @click="removeGroup(group)">取消分组</button>
        </div>
        <button v-for="corner in GROUP_CORNERS" :key="corner" type="button"
          :class="`canvas-group-resize corner-${corner}`" :aria-label="`调整分组大小 ${corner}`"
          @pointerdown.stop="beginGroupGesture($event, group, 'resize', corner)" @pointermove="moveGroupGesture"
          @pointerup="endGroupGesture" @pointercancel="endGroupGesture" />
      </section>
      <svg v-if="flowWires.length || wirePreview" class="workspace-flow-wires" aria-hidden="true">
        <g v-for="wire in flowWires" :key="wire.id" class="flow-connection" @pointerdown="$event.button === 0 && !canPan && $event.stopPropagation()" @click.stop="selectWire(wire)">
          <path :d="wire.path" class="connection-hit" vector-effect="non-scaling-stroke" aria-hidden="true" />
          <path :d="wire.path" :class="{ 'control-connection': wire.kind === 'step', 'material-connection': wire.kind !== 'step', 'input-connection': wire.kind === 'input', 'content-connection': wire.kind === 'content', 'completed-connection': wire.condition === 'completed', 'related-connection': selectedIds.includes(wire.from) || selectedIds.includes(wire.to), 'processing-connection': wire.kind !== 'step' && nodeProcessing(wire.to) }" class="connection-line" vector-effect="non-scaling-stroke" />
        </g>
        <path v-if="wirePreview" :d="wirePreview" class="preview-connection"/>
      </svg>
      <div v-if="wireHint" class="canvas-wire-hint" :class="`kind-${wireHint.kind}`" :style="{ left: `${wireHint.x}px`, top: `${wireHint.y}px` }">{{ wireHint.label }}</div>
      <button v-for="badge in edgeBadges" :key="badge.id" type="button" class="canvas-edge-badge" :class="`condition-${badge.condition}`"
        :aria-label="`连接条件 ${badge.label}，点击切换`" :title="`连接条件 ${badge.label}，点击切换`"
        :style="{ left: `${badge.x}px`, top: `${badge.y}px` }"
        @pointerdown.stop @click.stop="action(() => toggleEdgeCondition(badge.edgeId))">{{ badge.label }}</button>
      <article v-for="item in visibleMediaItems" :key="item.id" :data-canvas-node="item.id" class="canvas-object canvas-card" :class="{'canvas-selected':selectedIds.includes(item.id)}" :style="canvas.position(item.id)" @pointerdown="cardPointerDown($event,item)" @contextmenu="openCardMenu($event,item)">
        <template v-if="workspaceGraph">
        <button class="workspace-port port-in" :data-card-port="'in'" :data-card-id="item.id" aria-label="输入：控制与材料" title="输入：控制与材料" @pointerdown.stop @click.stop="action(() => connectPort(item.id))"><v-icon icon="mdi-link-variant" size="13"/></button>
        <button class="workspace-port port-out" :data-card-output="'out'" :data-card-id="item.id" aria-label="输出：控制与材料" title="输出：控制与材料" @pointerdown.stop="beginPort($event, item.id)" @click.stop="armPortFromKeyboard($event, item.id)"><v-icon icon="mdi-link-variant" size="13"/></button>
        </template>
        <button class="canvas-drag-handle" :aria-label="`移动${item.title}`" @click="!$event.detail && selectCard(item)" @keydown="nudgeCard($event,item.id)"><v-icon :icon="canvasKinds.find(row=>row.kind===item.kind)?.icon" size="16" />{{ item.title }}<v-icon icon="mdi-drag" size="16" /></button>
        <div v-if="item.kind==='video'" class="canvas-video-card" data-canvas-card-body>
          <video v-if="canvasVideoUrl(item)" draggable="false" class="passive-video" :src="canvasVideoUrl(item)" preload="metadata" />
          <div v-else class="canvas-card-empty"><v-icon icon="mdi-video-outline" size="32" /><span>上传或生成视频</span><label class="card-upload-button" @pointerdown.stop>上传视频<input type="file" accept="video/mp4" :aria-label="`上传${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label></div>
        </div>
        <div v-else-if="item.kind==='text'" class="canvas-text-card" data-canvas-card-body><p class="node-text-preview">{{ mediaPrompt(item.id, item.text) || '添加文本内容…' }}</p></div>
        <div v-else class="canvas-media-card" data-canvas-card-body>
          <img v-if="item.kind==='image' && imageSource(item)" draggable="false" :src="imageSource(item)" :alt="item.title" />
          <div v-else-if="item.kind==='audio' && audioSource(item)" class="canvas-card-empty"><v-icon icon="mdi-music-note-outline" size="32" /><audio :src="audioSource(item)" controls preload="metadata" :aria-label="`播放${item.title}`" @pointerdown.stop /></div>
          <div v-else class="canvas-card-empty"><v-icon :icon="item.kind==='image' ? 'mdi-image-outline' : 'mdi-music-note-outline'" size="32" /><span>{{ item.kind==='audio' ? '上传或生成音频' : '上传或生成图片' }}</span><label class="card-upload-button" @pointerdown.stop>上传{{ item.kind==='audio' ? '音频' : '图片' }}<input type="file" :accept="item.kind==='audio' ? '.wav,audio/wav' : 'image/png'" :aria-label="`上传${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label></div>
          <label v-if="imageSource(item) || (item.kind==='audio' && audioSource(item))" class="card-replace-upload card-upload-button" @pointerdown.stop>替换<input type="file" :accept="item.kind==='audio' ? '.wav,audio/wav' : 'image/png'" :aria-label="`替换${item.title}`" :disabled="busy || uploading" @change="uploadCanvasAsset($event,item)" /></label>
        </div>
        <button class="canvas-resize-handle" :aria-label="`调整 ${item.title} 的大小`" @pointerdown.stop="canvas.beginResize($event, item.id)" @keydown="resizeCardWithKeyboard($event, item.id)" />
        <section v-if="item.kind!=='video' && selectedIds.length===1 && selectedIds.includes(item.id)" class="composer node-editor" :class="{'audio-node-editor':item.kind==='audio'}" :aria-label="`${item.title}编辑`" @pointerdown.stop @contextmenu.stop>
          <div v-if="contentRefs.get(item.id)?.length" class="canvas-reference-chips" aria-label="来自上游的文本">
            <button v-for="source in contentRefs.get(item.id)" :key="source.id" :title="source.text" :aria-label="`移除来自${source.title}的输入`" @click="action(() => removeContentLink(source.id, item.id))">{{source.title}} ×</button>
          </div>
          <template v-if="item.kind==='text'">
            <textarea v-model="item.text" :aria-label="`${item.title}内容`" placeholder="写下镜头、台词或创作笔记…" />
            <button class="canvas-card-action" :disabled="!activeVideo || !item.text.trim()" @click="appendCardText(item)">加入视频提示词</button>
          </template>
          <template v-else>
            <template v-if="item.kind==='image'">
              <button v-if="imageSource(item)" class="canvas-card-action" @click="action(()=>useGeneratedImage(item))">用作视频参考</button>
              <textarea v-model="item.text" :aria-label="`${item.title}生成提示词`" placeholder="描述你想生成的画面…" />
              <div class="image-generation-controls">
                <span class="image-mode-label"><v-icon icon="mdi-image-outline" size="15" />图片生成</span>
                <ComputerModelPicker compact label="选择图片模型" :open="openPopover===`image-model-${item.id}`"
                  @update:open="updatePopover(`image-model-${item.id}`,$event)" :device-id="serviceDeviceId" :computers="computers"
                  :model-id="item.imageModel || imageModels[0]?.id"
                  :model-label="imageModels.find(row => row.id === (item.imageModel || imageModels[0]?.id))?.label"
                  :disabled="serviceBusy" :load-models="(device, signal) => loadModelOptions('image', device, signal)"
                  :choose="(device, id) => chooseMediaModel(item, device, id)">
                  <template #footer><RouterLink class="model-manage-link" :to="{ path: '/model-services', query: { tab: 'image', deviceId: serviceDeviceId || undefined } }">管理模型与下载<v-icon icon="mdi-arrow-top-right" size="15" /></RouterLink></template>
                </ComputerModelPicker>
                <v-menu :model-value="openPopover===`image-format-${item.id}`" @update:model-value="updatePopover(`image-format-${item.id}`,$event)" location="top" offset="8" :close-on-content-click="false"><template #activator="{props}"><button v-bind="props" class="media-picker" aria-label="图片比例与清晰度"><v-icon icon="mdi-rectangle-outline" size="16" />{{ imageRatio(item).label }} / {{ imageQuality(item) }}<v-icon icon="mdi-chevron-down" size="16" /></button></template>
                  <div class="image-format-menu"><div class="format-label">比例</div><div class="image-ratio-segments"><button v-for="ratio in imageRatios" :key="ratio.label" :class="{active:imageRatio(item).label===ratio.label}" :aria-label="`图片比例 ${ratio.label}`" :aria-pressed="imageRatio(item).label===ratio.label" @click="setImageFormat(item,ratio)"><span :style="{width:(ratio.w>=ratio.h ? 17 : 17*ratio.w/ratio.h)+'px',height:(ratio.h>=ratio.w ? 17 : 17*ratio.h/ratio.w)+'px'}" />{{ ratio.label }}</button></div><div class="format-label">清晰度 <small>{{ (item.imageSize || '1024x1024').replace('x',' × ') }}</small></div><div class="image-quality-segments"><button v-for="quality in ['480P','720P','1K','2K']" :key="quality" :class="{active:imageQuality(item)===quality}" :aria-pressed="imageQuality(item)===quality" @click="setImageFormat(item,imageRatio(item),quality)">{{ quality }}</button></div></div>
                </v-menu>
                <span class="image-single-count">×1</span>
                <v-btn class="image-generate-arrow" icon="mdi-arrow-up" size="x-small" color="white" aria-label="生成图片" :disabled="busy || uploading || !!snapshot?.computeError || !mediaPrompt(item.id, item.text).trim() || !imageModels.length || (imageJob(item) && !snapshot?.states[imageJob(item)!.status]?.terminal)" @click="action(()=>generateImage(item))" />
              </div>
              <p v-if="imageJob(item)" role="status">{{ snapshot?.states[imageJob(item)!.status]?.label }} {{ imageJob(item)?.error }}</p>
            </template>
            <template v-if="item.kind==='audio'">

              <div v-if="item.audioMode!=='reference'" class="audio-text-tools"><v-menu v-for="group in audioInsertGroups" :key="group.id" :model-value="openPopover===`audio-${group.id}-${item.id}`" @update:model-value="updatePopover(`audio-${group.id}-${item.id}`,$event)" location="bottom start" offset="6"><template #activator="{props}"><button v-bind="props" class="media-picker audio-text-picker" :aria-label="group.label" :disabled="item.audioBusy">{{ group.label }}<v-icon icon="mdi-chevron-down" size="14" /></button></template><div class="media-model-menu audio-insert-menu" role="menu" :aria-label="`${group.label}选项`"><button v-for="option in group.items" :key="option.label" role="menuitem" @click="insertAudioText(item,option.text)"><span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span></button></div></v-menu></div>
              <AudioPromptEditor v-if="item.audioMode!=='reference'" :ref="el=>{if(el)audioEditors.set(item.id,el as InstanceType<typeof AudioPromptEditor>);else audioEditors.delete(item.id);}" v-model="item.text" :label="`${item.title}合成文字`" :disabled="item.audioBusy" />

              <div class="image-generation-controls audio-toolbar"><v-menu :model-value="openPopover===`audio-mode-${item.id}`" @update:model-value="updatePopover(`audio-mode-${item.id}`,$event)" location="top start" offset="8"><template #activator="{props}"><button v-bind="props" class="media-picker" aria-label="音频功能" :disabled="item.audioBusy"><v-icon icon="mdi-music-note-outline" size="15" />{{ item.audioMode==='reference' ? '音频参考' : '音频生成' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template><div class="media-model-menu" role="menu" aria-label="音频功能选项"><button role="menuitemradio" :aria-checked="item.audioMode!=='reference'" @click="item.audioMode='generate'"><span><strong>音频生成</strong><small>将文字合成为语音</small></span></button><button role="menuitemradio" :aria-checked="item.audioMode==='reference'" @click="item.audioMode='reference'"><span><strong>音频参考</strong><small>上传、试听并用于视频生成</small></span></button></div></v-menu>
                <ComputerModelPicker v-if="item.audioMode !== 'reference'" compact label="选择音频模型"
                  :open="openPopover===`audio-model-${item.id}`" @update:open="updatePopover(`audio-model-${item.id}`,$event)"
                  :device-id="serviceDeviceId" :computers="computers" :model-id="selectedAudioModel(item)?.id"
                  :model-label="selectedAudioModel(item)?.name" :disabled="serviceBusy"
                  :load-models="(device, signal) => loadModelOptions('audio', device, signal)"
                  :choose="(device, id) => chooseMediaModel(item, device, id)" />
                <button v-if="item.audioMode!=='reference'" class="media-picker" :class="{active:item.audioSettingsOpen}" aria-label="音频参数设置" :aria-expanded="!!item.audioSettingsOpen" :aria-controls="`audio-settings-${item.id}`" @click="item.audioSettingsOpen=!item.audioSettingsOpen;openPopover='';if(item.audioSettingsOpen)loadAudioModels()">参数设置<v-icon :icon="item.audioSettingsOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="16" /></button>
                <a v-if="audioSource(item)" class="media-picker" :href="audioSource(item)" :download="`${item.title}.wav`" aria-label="下载音频"><v-icon icon="mdi-download" size="16" /></a>
                <v-btn v-if="item.audioMode!=='reference'" class="generate-button" color="white" size="x-small" icon="mdi-arrow-up" aria-label="生成音频" :loading="item.audioBusy" :disabled="item.audioBusy || !mediaPrompt(item.id, item.text).trim() || !audioModels.some(row=>row.available && row.id===(item.audioModel || audioModels.find(row=>row.available)?.id))" @click="generateAudioCard(item)" />
              </div>
              <TtsModelParameters v-if="item.audioSettingsOpen && item.audioMode!=='reference'" :id="`audio-settings-${item.id}`" class="audio-settings-panel" :model="selectedAudioModel(item)" :model-value="audioParameterValues(item)" @update:model-value="item.audioParameters=$event" :disabled="item.audioBusy" />
              <p v-if="selectedAudioModel(item) && !selectedAudioModel(item)?.available" class="audio-catalog-message">所选模型尚未就绪，可先配置参数。</p>
              <p v-if="item.audioError || audioCatalogError" class="audio-catalog-message" role="status">{{ item.audioError || audioCatalogError }}</p>
              <button v-if="audioSource(item)" class="canvas-card-action" :disabled="!activeVideo || busy || uploading || item.audioBusy" @click="action(()=>useAudioReference(item))">用作视频参考</button>
            </template>
          </template>
        </section>
      </article>
      <article v-for="node in visibleFlowNodes" :key="node.id" :data-canvas-node="node.id" class="canvas-object canvas-card workflow-card"
        :class="{ 'canvas-selected': selectedIds.includes(node.id), 'workflow-card-disabled': node.enabled === false, 'creative-card': node.kind === 'agent' && node.config.textOutput === true, 'workflow-card-processing': nodeProcessing(node.id) }" :style="canvas.position(node.id)" @pointerdown="workflowPointerDown($event,node)">
        <button class="workspace-port port-in" data-card-port="in" :data-card-id="node.id"
          aria-label="输入：控制与材料" title="输入：控制与材料" @pointerdown.stop @click.stop="action(() => connectPort(node.id))"><v-icon icon="mdi-link-variant" size="13"/></button>
        <button class="workspace-port port-out" data-card-output="out" :data-card-id="node.id"
          aria-label="输出：控制与材料" title="输出：控制与材料" @pointerdown.stop="beginPort($event, node.id)" @click.stop="armPortFromKeyboard($event, node.id)"><v-icon icon="mdi-link-variant" size="13"/></button>
        <button class="canvas-drag-handle" :aria-label="node.title || '流程节点'" @click="!$event.detail && (selectedIds=[node.id])" @keydown="nudgeCard($event,node.id)">
          <v-icon :icon="nodeIcon(node)" size="16"/>{{ node.title || workspaceDefinition?.capabilities[node.kind]?.label || node.kind }}<v-icon icon="mdi-drag" size="16"/>
        </button>
        <div class="workflow-card-body canvas-text-card" data-canvas-card-body>
          <span v-if="nodeRunStates?.[node.id]" class="node-run-badge" role="status">{{ workspaceDefinition?.nodeStates[nodeRunStates[node.id]!]?.label || nodeRunStates[node.id] }}</span>
          <textarea v-if="node.config.textOutput===true" class="node-text-preview node-text-editor" :class="{muted:!nodeText(node).trim()}" :style="{ fontSize: `${textSize(node.id)}px` }" :value="nodeText(node)" :aria-label="`${node.title || '文本'}内容`" placeholder="直接写，或让 Agent 生成" @pointerdown.stop @input="writeNodeText(node, ($event.target as HTMLTextAreaElement).value)" @blur="persistNodeText(node)" @wheel.stop />
          <span v-else>{{ workspaceDefinition?.capabilities[node.kind]?.label || node.kind }}<template v-if="node.enabled === false"> · 已停用</template></span>
        </div>
        <button v-if="nodeBadge(node).inputCount" type="button" class="canvas-badge canvas-badge-in"
          :aria-label="`输入材料 ${nodeBadge(node).inputCount} 份`" :title="`输入材料 ${nodeBadge(node).inputCount} 份`"
          @pointerdown.stop @click.stop="action(() => selectNodeForPanel(node.id))">
          <span v-for="glyph in nodeBadge(node).inputGlyphs" :key="glyph" aria-hidden="true">{{ glyph }}</span><b>{{ nodeBadge(node).inputCount }}</b>
        </button>
        <button v-if="nodeBadge(node).outputCount" type="button" class="canvas-badge canvas-badge-out"
          :aria-label="`产物 ${nodeBadge(node).outputCount} 份`" :title="`产物 ${nodeBadge(node).outputCount} 份`"
          @pointerdown.stop @click.stop="action(() => selectNodeForPanel(node.id))">
          <span v-for="glyph in nodeBadge(node).outputGlyphs" :key="glyph" aria-hidden="true">{{ glyph }}</span><b>{{ nodeBadge(node).outputCount }}</b>
        </button>
        <button class="canvas-resize-handle" :aria-label="`调整 ${node.title || '流程节点'} 的大小`" @pointerdown.stop="canvas.beginResize($event, node.id)" @keydown="resizeCardWithKeyboard($event, node.id)" />
      </article>
      <div v-if="activeVideo" class="creation-stage canvas-object" :data-canvas-node="activeVideoId" :class="{'canvas-selected':selectedIds.includes(activeVideoId)}" :style="canvas.position(activeVideoId)" @pointerdown="cardPointerDown($event,activeVideo)" @contextmenu="openCardMenu($event,activeVideo)">
        <template v-if="workspaceGraph">
        <button class="workspace-port port-in" :data-card-port="'in'" :data-card-id="activeVideoId" aria-label="输入：控制与材料" title="输入：控制与材料" @pointerdown.stop @click.stop="action(() => connectPort(activeVideoId))"><v-icon icon="mdi-link-variant" size="13"/></button>
        </template>
        <button class="canvas-drag-handle" :aria-label="`移动${activeVideo.title}`" @click="!$event.detail && selectCard(activeVideo)" @keydown="nudgeCard($event,activeVideoId)"><v-icon icon="mdi-video-outline" size="16" />{{ activeVideo.title }}<v-icon icon="mdi-drag" size="16" /></button>
        <div class="preview-stage" data-canvas-card-body>
          <MediaVideoPlayer v-if="canvasVideoUrl(activeVideo)" :key="activeVideo.id" :src="canvasVideoUrl(activeVideo)!" />
          <div v-else class="preview-empty"><v-icon :icon="selected ? 'mdi-movie-open-outline' : 'mdi-play-box-outline'" size="32" /><h2>{{ selected ? snapshot?.states[selected.status]?.label || selected.status : '让想象成为镜头' }}</h2><p>{{ selected?.error || (selected ? '生成结果会出现在这里' : '从一段描述或参考素材开始') }}</p><label v-if="!selected" class="card-upload-button" @pointerdown.stop>上传视频<input type="file" accept="video/mp4" aria-label="上传当前视频素材" :disabled="busy || uploading" @change="uploadCanvasAsset($event,activeVideo)" /></label><VideoGenerationProgress v-if="selected && ['running','queued'].includes(selected.status)" :job="selected" /></div>
        </div>
        <button class="canvas-resize-handle" :aria-label="`调整 ${activeVideo.title} 的大小`" @pointerdown.stop="canvas.beginResize($event, activeVideoId)" @keydown="resizeCardWithKeyboard($event, activeVideoId)" />
        <div v-if="selected" class="result-details"><div class="result-actions"><v-chip size="small" variant="tonal">{{ snapshot?.states[selected.status]?.label || selected.status }}</v-chip><span class="video-hint">{{ selected.width }} × {{ selected.height }} · {{ ((selected.frames || 0)/24).toFixed(2) }} 秒</span><v-spacer /><v-btn v-if="selected.videoUrl" :href="managerResourceUrl(selected.videoUrl)" :download="`${selected.id}.mp4`" variant="outlined" size="small" prepend-icon="mdi-download">下载</v-btn><v-btn variant="text" size="small" @click="copyPrompt(selected)">复制提示词</v-btn><v-btn variant="tonal" size="small" @click="reuse(selected)">复用参数</v-btn><v-btn v-if="selected.status==='queued'" variant="text" size="small" :disabled="busy" @click="cancelSelected">取消排队</v-btn></div><details class="result-prompt"><summary>生成提示词</summary><p class="video-prompt">{{ selected.prompt }}</p></details></div>
      <section v-show="selectedIds.length===1 && selectedIds.includes(activeVideoId)" class="composer" aria-label="视频创作">

        <div class="mode-tabs" role="group" aria-label="生成模式">
          <button v-for="tab in [{id:'text',label:'文生视频'},{id:'image',label:'首尾帧'},{id:'reference',label:'多模态参考'}]" :key="tab.id" :class="{active:mode===tab.id}" :aria-pressed="mode===tab.id" @click="setMode(tab.id)">{{ tab.label }}</button>
        </div>
        <div class="composer-body">
          <div v-if="mode === 'image'" class="frame-pair">
            <div v-for="first in [true,false]" :key="String(first)" class="frame-slot">
              <label class="upload-tile">
                <img v-if="first ? firstFrame : lastFrame" :src="`data:image/png;base64,${first ? firstFrame : lastFrame}`" :alt="first ? '首帧预览' : '尾帧预览'" />
                <v-icon v-else icon="mdi-image-plus-outline" size="28" />
                <strong>{{ first ? '添加首帧' : '添加尾帧' }}</strong>
                <small>{{ first ? frameShapes.first || '图片 · 最大 9 MB' : frameShapes.last || '可选 · 图片' }}</small>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif" :aria-label="first ? '上传首帧' : '上传尾帧'" @change="event => loadImage(event, first)" />
              </label>
              <button v-if="first ? firstFrame : lastFrame" class="text-action" @click="clearImage(first)">移除{{ first ? '首帧' : '尾帧' }}</button>
            </div>
          </div>
          <v-btn v-if="mode==='image' && firstFrame && lastFrame" variant="text" size="small" prepend-icon="mdi-swap-horizontal" @click="swapFrames">交换首尾帧</v-btn>
          <section v-if="mode==='reference'" class="reference-section" aria-label="参考素材">
            <div class="reference-add">
              <label v-for="kind in referenceKinds" :key="kind.id" class="reference-upload"><v-icon :icon="kind.icon" size="20" />{{ kind.label }}<input type="file" :accept="kind.accept" multiple :disabled="uploading" :aria-label="`添加${kind.label}`" @change="event => uploadReferences(event, kind.id)" /></label>
            </div>
            <details class="asset-help"><summary>素材要求</summary><p class="video-hint">图片最多 9 张 PNG，每张 9 MB；视频最多 3 段 24 FPS、2–15 秒 MP4，每段 64 MB；音频最多 3 段不超过 15 秒的 WAV，每段 16 MB。</p></details>
            <v-progress-linear v-if="uploading" indeterminate color="primary" />
            <div class="reference-grid">
            <article v-for="(asset,index) in references" :key="asset.id" class="reference-card" :class="{wide:asset.kind!=='image'}">
              <img v-if="asset.kind==='image'" :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" :alt="referenceLabel(asset)" />
              <video v-else-if="asset.kind==='video'" :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" controls preload="metadata" />
              <audio v-else :src="managerResourceUrl(`/api/video/assets/${asset.id}`)" controls preload="metadata" />
              <div class="reference-caption"><button class="text-action" @click="prompt += ` ${referenceLabel(asset)} `">{{ referenceLabel(asset) }} ↗</button><span>{{ asset.duration ? `${asset.duration.toFixed(1)} 秒` : `${asset.width}×${asset.height}` }}</span><button class="text-action" :aria-label="`移除${referenceLabel(asset)}`" @click="removeReference(index)">移除</button></div>
              <button v-if="asset.kind==='video' && asset.hasAudio && referenceVideoSound" class="text-action" @click="prompt += ` ${videoSoundLabel(asset)} `">原声 {{ videoSoundLabel(asset) }} ↗</button>
            </article>
            </div>
            <v-checkbox v-if="references.some(a=>a.kind==='video' && a.hasAudio)" :model-value="referenceVideoSound" label="使用参考视频的原声" hide-details density="compact" @update:model-value="setVideoSound" />
          </section>
          <div v-if="contentRefs.get(activeVideo.id)?.length" class="canvas-reference-chips" aria-label="来自上游的文本">
            <button v-for="source in contentRefs.get(activeVideo.id)" :key="source.id" :title="source.text" :aria-label="`移除来自${source.title}的输入`" @click="action(() => removeContentLink(source.id, activeVideoId))">{{source.title}} ×</button>
          </div>
          <v-textarea v-model="prompt" label="描述你想生成的画面" :placeholder="mode==='text' ? '主体、动作、场景与镜头运动…' : '描述素材如何参与生成，以及想要的动作和镜头…'" rows="3" max-rows="5" auto-grow variant="plain" :maxlength="12000" hide-details />

        </div>
        <div class="composer-toolbar">
          <span class="image-mode-label"><v-icon icon="mdi-video-outline" size="15" />视频生成</span>
          <ComputerModelPicker compact label="选择视频模型" :open="openPopover==='video-model'"
            @update:open="updatePopover('video-model',$event)" :device-id="serviceDeviceId" :computers="computers"
            :model-id="model" :model-label="availableModels.find(row => row.id === model)?.label" :disabled="serviceBusy"
            :load-models="(device, signal) => loadModelOptions('video', device, signal)"
            :choose="(device, id) => chooseMediaModel(undefined, device, id)" />
          <v-menu :model-value="openPopover==='video-format'" @update:model-value="updatePopover('video-format',$event)" :close-on-content-click="false" location="top" offset="8" max-width="400">
            <template #activator="{ props }"><button v-bind="props" class="media-picker" aria-label="视频参数"><v-icon icon="mdi-rectangle-outline" size="16" />{{ selectedRatio?.label || `${width}×${height}` }} / {{ duration }}s / {{ selectedResolution?.label || '自定义' }}<v-icon icon="mdi-chevron-down" size="16" /></button></template>
            <v-card class="parameter-popover"><v-card-text>
          <div class="duration-control">
            <div class="field-label"><span>时长</span><output>{{ duration }} 秒</output></div>
            <v-slider v-model="frames" :min="22" :max="260" :step="17" aria-label="视频时长" :aria-valuetext="`${duration} 秒`" color="white" track-color="grey-darken-2" thumb-size="14" hide-details thumb-label><template #thumb-label="{ modelValue }">{{ (modelValue / 24).toFixed(2) }} 秒</template></v-slider>
            <div class="duration-bounds"><span>0.92 秒</span><span>10.83 秒</span></div>
          </div>
          <div><div class="field-label">比例 <span>{{ width }} × {{ height }}</span></div><div class="ratio-options"><button v-for="ratio in ratios" :key="ratio.label" :class="{active:selectedRatio?.label===ratio.label}" :aria-pressed="selectedRatio?.label===ratio.label" @click="applyRatio(ratio)"><span class="ratio-shape" :style="{aspectRatio:`${ratio.width}/${ratio.height}`}" />{{ ratio.label }}</button></div></div>
          <div class="resolution-control">
            <div class="field-label"><span>清晰度</span><span>{{ selectedResolution?.label || '自定义' }}</span></div>
            <div class="resolution-options"><button v-for="item in resolutions" :key="item.edge" :class="{active:selectedResolution?.edge===item.edge}" :aria-pressed="selectedResolution?.edge===item.edge" :disabled="!resolutionAllowed(item.edge)" @click="applyResolution(item.edge)">{{ item.label }}</button></div>

          </div>

            </v-card-text></v-card>
          </v-menu>
          <v-btn size="small" variant="text" :prepend-icon="generateAudio ? 'mdi-volume-high' : 'mdi-volume-off'" :aria-pressed="generateAudio" @click="generateAudio=!generateAudio">{{ generateAudio ? '生成声音' : '无声' }}</v-btn>
          <v-btn size="small" variant="text" :aria-pressed="quickGeneration" :disabled="!selectedWorkflow" prepend-icon="mdi-lightning-bolt" @click="quickGeneration=!quickGeneration">{{ quickGeneration ? '快速' : '标准' }}</v-btn>
          <v-btn class="generate-button" size="small" color="white" icon="mdi-arrow-up" aria-label="生成视频" :disabled="busy || uploading || !videoInputPrompt.trim() || !!inputProblem" :loading="busy" @click="action(submit)" />
        </div>
        <div class="generate-feedback" role="status"><p v-if="inputProblem" class="input-warning">{{ inputProblem }}</p><p v-else-if="!videoInputPrompt.trim()" class="video-hint">写下提示词，开始创作。</p><p v-else-if="snapshot && !snapshot.online" class="video-hint">提交时会启动所选电脑的生成服务。</p><p v-else-if="mode === 'image'" class="video-hint">自动适配至 {{ width }}×{{ height }} · 等比缩放，必要时补黑边，保留完整画面。</p></div>
      </section>
      </div>
        <div v-if="selectedWorkflowNode" class="composer workflow-node-parameters" role="dialog"
          :aria-label="`${selectedWorkflowNode.title || '节点'}参数`" :style="parameterPanelStyle" @pointerdown.stop @contextmenu.stop @wheel.stop>
          <header class="workflow-parameters-head">
            <strong>{{ selectedWorkflowNode.title || workspaceDefinition?.capabilities[selectedWorkflowNode.kind]?.label || selectedWorkflowNode.kind }}</strong>
            <span v-if="selectedWorkflowNode.approval === true" class="workflow-parameters-flag">需人工确认</span>
            <span v-if="selectedWorkflowNode.enabled === false" class="workflow-parameters-flag muted">已停用</span>
            <button type="button" class="workflow-parameters-close" aria-label="关闭参数面板" @click="selectedIds=[]">关闭</button>
          </header>
          <div class="workflow-parameters-scroll">
            <WorkbenchPanel :key="projectId + ':' + mediaCanvasId + ':' + parameterNodeId" mode="node" @cli-settings="showCliSettings=true" :project-id="projectId" :canvas-id="mediaCanvasId"
              :node-id="parameterNodeId" :material-inputs="selectedWorkflowNode.inputs" :commit="saveInspectorDraft" :prepare-run="prepareNodeRun" :save-result="saveNodeResult" :content-count="contentRefs.get(parameterNodeId)?.length">
              <template #references>
                <div v-if="pendingInput && pendingInput.to === parameterNodeId" class="canvas-reference-chips" role="group" aria-label="选择上游材料">
                  <button v-for="key in pendingInput.keys" :key="key" @click="action(() => confirmPendingInput(key))">{{ key }}</button>
                  <button @click="pendingInput=undefined">取消</button>
                </div>
                <ul v-if="mergedInputsByTarget.get(parameterNodeId)?.length" class="canvas-input-list" aria-label="输入材料">
                  <li v-for="row in mergedInputsByTarget.get(parameterNodeId)" :key="row.from">
                    <span class="canvas-input-glyph" aria-hidden="true">{{ row.artifactKinds.map(kind => artifactGlyph(kind)).join(" ") }}</span>
                    <span class="canvas-input-name" :title="row.title">{{ row.title }}</span>
                    <button type="button" class="canvas-input-action" :aria-label="`定位上游节点 ${row.title}`" title="定位到源节点" @click="action(() => focusInputSourceAction(row.from))">↗</button>
                    <button type="button" class="canvas-input-action" :aria-label="`移除来自 ${row.title} 的输入`" title="移除" @click="action(() => removeMergedInputAction(row, parameterNodeId))">×</button>
                  </li>
                </ul>
                <details v-if="nodeArtifacts.length" class="canvas-node-artifacts" open>
                  <summary>已核验产物（{{ nodeArtifacts.length }}）</summary>
                  <a v-for="artifact in nodeArtifacts" :key="artifact.id" :href="managerResourceUrl(artifact.href)" :title="artifact.path" target="_blank" rel="noopener noreferrer">
                    <v-icon icon="mdi-file-outline" size="16" aria-hidden="true"/><span>{{ artifact.name }}</span>
                    <v-icon icon="mdi-open-in-new" size="14" aria-hidden="true"/>
                  </a>
                </details>
              </template>
            </WorkbenchPanel>
          </div>
        </div>
      </div>
      <div v-if="toolbarNode" class="canvas-toolbar" role="toolbar" :aria-label="`${toolbarNode.title || '节点'}工具`" :style="toolbarStyle" @pointerdown.stop @click.stop>
        <template v-if="toolbarNode.config.textOutput === true">
          <button type="button" aria-label="缩小字号" title="缩小字号" @click="action(async () => stepTextSize(toolbarNode!, -1))">A-</button>
          <button type="button" aria-label="放大字号" title="放大字号" @click="action(async () => stepTextSize(toolbarNode!, 1))">A+</button>
        </template>
        <button type="button" aria-label="编辑内容" title="编辑内容" @click="action(() => openNodeEditor(toolbarNode!))">编辑</button>
        <button type="button" aria-label="下载内容" title="下载内容" @click="action(() => downloadNodeContent(toolbarNode!))">下载</button>
      </div>
      <div v-if="nodeEditorNode" class="canvas-editor-backdrop" @pointerdown.self="closeNodeEditor">
        <section class="canvas-editor" role="dialog" aria-modal="true" :aria-label="`${nodeEditorNode.title || '节点'}内容`" @pointerdown.stop>
          <header>
            <strong>{{ nodeEditorNode.title || nodeEditorNode.id }}</strong>
            <span class="canvas-editor-size">{{ nodeEditorSize }}px</span>
            <button type="button" aria-label="缩小字号" @click="nodeEditorSize = Math.max(11, nodeEditorSize - 1)">A-</button>
            <button type="button" aria-label="放大字号" @click="nodeEditorSize = Math.min(34, nodeEditorSize + 1)">A+</button>
            <button type="button" aria-label="保存内容" @click="action(saveNodeEditor)">保存</button>
            <button type="button" aria-label="关闭内容窗口" @click="closeNodeEditor">关闭</button>
          </header>
          <textarea v-model="nodeEditorDraft" :style="{ fontSize: `${nodeEditorSize}px` }" :aria-label="`${nodeEditorNode.title || '节点'}全文`" />
        </section>
      </div>
      <aside v-if="showLibrary" id="video-history-panel" class="output-library" aria-label="我的作品">
        <div class="library-toolbar"><h2>我的作品 <span>{{ snapshot?.jobs.length || 0 }}</span></h2><v-btn icon="mdi-close" variant="text" size="small" aria-label="关闭作品历史" @click="showLibrary=false" /><v-btn variant="text" size="small" prepend-icon="mdi-refresh" :disabled="busy" @click="refresh(true)">刷新</v-btn></div>
        <div class="library-filters"><v-select v-model="filter" :items="[{title:'全部',value:'all'},{title:'进行中',value:'pending'},{title:'已完成',value:'succeeded'},{title:'失败',value:'failed'}]" label="状态" hide-details density="compact" variant="outlined" /><v-text-field v-model="search" label="搜索提示词" prepend-inner-icon="mdi-magnify" hide-details density="compact" variant="outlined" clearable /></div>
        <p v-if="!filteredJobs.length" class="library-empty">{{ snapshot?.jobs.length ? '没有匹配的作品' : '生成的视频将保存在这里' }}</p>
        <div class="video-library"><button v-for="job in filteredJobs" :key="job.id" class="work-card" :class="{selected: selected?.id===job.id}" :aria-pressed="selected?.id===job.id" @click="addJobToCanvas(job)"><div class="work-thumbnail"><img v-if="job.imageUrl" :src="managerResourceUrl(job.imageUrl)" alt="生成图片" /><video v-else-if="job.videoUrl" :src="managerResourceUrl(job.videoUrl)" muted preload="metadata" tabindex="-1" /><v-icon v-else icon="mdi-movie-open-outline" size="30" /><span class="work-status">{{ snapshot?.states[job.status]?.label || job.status }}</span></div><p>{{ job.prompt }}</p><time>{{ new Date(job.createdAt).toLocaleString() }}</time></button></div>
      </aside>
      <div v-if="contextMenu" class="canvas-menu" role="menu" aria-label="画布右键菜单" :style="{left:contextMenu.x+'px',top:contextMenu.y+'px'}" @pointerdown.stop>
        <template v-if="contextMenu.itemId">
          <button role="menuitem" :disabled="busy || uploading" @click="duplicateCard(false)"><v-icon icon="mdi-content-copy" size="17" />复制节点</button>
          <button role="menuitem" :disabled="busy || uploading" @click="duplicateCard(true)"><v-icon icon="mdi-content-duplicate" size="17" />克隆空节点</button>
          <button role="menuitem" @click="exportCard"><v-icon icon="mdi-export-variant" size="17" />导出节点参数</button>
          <hr /><button role="menuitem" class="delete-node" :disabled="busy || uploading" @click="deleteCard"><v-icon icon="mdi-trash-can-outline" size="17" />删除节点</button>
        </template>
        <template v-else>
        <button role="menuitem" :disabled="busy || uploading" @click="action(() => addWorkflowCard('text'))"><v-icon icon="mdi-format-text" size="17" />文本</button>
        <button v-for="entry in mediaCanvasKinds" :key="entry.kind" role="menuitem" :disabled="busy || uploading" @click="addCanvasItem(entry.kind)"><v-icon :icon="entry.icon" size="17" />{{ entry.label }}</button>
        <button role="menuitem" :disabled="busy || uploading" @click="action(() => addWorkflowCard('agent'))"><v-icon icon="mdi-robot-outline" size="17" />Agent</button>
        <button role="menuitem" :disabled="busy || uploading" @click="action(() => addWorkflowCard('rehearsal'))"><v-icon icon="mdi-play-circle-outline" size="17" />预演台</button>
        <hr />
        <button role="menuitem" class="menu-group-toggle" :aria-expanded="showPipelineNodes" @click.stop="showPipelineNodes = !showPipelineNodes">
          <v-icon icon="mdi-tune-variant" size="17" />自动化节点<v-icon :icon="showPipelineNodes ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="15" class="menu-caret" />
        </button>
        <template v-if="showPipelineNodes">
          <button v-for="entry in pipelineNodeKinds" :key="entry.kind" role="menuitem" :disabled="busy || uploading" @click="action(() => addWorkflowCard(entry.kind))">添加{{ entry.label }}节点</button>
        </template>
        <hr />
        <button role="menuitem" @click="canvas.fit(); contextMenu=undefined"><v-icon icon="mdi-fit-to-screen-outline" size="17" />适应屏幕</button>
        <button role="menuitem" :disabled="busy || uploading" @click="action(pasteNodes)"><v-icon icon="mdi-content-paste" size="17" />粘贴</button>
        <button role="menuitem" @click="contextMenu=undefined"><label class="menu-upload">上传<input type="file" multiple aria-label="上传材料" @click.stop @change="uploadFromMenu($event)" /></label></button>
        </template>
      </div>
      <aside class="canvas-minimap" aria-label="画布小地图" @pointerdown.stop @contextmenu.stop @wheel.stop>
        <button class="minimap-toggle" :aria-expanded="minimapOpen" aria-controls="canvas-minimap-map" @click="minimapOpen=!minimapOpen"><span>小地图</span><span>{{ minimapOpen ? '−' : '+' }}</span></button>
        <svg v-if="minimapOpen" id="canvas-minimap-map" viewBox="0 0 180 110" role="img" aria-label="点击或拖动小地图移动视野" @pointerdown="beginMinimap" @pointermove="moveMinimap" @pointerup="endMinimap" @pointercancel="endMinimap" @lostpointercapture="endMinimap">
          <rect v-bind="minimap.view" class="minimap-viewport" />
          <path :d="minimapShapes.unselected" class="minimap-card" />
          <path :d="minimapShapes.selected" class="minimap-selected" />
        </svg>
      </aside>
      <nav class="canvas-tools" aria-label="画布视图">
        <button :class="{active:!canPan}" :aria-pressed="!canPan" aria-label="选择模式" @click="handMode=false"><v-icon icon="mdi-cursor-default-outline" size="20" /></button>
        <button :class="{active:canPan}" :aria-pressed="canPan" aria-label="拖动画布模式" title="按住空格临时平移" @click="handMode=true"><v-icon icon="mdi-hand-back-right-outline" size="20" /></button>
        <span class="tool-divider" /><button aria-label="缩小画布" @click="canvas.zoom(scale/1.2)">−</button>
        <button class="zoom-label" aria-label="复位画布视图" @click="resetCanvasView">{{ Math.round(scale*100) }}%</button>
        <button aria-label="放大画布" @click="canvas.zoom(scale*1.2)">+</button>
        <button aria-label="适应画布" @click="canvas.fit"><v-icon icon="mdi-fit-to-screen-outline" size="20" /></button>
        <span class="tool-divider" />
        <button :disabled="!canUndo" aria-label="撤销布局调整" title="撤销布局调整 (Ctrl+Z)" @click="restoreCanvasLayout(true)"><v-icon icon="mdi-undo" size="20" /></button>
        <button :disabled="!canRedo" aria-label="重做布局调整" title="重做布局调整 (Ctrl+Shift+Z)" @click="restoreCanvasLayout(false)"><v-icon icon="mdi-redo" size="20" /></button>
      </nav>
    </div>
    <v-snackbar v-model="noticeVisible" timeout="4000">{{ notice }}</v-snackbar>
  </div>
    </PeerServerSelect>
  </v-theme-provider>
</template>

<style scoped>
.video-page { --rr-primary:var(--rr-accent); --rr-panel:var(--rr-surface); position:relative; width:100%; height:var(--rr-content-height, calc(100dvh - var(--v-layout-top, 0px))); min-height:540px; margin:0; padding:0; color:var(--rr-text); background:var(--rr-canvas) !important; overflow:hidden; color-scheme:inherit; }
.video-heading { display:flex; align-items:center; gap:16px; margin-bottom:20px; }
.video-heading>div:first-child { margin-right:auto; }
.video-heading h1 { font-size:24px; }
.video-heading span,.video-hint,small,time { color:var(--rr-muted); }
.workflow-dialog-content { padding:0 !important; }
/* P0-2：参数面板是画布内独立浮层，只由内容和拖拽决定卡片尺寸。 */
/* Later `.composer { width:100% }` has the same specificity, so the panel rule
   must outrank it by class count rather than by source order. */
.composer.workflow-node-parameters { position:absolute; z-index:6; width:320px; max-height:76vh; margin-top:0; display:flex; flex-direction:column; }
.workflow-parameters-head { display:flex; align-items:center; gap:8px; padding:9px 10px 2px 12px; }
.workflow-parameters-head strong { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.workflow-parameters-flag { flex-shrink:0; padding:1px 7px; border-radius:10px; background:var(--rr-accent-surface); color:var(--rr-heading); font-size:11px; }
.workflow-parameters-flag.muted { background:var(--rr-subtle); color:var(--rr-muted); }
.workflow-parameters-close { margin-left:auto; flex-shrink:0; padding:4px 8px; border-radius:8px; color:var(--rr-muted); font-size:12px; }
.workflow-parameters-close:is(:hover,:focus-visible) { color:var(--rr-text); background:var(--rr-subtle); }
.workflow-parameters-scroll { flex:1; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:6px 12px 12px; }
.canvas-wire-hint { position:absolute; z-index:5; transform:translate(-50%,-50%); padding:2px 8px; border-radius:10px; border:1px solid var(--rr-border-strong); background:var(--rr-surface); color:var(--rr-heading); font-size:11px; white-space:nowrap; pointer-events:none; }
.canvas-wire-hint.kind-input { border-color:var(--rr-success-border); color:var(--rr-success-text); }
/* §7.3：连线中点显示条件徽章，点击切换 完成/成功。 */
.canvas-edge-badge { position:absolute; z-index:5; transform:translate(-50%,-50%); padding:1px 7px; border-radius:9px; border:1px solid var(--rr-border-strong); background:var(--rr-surface-glass); color:var(--rr-muted); font-size:10px; line-height:1.6; white-space:nowrap; }
.canvas-edge-badge.condition-completed { border-color:var(--rr-warning-border); color:var(--rr-warning-text); }
.canvas-edge-badge:is(:hover,:focus-visible) { color:var(--rr-heading); border-color:var(--rr-accent); }
/* §2.3：左下角输入材料、右下角产物。半透明底衬，避开右下角尺寸把手。 */
.canvas-badge { position:absolute; bottom:6px; z-index:4; display:inline-flex; align-items:center; gap:4px; padding:1px 7px; border-radius:10px; border:1px solid var(--rr-border); background:var(--rr-surface-glass); color:var(--rr-muted); font-size:11px; line-height:1.5; }
.canvas-badge-in { left:8px; border-color:var(--rr-success-border); color:var(--rr-success-text); }
.canvas-badge-out { right:26px; }
.canvas-badge b { font-weight:600; }
.canvas-badge:is(:hover,:focus-visible) { color:var(--rr-heading); border-color:var(--rr-accent); }
/* §5.3：一套「输入材料」列表，每行 源节点名 + 产物图标 + ↗ 定位 + × 移除。 */
.canvas-input-list { display:flex; flex-direction:column; gap:2px; margin:0 0 10px; padding:0; list-style:none; }
.canvas-input-list > li { display:flex; align-items:center; gap:8px; padding:4px 6px; border-radius:8px; background:var(--rr-subtle); font-size:12px; }
.canvas-input-list > li:hover { background:var(--rr-surface-raised,var(--rr-subtle)); }
.canvas-input-glyph { flex-shrink:0; color:var(--rr-success-text); letter-spacing:2px; }
.canvas-input-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--rr-text); }
.canvas-input-action { flex-shrink:0; width:20px; height:20px; border-radius:6px; color:var(--rr-muted); }
.canvas-input-action:is(:hover,:focus-visible) { color:var(--rr-accent); background:var(--rr-surface); }
/* §5.2：工具条是画布浮层，浮在卡片上方 8px，不进卡片内部。 */
.canvas-toolbar { position:absolute; z-index:7; display:flex; gap:2px; padding:3px; border:1px solid var(--rr-border); border-radius:999px; background:var(--rr-surface-glass); box-shadow:var(--rr-shadow-menu); }
.canvas-toolbar button { padding:3px 9px; border-radius:999px; color:var(--rr-muted); font-size:12px; line-height:1.4; }
.canvas-toolbar button:is(:hover,:focus-visible) { color:var(--rr-heading); background:var(--rr-subtle); }
/* §1.1：内容窗口是画布级覆盖层，编辑全文后写回节点自身。 */
.canvas-editor-backdrop { position:absolute; inset:0; z-index:20; display:grid; place-items:center; background:rgba(0,0,0,.42); }
.canvas-editor { display:flex; flex-direction:column; width:min(760px,calc(100% - 48px)); max-height:calc(100% - 80px); border:1px solid var(--rr-border-strong); border-radius:14px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); overflow:hidden; }
.canvas-editor > header { display:flex; align-items:center; gap:6px; padding:10px 12px; border-bottom:1px solid var(--rr-border); }
.canvas-editor > header strong { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.canvas-editor-size { color:var(--rr-muted); font-size:11px; }
.canvas-editor > header button { padding:4px 9px; border-radius:8px; color:var(--rr-muted); font-size:12px; }
.canvas-editor > header button:is(:hover,:focus-visible) { color:var(--rr-heading); background:var(--rr-subtle); }
.canvas-editor textarea { flex:1; min-height:320px; max-height:60vh; padding:14px 16px; border:0; outline:none; resize:none; background:transparent; color:var(--rr-text); font-family:inherit; line-height:1.7; }
.workspace-flow-wires { position:absolute; width:1px; height:1px; overflow:visible; pointer-events:none; }
.workspace-flow-wires path { fill:none; stroke:var(--rr-accent); stroke-width:1.5; opacity:.72; pointer-events:none; }
.workspace-flow-wires .connection-hit { stroke:transparent; stroke-width:12; pointer-events:stroke; cursor:pointer; }
/* P0-3：控制边灰实线，材料边绿虚线，选中时按类型分别高亮。 */
.workspace-flow-wires .control-connection { stroke:var(--rr-muted); stroke-width:1.5; opacity:.78; }
.workspace-flow-wires .material-connection { stroke:var(--rr-success-text); stroke-width:2; stroke-dasharray:6 4; opacity:.85; }
.workspace-flow-wires path.related-connection,.flow-connection:hover > .connection-line { opacity:1; }
.workspace-flow-wires .related-connection.control-connection { stroke:var(--rr-heading); stroke-width:2; }
.workspace-flow-wires .related-connection.material-connection { stroke:var(--rr-success-text); stroke-width:2.75; stroke-dasharray:9 4; }
.workspace-flow-wires .processing-connection { stroke:var(--rr-accent); opacity:1; stroke-dasharray:16 8; animation:input-flow 900ms linear infinite; }
@keyframes input-flow { to { stroke-dashoffset:-24; } }
@media (prefers-reduced-motion: reduce) { .workspace-flow-wires .processing-connection { animation:none; } }
/* A completed condition must not turn a control edge dashed: dashing is the
   material signal. Control edges stay solid and only shift weight. */
.workspace-flow-wires .completed-connection.material-connection { stroke-dasharray:9 4; }
.workspace-flow-wires .completed-connection.control-connection { stroke-dasharray:none; stroke-width:1.75; }
.workspace-flow-wires .preview-connection { opacity:1; pointer-events:none; }
/* P0-1：每张卡只有一个输入口和一个输出口，位置不随节点类型变化。 */
.workspace-port { position:absolute; top:var(--canvas-port,72px); z-index:3; display:grid; place-items:center; width:22px; height:22px; transform:translateY(-50%); border:1px solid var(--rr-muted); border-radius:50%; background:var(--rr-surface); color:var(--rr-text); line-height:1; cursor:crosshair; }
.workspace-port { opacity:0; transition:opacity 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease; }
.canvas-object:hover > .workspace-port,.canvas-selected > .workspace-port,.workspace-port:focus-visible,
.linking-port .workspace-port.port-in { opacity:1; }
.linking-port .workspace-port.port-in { border-color:var(--rr-success-border); color:var(--rr-success-text); box-shadow:0 0 0 3px var(--rr-success-surface); }
.creative-card .workflow-card-body { display:block; padding:0; }
.canvas-object :is(.canvas-video-card,.canvas-media-card,.canvas-text-card,.preview-stage) { cursor:grab; }
.canvas-dragging .canvas-object :is(.canvas-video-card,.canvas-media-card,.canvas-text-card,.preview-stage) { cursor:grabbing; }
.preview-stage :deep(.media-video-player video) { cursor:grab; }
.canvas-dragging .preview-stage :deep(.media-video-player video) { cursor:grabbing; }
.creative-card .node-text-preview { overflow:auto; user-select:text; }
.creative-card .node-text-preview.muted { color:var(--rr-muted); }
.creative-card .node-text-editor { width:100%; resize:none; border:0; outline:none; background:transparent; font:inherit; user-select:text; }
.creative-card .node-text-editor::placeholder { color:var(--rr-muted); }
.workspace-port.port-in { left:-11px; }
.workspace-port.port-out { right:-11px; }
.creation-stage .workspace-port.port-in { left:119px; }
.workspace-port:hover,.workspace-port:focus-visible { border-color:var(--rr-accent); color:var(--rr-accent); }
.canvas-reference-chips { display:flex; flex-wrap:wrap; gap:6px; margin:0 0 10px; }
.canvas-reference-chips button { border:1px solid var(--rr-border); border-radius:20px; padding:3px 9px; color:var(--rr-muted); font-size:12px; }
.canvas-reference-chips button:is(:hover,:focus-visible) { color:var(--rr-text); border-color:var(--rr-accent); }
.canvas-source-chip { display:inline-flex; border:1px solid var(--rr-border); border-radius:20px; }
.canvas-source-chip > button { border:0; }
.canvas-source-chip > button + button { padding-left:0; }
.canvas-resize-handle { position:absolute; top:calc(14px + var(--canvas-card-height,var(--canvas-default-height,214px))); right:4px; z-index:4; width:20px; height:20px; color:var(--rr-muted); cursor:nwse-resize; touch-action:none; opacity:0; }
.canvas-resize-handle::after { content:""; position:absolute; bottom:4px; right:4px; width:8px; height:8px; border-right:1px solid currentColor; border-bottom:1px solid currentColor; }
.canvas-object:is(:hover,.canvas-selected) > .canvas-resize-handle,.canvas-resize-handle:focus-visible { opacity:1; }
.canvas-resize-handle:is(:hover,:focus-visible) { color:var(--rr-accent); }
.creation-stage .canvas-resize-handle { right:134px; }
.workflow-card:not(.creative-card) { --canvas-default-height:76px; }
.workflow-card { width:380px; min-height:144px; }
.workflow-card-body { position:relative; display:flex; align-items:flex-start; min-height:76px; height:var(--canvas-card-height,auto); padding:16px; font-size:13px; color:var(--rr-muted); cursor:grab; }
.workflow-card-processing .workflow-card-body { border-color:var(--rr-accent); }
.canvas-node-artifacts { margin:0 0 12px; }
.canvas-node-artifacts summary { color:var(--rr-muted); cursor:pointer; font-size:12px; }
.canvas-node-artifacts a { display:flex; align-items:center; gap:8px; padding:7px 8px; border-radius:6px; color:var(--rr-text); text-decoration:none; }
.canvas-node-artifacts a:hover,.canvas-node-artifacts a:focus-visible { background:var(--rr-surface-raised,var(--rr-surface)); color:var(--rr-accent); }
.canvas-node-artifacts a span { flex:1; overflow-wrap:anywhere; }
.node-run-badge { position:absolute; right:10px; top:8px; padding:2px 7px; border-radius:10px; background:var(--rr-surface); color:var(--rr-heading); font-size:11px; pointer-events:none; }
/* P0-4：停用是状态，不是类型。虚线边框 + 降透明度 + 标题划线，运行时由 run 跳过。 */
.workflow-card-disabled { opacity:.62; outline:1px dashed var(--rr-border-strong); outline-offset:-1px; }
.workflow-card-disabled .canvas-drag-handle { text-decoration:line-through; }
.video-workspace { position:absolute; inset:0; overflow:clip; touch-action:none; background-image:radial-gradient(var(--rr-grid-line) .8px,transparent .8px); background-size:24px 24px; }
.video-workspace:focus { outline:none; }
.creation-stage { position:absolute; width:calc(var(--canvas-card-width,380px) + 260px); display:flex; flex-direction:column; align-items:center; }
.preview-stage { flex-shrink:0; width:var(--canvas-card-width,380px); height:var(--canvas-card-height,214px); background:var(--rr-surface); border:1px solid var(--rr-border-strong); border-radius:10px; overflow:hidden; display:flex; align-items:center; justify-content:center; color:var(--rr-text); box-shadow:var(--rr-shadow-card); }
.preview-empty { text-align:center; max-width:80%; color:var(--rr-muted); }
.preview-empty h2 { font-size:14px; margin:12px 0 8px; color:var(--rr-heading); font-weight:500; }
.preview-empty p { font-size:12px; margin-bottom:12px; }
.result-details { width:100%; padding:10px 6px 0; }
.result-actions { display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:2px; opacity:.8; }
.result-prompt { margin-top:8px; font-size:12px; }
summary { cursor:pointer; }
.video-prompt { white-space:pre-wrap; overflow-wrap:anywhere; font-size:14px; line-height:1.7; margin-top:8px; max-height:140px; overflow:auto; }
.composer { width:100%; margin-top:14px; border:1px solid var(--rr-border); border-radius:18px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); }
.mode-tabs { display:flex; padding:10px 12px 0; gap:6px; }
.mode-tabs button { padding:8px 12px; border:1px solid var(--rr-accent-surface); border-radius:9px; font-size:12px; color:var(--rr-muted); }
.active { background:var(--rr-accent-surface); color:var(--rr-heading) !important; box-shadow:inset 0 0 0 1px var(--rr-accent-border); }
.composer-body { padding:10px 14px 4px; display:grid; grid-template-columns:minmax(0,1fr); gap:8px; }
.composer-toolbar { display:flex; align-items:center; gap:2px; flex-wrap:wrap; padding:8px 10px 10px; }
.model-picker { min-width:0; max-width:100%; }
.generate-button { margin-left:auto; flex-shrink:0; }
.generate-feedback { padding:0 16px; }
.video-hint,.input-warning { font-size:12px; line-height:1.6; margin:0 0 12px; }
.input-warning { color:var(--rr-text); }
.parameter-popover { width:min(330px,calc(100vw - 24px)); border:1px solid var(--rr-border); border-radius:24px !important; background:var(--rr-surface) !important; box-shadow:var(--rr-shadow-menu); }
.parameter-popover :deep(.v-card-title) { font-size:14px; padding:14px 16px 4px; }
.parameter-popover :deep(.v-card-text) { display:grid; gap:14px; padding:14px 9px 9px; }
.field-label { display:flex; justify-content:space-between; font-size:13px; margin-bottom:10px; }
.field-label span { color:var(--rr-muted); }
.duration-bounds { display:flex; justify-content:space-between; color:var(--rr-muted); font-size:11px; }
.resolution-options { display:flex; gap:2px; padding:4px; background:var(--rr-subtle); border-radius:12px; }
.resolution-options button { flex:1; min-height:30px; border:0; border-radius:8px; color:var(--rr-muted); font-size:12px; }
.resolution-options button:disabled { opacity:.35; cursor:not-allowed; }
.resolution-hint { color:var(--rr-muted); font-size:11px; line-height:1.6; margin:8px 0 0; }
.ratio-options { display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:2px; padding:4px; background:var(--rr-subtle); border-radius:14px; }
.ratio-options button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border:0; border-radius:8px; min-height:54px; font-size:10px; color:var(--rr-muted); }
.ratio-shape { display:inline-block; height:12px; border:1px solid currentColor; border-radius:2px; }
.advanced summary { font-size:14px; padding:8px 0; }
.video-parameters { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px; }
.frame-pair { display:grid; grid-template-columns:repeat(2,minmax(0,128px)); gap:8px; }
.upload-tile { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; min-height:80px; border:1px dashed var(--rr-border-strong); border-radius:9px; overflow:hidden; cursor:pointer; }
.upload-tile img { width:100%; height:72px; object-fit:contain; }
.upload-tile strong { font-size:13px; }
.upload-tile small { font-size:12px; padding-bottom:8px; }
.upload-tile input,.reference-upload input { position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer; }
.upload-tile:focus-within,.reference-upload:focus-within,button:focus-visible,summary:focus-visible { outline:2px solid var(--rr-primary); outline-offset:3px; }
.text-action { font-size:12px; padding:8px 2px; min-height:36px; text-decoration:underline; }
.reference-add { display:flex; gap:8px; }
.reference-upload { position:relative; display:flex; align-items:center; justify-content:center; gap:6px; border:1px dashed var(--rr-border-strong); border-radius:8px; min-width:72px; min-height:42px; font-size:12px; }
.asset-help { font-size:12px; color:var(--rr-muted); margin:8px 0; }
.asset-help p { margin-top:8px; }
.reference-grid { display:flex; gap:10px; overflow-x:auto; padding:4px 2px; }
.reference-card { flex:0 0 140px; min-width:0; border:1px solid var(--rr-border); border-radius:9px; padding:6px; }
.reference-card.wide { flex-basis:240px; }
.reference-card img,.reference-card video { width:100%; height:80px; object-fit:contain; background:var(--rr-subtle); border-radius:6px; }
.reference-card audio { width:100%; height:80px; }
.reference-caption { display:flex; justify-content:space-between; align-items:center; gap:4px; flex-wrap:wrap; font-size:11px; }
.output-library { position:absolute; top:14px; left:72px; bottom:16px; z-index:5; width:min(310px,calc(100% - 88px)); padding:18px; background:var(--rr-surface); border:1px solid var(--rr-border); border-radius:18px; box-shadow:var(--rr-shadow-menu); display:flex; flex-direction:column; min-height:0; }
.library-toolbar { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; }
.library-toolbar h2 { font-size:17px; }
.library-toolbar h2 span { font-size:12px; color:var(--rr-muted); margin-left:8px; }
.library-filters { display:grid; gap:12px; margin-bottom:16px; }
.video-library { display:grid; gap:12px; overflow-y:auto; padding:2px; min-height:0; }
.work-card { min-width:0; text-align:left; border:1px solid var(--rr-border); border-radius:12px; overflow:hidden; padding-bottom:12px; }
.work-card.selected { border-color:var(--rr-primary); box-shadow:0 0 0 1px var(--rr-primary); }
.work-thumbnail { aspect-ratio:16/9; background:var(--rr-subtle); position:relative; display:flex; align-items:center; justify-content:center; color:var(--rr-muted); }
.work-thumbnail video { width:100%; height:100%; object-fit:cover; pointer-events:none; }
.work-status { position:absolute; bottom:8px; left:8px; padding:3px 7px; background:var(--rr-surface); color:var(--rr-text); border-radius:5px; font-size:11px; }
.work-card p { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; padding:10px 12px 4px; font-size:13px; }
.work-card time { padding:0 12px; font-size:11px; }
.library-empty { padding:24px 8px; text-align:center; color:var(--rr-muted); font-size:14px; }
.workbench-project-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; }
.workspace-heading { display:flex; align-items:center; gap:8px; width:100%; height:auto; padding:0; margin:0; min-width:0; }
.workspace-heading>strong { overflow:hidden; max-width:300px; font-size:13px; font-weight:600; text-overflow:ellipsis; white-space:nowrap; }
.workspace-heading .canvas-status { overflow:hidden; color:var(--rr-muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.workspace-heading .project-title { min-width:140px; max-width:300px; padding:4px 6px; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--rr-text); font-size:13px; }
.workspace-heading .project-title:is(:hover,:focus-within) { border-color:var(--rr-border); background:var(--rr-surface); }
.workspace-heading :deep(.v-btn) { font-size:12px; letter-spacing:0; }
.workspace-heading :deep(.v-switch) { flex:0 0 auto; }
.workspace-tools { position:absolute; z-index:6; left:16px; top:50%; transform:translateY(-50%); display:grid; gap:4px; padding:6px; border:1px solid var(--rr-border); border-radius:24px; background:var(--rr-surface); }
.workspace-tools button { width:36px; height:40px; border-radius:18px; color:var(--rr-text); }
.composer :deep(.v-field__input) { font-size:13px; line-height:1.7; }
.composer :deep(.v-field__field) { --v-field-padding-top:0px; }
.composer-toolbar :deep(.v-btn) { font-size:11px; letter-spacing:0; }
.composer-toolbar :deep(.v-btn:not(.v-btn--icon)) { padding-inline:8px; }
.result-actions :deep(.v-btn) { font-size:10px; letter-spacing:0; padding-inline:7px; min-width:0; }
.result-actions :deep(.v-chip) { font-size:10px; height:22px; }
.result-actions .video-hint { margin:0; font-size:10px; }
.result-prompt { font-size:10px; color:var(--rr-muted); text-align:center; }
.result-prompt p { text-align:left; }
.video-page>.v-alert { position:absolute; top:10px; left:72px; right:16px; z-index:8; }
.generate-feedback p { font-size:11px; margin-bottom:10px; }
.asset-help { font-size:10px; }
@media(max-width:600px) {
  .workspace-heading { gap:4px; }
  .workspace-heading .canvas-status { display:none; }


  .workspace-tools { left:10px; }
  .mode-tabs { padding:8px 8px 0; gap:3px; }
  .mode-tabs button { flex:1; padding:8px 4px; font-size:11px; }
  .composer-body { padding:8px; }
  .composer-toolbar { padding:6px; }
  .reference-upload { min-width:0; flex:1; }
  .result-actions .video-hint { display:none; }
  .output-library { left:60px; width:calc(100% - 72px); }
}

.canvas-world { position:absolute; inset:0; transform-origin:0 0; pointer-events:none; }
.canvas-object { pointer-events:auto; }
.canvas-selection-box { position:absolute; box-sizing:border-box; border:1px solid var(--rr-accent); background:color-mix(in srgb, var(--rr-accent) 9%, transparent); pointer-events:none; z-index:10; }
.canvas-card,.preview-stage { cursor:pointer; }
.passive-video { pointer-events:none; }
.canvas-selected > .canvas-video-card,.canvas-selected > .canvas-media-card,.canvas-selected > .canvas-text-card,.canvas-selected > .preview-stage { outline:1px solid var(--rr-accent); box-shadow:0 0 0 3px var(--rr-accent-surface); }
.canvas-card { position:absolute; width:var(--canvas-card-width,380px); margin-left:130px; }
.canvas-drag-handle { display:flex; align-items:center; gap:8px; height:34px; width:var(--canvas-card-width,380px); max-width:100%; color:var(--rr-heading); font-size:13px; cursor:pointer; text-align:left; touch-action:none; overflow:hidden; white-space:nowrap; }
.canvas-drag-handle .v-icon:last-child { margin-left:auto; opacity:.5; }
.canvas-video-card,.canvas-media-card,.canvas-text-card { border:1px solid var(--rr-border-strong); border-radius:12px; background:var(--rr-surface); overflow:hidden; }
.canvas-video-card>video,.canvas-media-card>img { display:block; width:100%; height:var(--canvas-card-height,214px); object-fit:contain; }
.canvas-media-card>audio { width:100%; margin-top:24px; }
.canvas-card-empty { position:relative; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; height:var(--canvas-card-height,214px); color:var(--rr-muted); font-size:13px; }
.canvas-card-empty input,.canvas-upload-video input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.canvas-card-action { display:block; width:100%; padding:12px; font-size:12px; border-top:1px solid var(--rr-border-soft); background:var(--rr-subtle); }
.canvas-text-card textarea { width:100%; height:200px; resize:vertical; padding:16px; outline:none; color:var(--rr-text); font-size:14px; background:transparent; }
.canvas-upload-video { position:relative; display:inline-block; padding:7px 14px; border-radius:20px; background:var(--rr-text); color:var(--rr-canvas); font-size:12px; margin-bottom:10px; }
.canvas-menu { position:absolute; z-index:10; width:200px; padding:8px; border:1px solid var(--rr-border); border-radius:16px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); }
.canvas-menu button { display:flex; gap:10px; align-items:center; width:100%; min-height:40px; padding:8px 10px; text-align:left; font-size:13px; border-radius:8px; }
.canvas-menu button:hover { background:var(--rr-accent-surface); }
.canvas-menu hr { border:0; border-top:1px solid var(--rr-border-soft); margin:5px; }
.canvas-menu .menu-group-toggle { color:var(--rr-muted); font-size:12px; }
.canvas-menu .menu-group-toggle .menu-caret { margin-left:auto; }
.canvas-tools { position:absolute; z-index:7; bottom:18px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:4px; padding:6px; border:1px solid var(--rr-border); border-radius:26px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); }
.canvas-tools button { min-width:34px; height:34px; border-radius:18px; font-size:20px; }
.canvas-tools .zoom-label { min-width:58px; font-size:12px; }
.tool-divider { height:18px; border-left:1px solid var(--rr-border); margin:0 4px; }
.canvas-hand { cursor:grab; }
.canvas-dragging,.canvas-dragging .canvas-card,.canvas-dragging .workflow-card-body,.canvas-dragging .preview-stage,.canvas-dragging .canvas-drag-handle { cursor:grabbing; user-select:none; }
</style>

<style scoped>
.canvas-menu .delete-node { color:var(--rr-error-text); }
.canvas-minimap { position:absolute; left:16px; bottom:18px; width:180px; z-index:7; border:1px solid var(--rr-border); border-radius:8px; overflow:hidden; background:var(--rr-surface); }
.minimap-toggle { display:flex; width:100%; justify-content:space-between; align-items:center; padding:5px 9px; color:var(--rr-muted); font-size:11px; cursor:pointer; }
.canvas-minimap svg { display:block; width:100%; height:110px; cursor:grab; touch-action:none; background:var(--rr-subtle); }
.canvas-minimap svg:active { cursor:grabbing; }
.canvas-tools button:disabled { opacity:.4; cursor:default; }
.minimap-card { fill:var(--rr-muted-faint); }
.minimap-selected { fill:var(--rr-accent); }
.minimap-viewport { fill:var(--rr-accent-surface); stroke:var(--rr-accent-strong); stroke-width:1; pointer-events:none; }
@media(max-width:640px) { .canvas-minimap { width:125px; bottom:76px; left:10px; } .canvas-minimap svg { height:auto; } }
</style>

<style scoped>
.node-text-preview { height:var(--canvas-card-height,214px); margin:0; padding:16px; white-space:pre-wrap; overflow:auto; color:var(--rr-heading); font-size:14px; user-select:none; }
.node-editor { width:640px; margin:14px 0 0 -130px; padding:16px; cursor:default; }
.node-editor textarea { display:block; width:100%; min-height:130px; resize:vertical; padding:8px; background:transparent; color:var(--rr-text); outline:none; cursor:text; }
.node-editor audio { display:block; width:100%; margin:0; color-scheme:inherit; }
.audio-node-editor {width:560px;margin-left:-90px;padding:12px;border-radius:20px;background:var(--rr-surface);}
.audio-node-editor .audio-prompt-editor {min-height:90px;}
.audio-node-editor .media-picker {padding:5px 7px;}
.audio-node-editor .audio-text-tools {margin:0 0 8px;}
.audio-settings-panel {margin-top:24px;padding:0 0 8px;cursor:default;}
.audio-settings-heading {display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.audio-settings-panel h3 {font-size:12px;font-weight:600;color:var(--rr-heading);margin:0;}
.audio-reset {display:flex;align-items:center;gap:4px;color:var(--rr-muted);font-size:12px;cursor:pointer;}
.audio-reset:hover {color:var(--rr-text);}
.audio-voice-tabs {display:flex;gap:4px;margin-bottom:8px;}
.audio-voice-tabs button {border-radius:5px;background:var(--rr-subtle);color:var(--rr-muted);font-size:12px;padding:3px 10px;cursor:pointer;}
.audio-voice-tabs button.active {background:var(--rr-accent-surface);color:var(--rr-heading);}
.audio-voice-selected {display:flex;align-items:center;gap:8px;background:var(--rr-subtle);border-radius:8px;padding:9px 12px;font-size:13px;color:var(--rr-heading);}
.audio-settings-panel .audio-section-title {margin:18px 0 8px;}
.audio-slider-row {display:flex;align-items:center;gap:10px;min-height:28px;font-size:12px;color:var(--rr-muted);}
.audio-slider-row .v-slider {flex:1;margin:0;}
.audio-slider-row output {min-width:35px;text-align:right;font-variant-numeric:tabular-nums;}
.audio-parameter-note {font-size:11px;color:var(--rr-muted);margin:10px 0 0;}
.audio-text-tools {display:flex;gap:6px;margin:10px 0;}
.audio-text-picker {border:1px solid var(--rr-border);border-radius:16px;padding:4px 10px;color:var(--rr-muted);}
.audio-insert-menu {width:220px;}
.audio-catalog-message {font-size:12px;color:var(--rr-muted);padding:8px 4px;margin:0;line-height:1.5;}
.media-model-menu button:disabled {opacity:.4;cursor:not-allowed;}
.audio-duration {font-size:12px;color:var(--rr-muted);}
.audio-upload-description strong,.audio-upload-description small {display:block;}
.audio-upload-description strong {font-size:12px;font-weight:500;color:var(--rr-heading);}
.audio-upload-description small {font-size:11px;color:var(--rr-muted);margin-top:5px;}
.audio-listening-area {min-height:110px;display:flex;align-items:center;padding:14px 4px;}
.audio-listening-area p {font-size:13px;color:var(--rr-muted);margin:0;}
.audio-reference-button {display:flex;align-items:center;gap:6px;margin-left:auto;background:var(--rr-accent-surface);color:var(--rr-heading);padding:8px 12px;border-radius:18px;font-size:12px;cursor:pointer;}
.audio-reference-button:disabled {opacity:.35;cursor:not-allowed;}
.audio-info-menu dl {margin:0;padding:4px;background:var(--rr-subtle);border-radius:14px;}
.audio-info-menu dl>div {display:flex;justify-content:space-between;gap:16px;padding:10px;font-size:12px;}
.audio-info-menu dt {color:var(--rr-muted);}
.audio-info-menu dd {margin:0;color:var(--rr-text);}
.node-upload { position:relative; display:inline-flex; padding:8px 14px; border:1px solid var(--rr-border-strong); border-radius:18px; font-size:12px; cursor:pointer; overflow:hidden; }
.node-upload input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.node-video-controls { padding:10px 14px 0; }
.node-video-controls video { display:block; width:100%; max-height:180px; margin-bottom:8px; }
.canvas-media-card img { pointer-events:none; }
</style>

<style scoped>
.image-generation-controls { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
.work-thumbnail>img {width:100%;height:100%;object-fit:cover;}
</style>

<style scoped>
.image-generation-controls { gap:4px; margin:12px 0 0; flex-wrap:wrap; }
.image-mode-label {display:flex;align-items:center;gap:6px;font-size:12px;color:var(--rr-text);margin-right:6px;}
.media-picker {display:inline-flex;align-items:center;gap:7px;padding:7px 9px;border-radius:8px;color:var(--rr-text);font-size:12px;cursor:pointer;white-space:nowrap;}
.media-picker:hover,.media-picker[aria-expanded="true"] {background:var(--rr-accent-surface);}
.image-single-count {margin-left:auto;color:var(--rr-muted);font-size:12px;padding:0 8px;}
.image-generate-arrow {margin-left:4px;}
.media-model-menu,.image-format-menu {background:var(--rr-surface);color:var(--rr-text);border:1px solid var(--rr-border);border-radius:24px;box-shadow:var(--rr-shadow-menu);padding:9px;width:360px;max-width:calc(100vw - 24px);}
.media-model-menu>button {display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:12px 10px;border-radius:9px;text-align:left;cursor:pointer;}
.media-model-menu>button:hover {background:var(--rr-subtle);}
.media-model-menu strong {display:block;font-size:13px;font-weight:500;}
.media-model-menu small {display:block;font-size:11px;line-height:1.5;color:var(--rr-muted);margin-top:5px;}
.media-model-menu .model-manage-link {font-size:11px;color:var(--rr-muted);border-top:1px solid var(--rr-border-faint);border-radius:0;margin-top:5px;}
.image-format-menu {width:330px;padding:12px 9px 9px;background:var(--rr-surface);border-color:var(--rr-border);overflow:hidden;}
.format-label {display:flex;justify-content:space-between;font-size:12px;padding:0 4px;margin-bottom:9px;}
.format-label small {color:var(--rr-muted);font-size:10px;}
.image-ratio-segments {display:flex;gap:2px;background:var(--rr-subtle);padding:4px;border-radius:14px;margin-bottom:14px;}
.image-ratio-segments button {display:flex;flex:1;align-items:center;justify-content:center;flex-direction:column;gap:8px;height:54px;border-radius:8px;color:var(--rr-muted);font-size:10px;cursor:pointer;}
.image-ratio-segments button>span {display:block;border:1px solid currentColor;border-radius:2px;}
.image-ratio-segments button.active,.image-quality-segments button.active {background:var(--rr-accent-surface);color:var(--rr-heading);}
.image-quality-segments {display:flex;background:var(--rr-subtle);padding:4px;border-radius:12px;}
.node-reference-row {display:flex;align-items:center;gap:10px;margin-bottom:8px;}
.image-upload-tile {width:48px;height:48px;align-items:center;justify-content:center;padding:0;border-style:dashed;border-radius:10px;color:var(--rr-muted);}
.ratio-options button.active,.resolution-options button.active {background:var(--rr-accent-surface);color:var(--rr-heading);}
.media-picker:focus-visible,.media-model-menu button:focus-visible,.image-format-menu button:focus-visible,.parameter-popover button:focus-visible {outline:2px solid var(--rr-muted);outline-offset:2px;}
.image-quality-segments button {flex:1;padding:7px;border-radius:8px;color:var(--rr-muted);font-size:12px;cursor:pointer;}
</style>

<style scoped>
.project-home { padding:48px; min-height:90vh; background:var(--rr-canvas); }
.project-home h1 { font-size:22px; margin-bottom:30px; }
.project-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:20px; max-width:1100px; }
.project-tile { min-height:210px; border:1px solid var(--rr-border-strong); border-radius:18px; background:var(--rr-surface); padding:16px; text-align:left; display:flex; flex-direction:column; gap:10px; color:var(--rr-text); }
.project-tile:hover { border-color:var(--rr-muted); }
.project-new { border-style:dashed; align-items:center; justify-content:center; }
.project-cover > img, .project-cover > video { display:block; width:100%; height:130px; object-fit:cover; border-radius:inherit; pointer-events:none; }
.project-cover { background:var(--rr-subtle); height:130px; border-radius:12px; display:grid; place-items:center; color:var(--rr-muted); }
.project-tile small { color:var(--rr-muted); font-size:12px; }
.project-title { color:inherit; max-width:210px; padding:8px; outline:none; }
</style>

<style scoped>
.canvas-media-card,.preview-stage { position:relative; }
.card-upload-button { position:relative; display:inline-flex; align-items:center; justify-content:center; background:var(--rr-heading); color:var(--rr-canvas); padding:7px 16px; border-radius:22px; font-size:13px; cursor:pointer; overflow:hidden; }
.card-upload-button input { position:absolute; inset:0; opacity:0; width:100%; height:100%; cursor:pointer; }
.card-replace-upload { position:absolute; right:10px; top:10px; opacity:0; }
.canvas-media-card:hover .card-replace-upload,.card-replace-upload:focus-within { opacity:1; }
.canvas-card-empty audio { width:88%; }
</style>

<style scoped>
.canvas-group { position:absolute; border:1px solid var(--rr-border-strong,rgba(127,127,127,.5)); border-radius:16px; background:color-mix(in srgb, var(--rr-surface,#15181e) 88%, transparent); pointer-events:auto; touch-action:none; }
.canvas-group.selected { border-color:var(--rr-accent); box-shadow:0 0 0 3px var(--rr-accent-surface); z-index:5; }
.canvas-group-head { display:flex; align-items:center; gap:7px; height:32px; box-sizing:border-box; padding:0 12px; font-size:12px; color:var(--rr-heading,var(--rr-text,#e6e8ee)); cursor:move; user-select:none; }
.canvas-group-head small { color:var(--rr-muted,#9aa0a6); font-size:11px; }
.canvas-group-toolbar { position:absolute; top:-46px; left:0; z-index:6; display:flex; align-items:center; gap:2px; padding:5px 6px; border:1px solid var(--rr-border); border-radius:22px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); white-space:nowrap; }
.canvas-group-toolbar > button { padding:5px 10px; border-radius:14px; font-size:11px; color:var(--rr-muted); }
.canvas-group-toolbar > button:is(:hover,:focus-visible) { background:var(--rr-accent-surface); color:var(--rr-heading); }
.group-arrange { position:relative; }
.group-arrange summary { display:flex; align-items:center; gap:5px; padding:5px 10px; border-radius:14px; font-size:11px; color:var(--rr-muted); cursor:pointer; list-style:none; }
.group-arrange summary::-webkit-details-marker { display:none; }
.group-arrange[open] summary { background:var(--rr-accent-surface); color:var(--rr-heading); }
.group-arrange-menu { position:absolute; top:calc(100% + 6px); left:0; display:grid; gap:2px; min-width:132px; padding:5px; border:1px solid var(--rr-border); border-radius:10px; background:var(--rr-surface); box-shadow:var(--rr-shadow-menu); }
.group-arrange-menu button { padding:7px 9px; border-radius:6px; text-align:left; font-size:11px; color:var(--rr-text); }
.group-arrange-menu button:is(:hover,:focus-visible) { background:var(--rr-accent-surface); color:var(--rr-heading); }
.group-tool-divider { width:1px; height:16px; background:var(--rr-border); margin:0 4px; }
.group-tool-danger { color:var(--rr-error-text,var(--rr-muted)) !important; }
.canvas-group-resize { position:absolute; width:12px; height:12px; padding:0; border:1px solid var(--rr-border,rgba(127,127,127,.5)); border-radius:3px; background:var(--rr-surface,#1b1b22); opacity:.5; transition:opacity .12s; }
.canvas-group:hover .canvas-group-resize,.canvas-group-resize:focus-visible { opacity:1; }
.canvas-group-resize.corner-nw { left:-6px; top:-6px; cursor:nwse-resize; }
.canvas-group-resize.corner-ne { right:-6px; top:-6px; cursor:nesw-resize; }
.canvas-group-resize.corner-sw { left:-6px; bottom:-6px; cursor:nesw-resize; }
.canvas-group-resize.corner-se { right:-6px; bottom:-6px; cursor:nwse-resize; }
</style>
