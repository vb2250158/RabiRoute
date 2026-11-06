// Native field definitions own validation, normalization and executable discovery.
// Wire schemas describe deferred fields without intercepting original owner errors.
const field = (description, schema = {}) => Object.freeze({ description, ...schema });
export const commandFields = Object.freeze({
  model: field("Model ID from the current catalog; required.", { type: "string" }),
  prompt: field("Required nonblank string, at most 12000 characters before trimming; native owner trims it.", { type: "string", maxLength: 12000 }),
  width: field("Safe integer >=256, multiple of 32; null/omission uses model width; width*height <= model.maxArea.", { type: ["integer", "null"], minimum: 256, multipleOf: 32 }),
  height: field("Safe integer >=256, multiple of 32; null/omission uses model height; image dimensions <=2048.", { type: ["integer", "null"], minimum: 256, multipleOf: 32 }),
  frames: field("Video safe integer 17k+5, >=22 and <=model.maxFrames; null/omission uses model frames; forbidden for image models.", { type: ["integer", "null"], minimum: 22 }),
  seed: field("Nonnegative safe integer; null/omission uses 1.", { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  firstFrame: field("PNG Base64 or empty string; omitted/empty ignored; source dimensions 1–4096 and scaled size >=1; not reference/image mode.", { type: "string", maxLength: 12 * 1024 * 1024 }),
  lastFrame: field("Same native PNG and mode constraints as firstFrame.", { type: "string", maxLength: 12 * 1024 * 1024 }),
  references: field("Reference mode only: 1–15 unique asset UUIDs, <=9 images/3 videos/3 audio after reading owned assets.", { type: "array", minItems: 1, maxItems: 15, uniqueItems: true, items: { type: "string", pattern: "^[a-f0-9-]{36}$" } }),
  generateAudio: field("Boolean when present; forbidden for image models; reference mode omission becomes false.", { type: "boolean" }),
  referenceVideoSound: field("Boolean in reference mode; requires references; omitted becomes false.", { type: "boolean" }),
  quickGeneration: field("Boolean when present, only for a model exposing workflows; omission retains legacy selection.", { type: "boolean" })
});
export const projectFields = Object.freeze({
  id: field("Required project ID. Native RegExp uses String coercion and accepts its original UUID-shaped values.", { pattern: "^[a-f0-9-]{36}$" }),
  revision: field("Required safe integer exactly matching the stored revision; mismatch/missing returns native 409.", { type: "integer", minimum: 0 }),
  title: field("Optional: strings are trimmed and sliced to 100 characters; other values keep the previous title.", { normalizedMaxLength: 100 }),
  value: field("Required canvas value; native checks version/items/drafts/active. Unknown canvas, card and draft fields are stored unchanged.")
});
export const projectRules = Object.freeze({ version: 1, maxItems: 1000, kinds: Object.freeze(["video", "image", "audio", "text"]) });
export const settingsFields = Object.freeze({
  modelRoot: field("Required local model root: null/empty/whitespace restores default; strings are trimmed and normalized by the native local fixed-disk owner. Filesystem failures preserve their native status."),
  expectedRevision: field("Required exact current numeric revision. Missing, stale or extra local fields return native 409.", { type: "integer", minimum: 0 }),
  layout: field("Optional flat/categorized; restoring default forces flat.", { type: "string", enum: Object.freeze(["flat", "categorized"]) })
});
export const initializationFields = Object.freeze({ expectedRevision: settingsFields.expectedRevision });
export function matchesSettingsRequest(body, revision, initialization = false) {
  const fields = initialization ? initializationFields : settingsFields;
  return !!body && !Object.keys(body).some(key => !Object.hasOwn(fields, key)) && body.expectedRevision === revision && (initialization || "modelRoot" in body);
}
export const validModelLayout = value => settingsFields.layout.enum.includes(value);
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });
const string = { type: "string" }, number = { type: "number" }, boolean = { type: "boolean" }, strings = { type: "array", items: string };
const deferred = (fields, description) => ({ description, anyOf: [object(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, { description: value.description }]))), ...["array", "string", "number", "boolean", "null"].map(type => ({ type }))] });
const jobProperties = Object.fromEntries(Object.entries(commandFields).filter(([key]) => !["firstFrame", "lastFrame"].includes(key)).map(([key, value]) => [key, value]));
export const jobFields = Object.freeze({ ...jobProperties, id: string, model: string, status: { type: "string", description: "Current catalog state key; retained historical states remain owned by native recovery." }, createdAt: string, updatedAt: string, startedAt: string,
    progress: number, progressNode: string, progressStage: string, progressUnit: string, progressValue: { type: ["number", "null"] }, progressMax: { type: ["number", "null"] },
    workflowId: string, samplingSteps: number, computeOnly: boolean, computeDeviceId: string, providerJobId: { description: "Opaque original provider job identifier; no local coercion." }, computeOutcome: string, computeResumedAt: string, outputPurged: boolean,
    mediaKind: { enum: ["image", "video"] }, hasFirstFrame: boolean, hasLastFrame: boolean, imageUrl: string, videoUrl: string, error: string });

