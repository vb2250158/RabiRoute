import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mediaLibraryAbilities, mediaLibrarySource, speechLibraryAbilities } from "../src/components/modelLibraryPresentation";
import { speechModelDetails } from "../src/components/speechModelLibraryDetails";
import type { SpeechManagedModel } from "../../src/shared/speechModelManagement";

test("speech tags retain their catalog purpose and describe model-specific abilities", () => {
  const model: SpeechManagedModel = {
    alias: "tts-indextts2", capability: "tts", name: "IndexTTS2", family: "IndexTTS", source: "fixture",
    sourceUrl: "https://example.com", runtime: "isolated", purposeZh: "中文音色复刻、情绪与时长控制",
    purposeEn: "Chinese voice cloning, emotion and duration control", status: "not_downloaded", downloaded: false
  };
  const chinese = speechLibraryAbilities(model, "语音合成", "mdi-account-voice", false);
  assert.deepEqual(chinese.map(item => item.label), ["语音合成", "音色复刻", "情绪控制", "时长控制（未开放）"]);
  assert.match(chinese[0]!.description, /参考音色.*情绪/);
  assert.match(chinese.at(-1)!.description, /推理未启用.*没有传入目标秒数/);
  assert.equal(speechLibraryAbilities({ ...model, alias: "new-model" }, "Text to speech", "mdi-account-voice", true)[0]?.description, model.purposeEn);
});

test("every listed speech checkpoint has model-specific copy for every tag in both languages", () => {
  const speechCatalog = JSON.parse(readFileSync(new URL("../../src/plugins/rabi-speech/model-catalog.json", import.meta.url), "utf8"));
  for (const model of speechCatalog.models) {
    const details = speechModelDetails[model.alias];
    assert.ok(details, model.alias);
    for (const english of [false, true]) {
      const lang = english ? 1 : 0;
      const sourceUrl = model.repository ? `https://huggingface.co/${model.repository}` : model.download_url;
      const tags = speechLibraryAbilities({ ...model, sourceUrl }, model.capability, "", english);
      assert.equal(tags[0]?.description, details.usage[lang], model.alias);
      assert.ok(tags.every(tag => tag.sourceUrl?.startsWith("https://")), model.alias);
      if (model.capability === "speaker") {
        assert.ok(tags.every(tag => tag.sourceUrl === "https://github.com/modelscope/3D-Speaker"), model.alias);
      }
      for (const tag of tags.slice(1)) {
        assert.equal(tag.description, details.abilities[tag.id]?.[lang], `${model.alias} ${tag.id}`);
      }
    }
  }
  const qwen = speechModelDetails["tts-qwen3-0.6b"]!;
  assert.match(qwen.abilities.multilingual![0], /10 种输出语言.*中文、英语、日语、韩语.*意大利语.*Auto/);
});

const catalog = JSON.parse(readFileSync(new URL("../../src/plugins/io.rabiroute.manager.video/catalog.json", import.meta.url), "utf8"));
test("video workflow tags show actual constraints and missing or invalid model files", () => {
  const media = catalog.models.find((model: { id: string }) => model.id === "minimax-h3-fl2va");
  const abilities = mediaLibraryAbilities(media, [{ id: "fast-768", label: "原生画幅快速预览", installed: false, missingFiles: ["preview.safetensors"] }],
    [{ name: "preview.safetensors", installed: false, state: "invalid" }], false);
  assert.deepEqual(abilities.map(item => item.label), ["文生视频", "首尾帧", "生成音频", "原生画幅快速预览"]);
  assert.match(abilities.at(-1)!.description, /768.*仅生成画面/);
  assert.match(abilities.at(-1)!.detail!, /preview\.safetensors.*损坏或大小不符/);
  assert.equal(mediaLibrarySource(media), media.workflowSource);
});

test("image catalog presents text generation with its repository and no video tags", () => {
  const media = catalog.models.find((model: { id: string }) => model.id === "z-image-turbo");
  const abilities = mediaLibraryAbilities(media, [], [], true);
  assert.deepEqual(abilities.map(item => item.label), ["Text to image"]);
  assert.equal(abilities[0]?.detail, "8 sampling steps.");
  assert.match(abilities[0]!.description, /256–2048.*32/);
  assert.equal(abilities[0]?.sourceUrl, "https://huggingface.co/Tongyi-MAI/Z-Image-Turbo");
  assert.equal(mediaLibrarySource(media), "https://huggingface.co/Comfy-Org/z_image_turbo");
});

test("every media model and configured workflow has details and a help link in both languages", () => {
  for (const model of catalog.models) {
    const profiles = Object.entries<{ label: string }>(model.workflows ?? {});
    const workflows = profiles.map(([id, profile]) => ({ id, label: profile.label, installed: true, missingFiles: [] }));
    for (const english of [false, true]) {
      const tags = mediaLibraryAbilities(model, workflows, [], english);
      const configured = tags.filter(tag => tag.id.startsWith("workflow:"));
      assert.ok(tags.length > 0);
      assert.ok(tags.every(tag => tag.description.length > 30 && tag.sourceUrl?.startsWith("https://")), model.id);
      assert.equal(configured.length, profiles.length);
      for (const [id] of profiles) assert.ok(configured.some(tag => tag.id === `workflow:${id}`), `${model.id} ${id}`);
    }
  }
});

test("the two video models describe different audio VAE requirements and current file state", () => {
  const [frames, reference] = ["frames", "reference"].map(mode => catalog.models.find((model: { mode: string }) => model.mode === mode));
  const files = [{ name: frames.files.audioVae, installed: false, state: "missing" }];
  const frameTags = mediaLibraryAbilities(frames, [{ id: "standard", label: "标准 · 20 步", installed: true, missingFiles: [] }], files, false);
  assert.match(frameTags.find(item => item.id === "generatedAudio")!.detail!, /只有在生成音轨时才需要.*\n待下载/);
  assert.match(frameTags.find(item => item.id === "workflow:standard")!.detail!, /基础工作流文件已齐全.*\n输出音轨还需检查/);
  const refTags = mediaLibraryAbilities(reference, [], files, false);
  assert.match(refTags.find(item => item.id === "generatedAudio")!.detail!, /关闭输出音轨后仍要安装/);
  assert.match(refTags.find(item => item.id === "references")!.detail!, /使用视频原声.*生成音频/);
});
