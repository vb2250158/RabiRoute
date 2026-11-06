import { selectWorkflow } from "./workflowRouting.mjs";
// Catalog owns the compatible sampling profiles. Omitted options preserve legacy jobs.
export function resolveWorkflow(model, command = {}, available) {
  const id = selectWorkflow(model, command, available);
  const profile = model.workflows?.[id];
  if (model.workflows && !profile) throw new Error("所选模型没有兼容的生成工作流。");
  const files = { ...model.files };
  if (profile?.loraKey) files.lora = files[profile.loraKey];
  delete files.lora4;
  if (profile && !profile.lora) delete files.lora;
  if (!command.generateAudio && model.mode !== "reference") delete files.audioVae;
  return { ...model, files, steps: profile?.steps ?? model.steps, workflowId: id ?? model.id };
}

export function buildWorkflow(model, job, first, last, references = []) {
  model = resolveWorkflow(model, job);
  if (model.mode === "image") return {
    "1": {class_type:"UNETLoader",inputs:{unet_name:model.files.diffusion,weight_dtype:"default"}},
    "2": {class_type:"CLIPLoader",inputs:{clip_name:model.files.textEncoder,type:"lumina2",device:"default"}},
    "3": {class_type:"VAELoader",inputs:{vae_name:model.files.vae}},
    "4": {class_type:"CLIPTextEncode",inputs:{clip:["2",0],text:job.prompt}},
    "5": {class_type:"ConditioningZeroOut",inputs:{conditioning:["4",0]}},
    "6": {class_type:"EmptySD3LatentImage",inputs:{width:job.width,height:job.height,batch_size:1}},
    "7": {class_type:"ModelSamplingAuraFlow",inputs:{model:["1",0],shift:3}},
    "8": {class_type:"KSampler",inputs:{model:["7",0],positive:["4",0],negative:["5",0],latent_image:["6",0],seed:job.seed,steps:8,cfg:1,sampler_name:"res_multistep",scheduler:"simple",denoise:1}},
    "9": {class_type:"VAEDecode",inputs:{samples:["8",0],vae:["3",0]}},
    "10": {class_type:"SaveImage",inputs:{images:["9",0],filename_prefix:`rabi-image/${job.id}`}}
  };
  const nodes = {
    "3": { class_type: "UNETLoader", inputs: { unet_name: model.files.diffusion, weight_dtype: "default" } },
    "4": { class_type: "LoraLoaderModelOnly", inputs: { model: ["3", 0], lora_name: model.files.lora, strength_model: 1 } },
    "5": { class_type: "CLIPLoader", inputs: { clip_name: model.files.textEncoder, type: "minimax", device: "default" } },
    "6": { class_type: "VAELoader", inputs: { vae_name: model.files.vae } },
    "8": { class_type: "MiniMaxH3ImageToVideo", inputs: { clip: ["5", 0], vae: ["6", 0], prompt: job.prompt, width: job.width, height: job.height, length: job.frames } },
    "9": { class_type: "RandomNoise", inputs: { noise_seed: job.seed } },
    "10": { class_type: "BasicGuider", inputs: { model: ["4", 0], conditioning: ["8", 0] } },
    "11": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
    "12": { class_type: "BasicScheduler", inputs: { model: ["4", 0], scheduler: "simple", steps: 8, denoise: 1 } },
    "13": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["9", 0], guider: ["10", 0], sampler: ["11", 0], sigmas: ["12", 0], latent_image: ["8", 1] } },
    "14": { class_type: "VAEDecode", inputs: { samples: ["13", 0], vae: ["6", 0] } },
    "16": { class_type: "CreateVideo", inputs: { images: ["14", 0], fps: model.fps, bit_depth: 8 } },
    "17": { class_type: "SaveVideo", inputs: { video: ["16", 0], filename_prefix: `rabi-video/${job.id}`, format: "mp4", codec: "auto" } }
  };
  if (!model.files.lora) {
    delete nodes["4"];
    nodes["10"].inputs.model = ["3",0]; nodes["12"].inputs.model = ["3",0];
  }
  nodes["12"].inputs.steps = model.steps || 8;
  if (model.mode === "reference") {
    nodes["7"] = {class_type:"VAELoader",inputs:{vae_name:model.files.audioVae}};
    nodes["8"] = {class_type:"MiniMaxH3ReferenceToVideo",inputs:{clip:["5",0],vae:["6",0],audio_vae:["7",0],prompt:job.prompt,width:job.width,height:job.height,length:job.frames,ref_image_size:"match"}};
    const counts = {image:0,video:0,audio:0};
    references.forEach((asset,index)=> {
      const id=String(100+index*2), n=counts[asset.kind]++;
      if(asset.kind==="image") {
        nodes[id]={class_type:"LoadImage",inputs:{image:asset.filename}};
        nodes["8"].inputs[`ref_images.ref_image_${n}`]=[id,0];
      } else if(asset.kind==="video") {
        nodes[id]={class_type:"LoadVideo",inputs:{file:asset.filename}};
        const parts=String(101+index*2);
        nodes[parts]={class_type:"GetVideoComponents",inputs:{video:[id,0]}};
        nodes["8"].inputs[`ref_videos.ref_video_${n}`]=[parts,0];
        if(job.referenceVideoSound && asset.hasAudio) nodes["8"].inputs[`ref_video_audios.ref_video_audio_${n}`]=[parts,1];
      } else {
        nodes[id]={class_type:"LoadAudio",inputs:{audio:asset.filename}};
        nodes["8"].inputs[`ref_audios.ref_audio_${n}`]=[id,0];
      }
    });

  }
  if (job.generateAudio) {
    if (!model.files.audioVae) throw new Error("所选工作流缺少音频 VAE。");
    nodes["7"] = {class_type:"VAELoader",inputs:{vae_name:model.files.audioVae}};
    nodes["15"] = {class_type:"VAEDecodeAudio",inputs:{samples:["13",0],vae:["7",0]}};
    nodes["16"].inputs.audio = ["15",0];
  }
  for (const [name, value, node] of [["first_frame", first, "1"], ["last_frame", last, "2"]]) {
    if (!value) continue;
    nodes[node] = { class_type: "LoadImage", inputs: { image: value } };
    // Normalize both anchors identically before H3's differing first/last resize rules.
    const adapted = `fit_${node}`;
    nodes[adapted] = { class_type: "ResizeAndPadImage", inputs: { image: [node, 0], target_width: job.width, target_height: job.height, padding_color: "black", interpolation: "lanczos" } };
    nodes["8"].inputs[name] = [adapted, 0];
  }
  return nodes;
}

export { validateCommand } from "./contracts.mjs";