/** Validate only the public persisted job fields owned by this package's contract.
 * Optional lifecycle fields remain optional; unknown provider extensions stay opaque.
 */
export function validJobView(value) {
  return Object.entries(jobFields).every(([name, field]) => {
    const item = value[name];
    if (item === undefined) return true;
    if (field.enum && !field.enum.includes(item)) return false;
    if (field.type) {
      const types = Array.isArray(field.type) ? field.type : [field.type];
      if (!types.some(type => type === "null" ? item === null : type === "integer" ? Number.isSafeInteger(item)
        : type === "array" ? Array.isArray(item) : type === "number" ? typeof item === "number" && Number.isFinite(item) : typeof item === type)) return false;
    }
    if (item === null) return true;
    if (typeof item === "string" && field.maxLength !== undefined && [...item].length > field.maxLength) return false;
    if (typeof item === "number" && (field.minimum !== undefined && item < field.minimum || field.maximum !== undefined && item > field.maximum
      || field.multipleOf !== undefined && item % field.multipleOf !== 0)) return false;
    if (Array.isArray(item)) {
      if (field.minItems !== undefined && item.length < field.minItems || field.maxItems !== undefined && item.length > field.maxItems
        || field.uniqueItems && new Set(item).size !== item.length) return false;
      // The only job array is the original opaque asset-ID list.
      if (field.items && item.some(id => typeof id !== field.items.type || field.items.pattern && !new RegExp(field.items.pattern).test(id))) return false;
    }
    return true;
  });
}

export function createVideoContracts(catalog) {
  const card = object({ id: string, kind: { enum: projectRules.kinds } });
  const canvas = object({ version: { const: projectRules.version }, active: string, items: { type: "array", maxItems: projectRules.maxItems, items: card }, drafts: { type: "array", items: { description: "Native canvas drafts are persisted without inspecting their entries." } } });
  const project = object({ id: { description: projectFields.id.description }, title: string, revision: { type: "integer" }, updatedAt: string, value: { anyOf: [{ type: "null" }, canvas] } });
  const summary = object({ id: project.properties.id, title: string, revision: { type: "integer" }, updatedAt: string, cardCount: { type: "integer" } });
  const job = object(jobFields);
  // Purged compute receipts intentionally omit the command and progress fields.
  job.description = "Native public job view; optional fields vary with lifecycle and purged receipts. Hashes, frame payloads and local output paths are never exposed.";
  const availableWorkflow = object({ model: string, workflowId: string, generateAudio: boolean });
  const workflowProfile = object({ label: string, steps: number, lora: boolean, kind: string, priority: number, loraKey: string, conditions: { description: "Catalog workflow-routing conditions; evaluated by the original workflow selector." }, source: { description: "Catalog/provider workflow provenance." } });
  const modelDefinition = object({ id: string, directory: string, label: string, mode: string, fps: number, width: number, height: number, frames: number, maxArea: number, maxFrames: number, steps: number,
    files: { type: "object", additionalProperties: string }, expectedBytes: { type: "object", additionalProperties: number }, sha256: { type: "object", additionalProperties: string },
    workflows: { type: "object", additionalProperties: workflowProfile }, defaultWorkflow: string, workflowSource: string, downloadBase: string });
  modelDefinition.description = "Original catalog model fields and provider extensions. Model-dependent command limits use this same catalog passed to the native validator.";
  const recordIssues = { type: "array", items: object({ id: string, scope: { enum: ["jobs", "compute", "projects"] }, code: string }) };
  const status = object({ recordIssues, online: boolean, availableModels: strings, availableWorkflows: { type: "array", items: availableWorkflow }, models: { type: "array", items: modelDefinition }, states: { type: "object", additionalProperties: object({ label: string, terminal: boolean }) }, jobs: { type: "array", items: job }, computeError: string, computeProtocol: { const: 1 }, frameAdaptationAvailable: boolean });
  const modelFile = object({ key: string, name: string, bytes: number, installed: boolean, state: { enum: ["installed", "invalid", "missing"] } });
  const installation = object({ kind: { enum: ["runtime", "models", "model"] }, state: { enum: ["running", "completed", "failed"] }, bytes: number, total: number, currentFile: string, message: string });
  const directories = object({ revision: { type: "integer" }, modelRoot: { type: ["string", "null"] }, layout: { enum: settingsFields.layout.enum }, effectiveModelRoot: string, defaultModelRoot: string });
  const management = object({ runtimeInstalled: boolean, models: { type: "array", items: object({ id: string, label: string, bytes: number, installed: boolean, files: { type: "array", items: modelFile }, workflows: { type: "array", items: object({ id: string, label: string, installed: boolean, missingFiles: strings }) } }) }, job: { anyOf: [{ type: "null" }, installation] } });
  const plan = object({ revision: { type: "integer" }, modelRoot: string, files: { type: "array", items: object({ ...modelFile.properties, relative: string }) }, downloadBytes: number, additionalBytes: number, availableBytes: number, errors: strings, canDownload: boolean });
  // Model endpoints forward arbitrary JSON for a selected peer. Local field annotations
  // remain discoverable, without applying local validation to that peer protocol.
  const peerResult = local => ({ description: "Local stable DTO or unchanged selected-peer JSON. Local property types are described by the first alternative; peer JSON remains opaque.", anyOf: [local, { description: "Original selected-peer JSON result; validated by that peer, not by local DTO rules." }] });
  const requests = {
    projectCreate: deferred({ id: projectFields.id }, "Native project creation: id is checked with its original coercion; extra fields are ignored; invalid ID remains native 404."),
    projectSave: deferred({ revision: projectFields.revision, title: projectFields.title, value: projectFields.value }, "Native project CAS then canvas validation. Unknown root fields are ignored; value fields are retained; no wire coercion or defaults."),
    command: deferred(commandFields, "Native command validator requires model and prompt, rejects unknown fields with native 400, applies catalog-dependent defaults/limits and preserves original error messages. Limits below are enforced by that same owner."),
    settings: deferred(settingsFields, "Local model settings CAS/unknown fields return native 409 before layout/path validation. With computeDeviceId the original peer owns the entire JSON body."),
    initialization: deferred(initializationFields, "Local initialization uses exact revision and rejects extra fields with native 409; selected-peer bodies remain opaque.")
  };
  requests.projectSave.anyOf[0].properties.value = deferred({
    version: field("Native exact canvas version " + projectRules.version + "."),
    items: field("Array of at most " + projectRules.maxItems + " cards; unique string id, kind in " + projectRules.kinds.join(", ") + "; card extensions are retained."),
    active: field("ID of an existing video card; checked before detailed card validation."),
    drafts: field("Required array; entries and extensions remain opaque and are stored unchanged.")
  }, projectFields.value.description);
  requests.command.anyOf[0].properties.model.description += " Available IDs: " + catalog.models.map(row => row.id).join(", ") + ".";
  const responses = {
    "projects.list": object({ recordIssues, projects: { type: "array", items: summary } }), "projects.create": project, "project.read": project, "project.save": object({ revision: { type: "integer" } }),
    status: peerResult(status), "runtime.start": peerResult(status), "runtime.stop": peerResult(status),
    "compute.status": status, "compute.runtime-start": status, "compute.runtime-stop": status,
    "jobs.submit": job, "compute.job-submit": job, "job.read": job, "compute.job-read": job, "job.cancel": job,
    "jobs.list": object({ jobs: { type: "array", items: job } }), "compute.asset-remove": object({ removed: { const: true } }), "compute.job-remove": object({ removed: { const: true } }),
    "models.read": peerResult(management), "models.initialization": peerResult(plan), "models.initialize": peerResult(installation), "models.settings-read": peerResult(directories), "models.settings-save": peerResult(directories)
  };
  const validators = Object.freeze([
    { id: "video.command.native", description: Object.entries(commandFields).map(([key, value]) => key + ": " + value.description).join(" ") },
    { id: "video.project.native", description: "Original ID String/RegExp coercion; safe revision CAS 409 before value checks; value.version=1, items<=1000, unique string card IDs, supported kinds and active video; drafts are an opaque array. Title trims/slices100, nonstring keeps previous. Other value fields persist unchanged." },
    { id: "video.models.native", description: Object.entries(settingsFields).map(([key, value]) => key + ": " + value.description).join(" ") }
  ]);
  return Object.freeze({ requests, responses, validators });
}

export function validateCommand(input, catalog) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("请求必须是 JSON 对象。");
  const allowed = new Set(Object.keys(commandFields));
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("请求包含不支持的参数。");
  const model = catalog.models.find(item => item.id === input.model);
  if (!model) throw new Error("请选择可用的视频模型。");
  if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > commandFields.prompt.maxLength) throw new Error("提示词须为 1–12000 个字符。");
  const result = { model: model.id, prompt: input.prompt.trim(), width: input.width ?? model.width, height: input.height ?? model.height, frames: input.frames ?? model.frames, seed: input.seed ?? 1 };
  if (input.quickGeneration !== undefined) {
    if (typeof input.quickGeneration !== "boolean" || !model.workflows) throw new Error("快速生成选项不适用于该模型。");
    result.quickGeneration = input.quickGeneration;
  }
  if (model.mode === "image") {
    if (["frames","firstFrame","lastFrame","references","generateAudio","referenceVideoSound"].some(key => input[key] !== undefined)) throw new Error("图片模型仅支持文生图参数。");
    if (![result.width,result.height].every(n=>Number.isSafeInteger(n)&&n>=commandFields.width.minimum&&n<=2048&&n%commandFields.width.multipleOf===0)||result.width*result.height>model.maxArea) throw new Error("图片宽高须为 256–2048 的 32 倍数。");
    if (!Number.isSafeInteger(result.seed)||result.seed<commandFields.seed.minimum) throw new Error("种子须为非负安全整数。");
    delete result.frames; return result;
  }
  if (input.generateAudio !== undefined) {
    if (typeof input.generateAudio !== "boolean") throw new Error("声音选项须为布尔值。");
    result.generateAudio = input.generateAudio;
  }
  if(input.references !== undefined || input.referenceVideoSound !== undefined || model.mode === "reference") {
    if(model.mode!=="reference" || input.firstFrame || input.lastFrame) throw new Error("参考素材与首尾帧须使用各自的生成模式。");
    if(!Array.isArray(input.references) || input.references.length<commandFields.references.minItems || input.references.length>commandFields.references.maxItems || input.references.some(id=>typeof id!=="string" || !new RegExp(commandFields.references.items.pattern).test(id)) || new Set(input.references).size!==input.references.length) throw new Error("参考素材列表无效。");
    for(const key of ["generateAudio","referenceVideoSound"]) if(input[key]!==undefined && typeof input[key]!=="boolean") throw new Error("声音选项须为布尔值。");
    result.references=[...input.references]; result.generateAudio=!!input.generateAudio; result.referenceVideoSound=!!input.referenceVideoSound;
  }
  if(model.mode==="reference" && !result.references) throw new Error("请添加参考素材。");
  if (![result.width, result.height].every(value => Number.isSafeInteger(value) && value >= commandFields.width.minimum && value % commandFields.width.multipleOf === 0) || result.width * result.height > model.maxArea) throw new Error("宽高须为不小于 256 的 32 倍数，且像素总数不超过模型上限。");
  if (!Number.isSafeInteger(result.frames) || result.frames < commandFields.frames.minimum || result.frames > model.maxFrames || (result.frames - 5) % 17 !== 0) throw new Error("帧数须为 17k+5，范围 22–260。");
  if (!Number.isSafeInteger(result.seed) || result.seed < commandFields.seed.minimum) throw new Error("种子须为非负安全整数。");
  for (const name of ["firstFrame", "lastFrame"]) {
    if (input[name] === undefined || input[name] === "") continue;
    if (typeof input[name] !== "string" || input[name].length > commandFields[name].maxLength || !/^[A-Za-z0-9+/]+={0,2}$/.test(input[name])) throw new Error("图片须为不超过 9 MB 的 PNG Base64。");
    const bytes = Buffer.from(input[name], "base64");
    if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("仅支持 PNG 图片。");
    const sourceWidth = bytes.readUInt32BE(16), sourceHeight = bytes.readUInt32BE(20);
    if (![sourceWidth, sourceHeight].every(value => value >= 1 && value <= 4096)) throw new Error("首尾帧图片宽高须为 1–4096 像素。");
    // The provider's fit operation truncates scaled dimensions to integer pixels.
    const scale = Math.min(result.width / sourceWidth, result.height / sourceHeight);
    if (Math.floor(sourceWidth * scale) < 1 || Math.floor(sourceHeight * scale) < 1) throw new Error("图片比例过于极端，无法适配当前输出尺寸。");
    result[name] = input[name];
  }
  return result;
}
