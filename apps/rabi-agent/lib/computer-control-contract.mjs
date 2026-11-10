/** Shared settings and action facts. Runtime state remains with the target ComputerService. */
const freeze = value => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const bool = (title, value = true) => ({ type: 'boolean', title, default: value });
const number = (title, value, unit, minimum = 0) => ({ type: 'number', title, default: value, minimum, ...(unit ? { unit } : {}) });
export const COMPUTER_FEATURES = freeze({
  terminal: { title: '终端命令', description: '运行命令和读取终端输出' },
  files: { title: '文件操作', description: '查询文件和上传、下载' },
  observation: { title: '窗口与截图', description: '查看窗口和电脑画面' },
  agentTasks: { title: '智能体任务', description: '向这台电脑上的智能体分派工作' },
  input: { title: '鼠标与键盘', description: '点击、输入文字、滚动、拖拽和快捷键' },
  annotation: { title: '屏幕标注', description: '显示框、箭头和文字，与鼠标键盘独立' }
});
export const computerSettingsSchema = freeze({ type: 'object', title: '电脑设置', additionalProperties: true, properties: {
  enabled: bool('启用此电脑'),
  features: { type: 'object', title: '功能', additionalProperties: true, properties: Object.fromEntries(Object.entries(COMPUTER_FEATURES).map(([key, value]) => [key, { ...bool(value.title), description: value.description }])) },
  control: { type: 'object', title: '鼠标与键盘', additionalProperties: true, properties: {
    showPointer: bool('控制时显示 Agent 指针'), idleExitEnabled: bool('空闲时自动退出'),
    idleTimeoutSeconds: number('空闲退出时长', 120, '秒', Number.MIN_VALUE), countdownSeconds: number('倒计时显示', 10, '秒'),
    exitShortcut: { type: 'string', title: '退出控制快捷键', default: 'Ctrl+Alt+Esc', minLength: 1 },
    exitOnLocalInput: bool('检测到本机主动操作时退出', false) } },
  annotation: { type: 'object', title: '屏幕标注', additionalProperties: true, properties: {
    staticDurationMs: { title: '静态标注时长', unit: '毫秒', default: 10000, anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }], description: 'null 表示保留至清除' },
    dynamicEnabled: { ...bool('动态标注（持续跟踪目标）', false), description: '持续处理会增加 CPU 占用；启用本身不创建跟踪任务' },
    backend: { type: 'string', title: '跟踪方式', enum: ['kcf', 'template'], default: 'kcf' }, rateHz: number('请求更新频率', 10, '次/秒', Number.MIN_VALUE),
    tracking: { type: 'object', title: '跟踪高级设置', advanced: true, additionalProperties: true, properties: {
      searchExpansion: { ...number('搜索扩展', 2, '', 1), maximum: 8 }, maxAnalysisWidth: { ...number('分析最大宽度', 1280, '像素', 320), maximum: 3840 },
      matchThreshold: { ...number('模板匹配阈值', .82, '', 0), maximum: 1 }, ambiguityMargin: { ...number('相似目标差值', .05, '', 0), maximum: 1 },
      verifyEveryFrames: { ...number('模板核验间隔', 10, '帧', 1), maximum: 1000 }, lostAfterFrames: { ...number('丢失判定', 2, '帧', 1), maximum: 100 },
      updateTemplate: bool('可靠时更新模板', false), predictionMs: { ...number('预测范围', 0, '毫秒'), maximum: 1000 }, smoothing: { ...number('平滑', 0, ''), maximum: 1 },
      frameCacheFrames: { ...number('来源帧缓存', 6, '帧', 1), maximum: 60 }, frameCacheBytes: { ...number('来源帧缓存大小', 134217728, '字节', 1048576), maximum: 1073741824 },
      frameCacheAgeMs: { ...number('来源帧缓存时长', 30000, '毫秒', 1000), maximum: 300000 } } } } },
  performance: { type: 'object', title: '性能与资源', additionalProperties: true, properties: {
    mode: { type: 'string', title: '性能模式', enum: ['auto', 'custom'], default: 'auto' },
    maxTargets: { ...number('跟踪目标预算', 8, '个', 1), maximum: 64 }, computeBudgetMs: { ...number('每轮计算预算', 20, '毫秒', 1), maximum: 1000 },
    memoryBudgetBytes: { ...number('内存预算', 268435456, '字节', 16777216), maximum: 2147483648 }, minRateHz: { ...number('最低频率', 2, '次/秒', 1), maximum: 30 },
    minAnalysisWidth: number('最低分析宽度', 320, '像素', 1) } },
  input: { type: 'object', title: '输入与恢复设置', advanced: true, additionalProperties: true, properties: {
    maxActions: { ...number('输入批次上限', 128, '项', 1), maximum: 4096 }, nativeSegmentMs: { ...number('原生输入分段预算', 16, '毫秒', 1), maximum: 100 } } }
} });
/** UI annotations stay in the returned form schema; executable API schemas use standard JSON Schema keywords. */
function validationSchema(value) {
  if (Array.isArray(value)) return value.map(validationSchema);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'unit' && key !== 'advanced').map(([key, child]) => [key, validationSchema(child)]));
}
export const computerSettingsValidationSchema = freeze(validationSchema(computerSettingsSchema));
function defaults(schema) { if (Object.hasOwn(schema, 'default')) return schema.default; if (schema.properties) return Object.fromEntries(Object.entries(schema.properties).map(([k,v]) => [k, defaults(v)])); }
export const DEFAULT_COMPUTER_SETTINGS = freeze(defaults(computerSettingsSchema));
/** Merge at the original storage owner. Unknown saved extension fields survive known-field updates. */
function merge(base, patch) { const next = { ...base }; for (const [key, value] of Object.entries(patch)) Object.defineProperty(next, key, { value: object(value) && object(base?.[key]) ? merge(base[key], value) : structuredClone(value), writable: true, enumerable: true, configurable: true }); return next; }
function validate(value, schema, field) {
  if (schema.anyOf) { if (value === null && schema.anyOf.some(s => s.type === 'null')) return; return validate(value, schema.anyOf.find(s => s.type !== 'null'), field); }
  if (schema.type === 'object') { if (!object(value)) throw new TypeError(`${field} must be an object.`); for (const [key, entry] of Object.entries(value)) if (Object.hasOwn(schema.properties ?? {}, key)) validate(entry, schema.properties[key], `${field}.${key}`); return; }
  if (typeof value !== schema.type || schema.type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) || schema.enum && !schema.enum.includes(value) || schema.minLength && value.length < schema.minLength) throw new TypeError(`Invalid ${field}.`);
}
export function normalizeComputerSettings(value, enabled) {
  if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
  const saved = object(value) ? value : {};
  const next = merge(DEFAULT_COMPUTER_SETTINGS, saved);
  if (enabled !== undefined) next.enabled = enabled;
  validate(next, computerSettingsSchema, 'computerSettings'); return next;
}
export function patchComputerSettings(current, patch) {
  if (!object(patch)) throw new TypeError('Computer settings patch must be an object.');
  validate(patch, computerSettingsSchema, 'computerSettings');
  return normalizeComputerSettings(merge(normalizeComputerSettings(current), patch));
}
/** These are the current instanceManagement/AgentThreadRequest actions, not a capability permission registry. */
export const INSTANCE_AGENT_OPERATIONS = freeze({ tasks: {newWork:true}, prepared_delivery:{newWork:true}, reconcile_prepared_delivery:{readOnly:true,recovery:true} });
export const INSTANCE_AGENT_THREAD_ACTIONS = freeze({ list:{readOnly:true,recovery:true}, read:{readOnly:true,recovery:true}, creation_status:{readOnly:true,recovery:true},
  create:{newWork:true}, create_metadata:{newWork:true}, send:{newWork:true}, open:{}, rename:{}, resolve:{newWorkUnlessFalse:'createIfMissing'} });
export function instanceAgentActionDefinition(operation, params = {}) {
  if (operation !== 'threads') return INSTANCE_AGENT_OPERATIONS[operation];
  const entry = INSTANCE_AGENT_THREAD_ACTIONS[params.action];
  if (entry?.newWorkUnlessFalse) return params[entry.newWorkUnlessFalse] === false ? {readOnly:true,recovery:true} : {newWork:true};
  return entry;
}
export const TERMINAL_ACTIONS = freeze({ list: {readOnly:true,recovery:true}, get: {readOnly:true,recovery:true}, close: {recovery:true}, open:{}, input:{}, resize:{} });
export function terminalActionDefinition(action) { return TERMINAL_ACTIONS[action]; }
export const COMPUTER_ACTIONS = freeze({
  'file.stat': { feature: 'files', capability: 'files', readOnly: true }, 'file.read': { feature: 'files', capability: 'files', readOnly: true },
  'upload.begin': { feature: 'files', capability: 'files' }, 'upload.write': { feature: 'files', capability: 'files' }, 'upload.commit': { feature: 'files', capability: 'files' },
  'upload.status': { feature: 'files', capability: 'files', readOnly: true, recovery: true }, 'upload.abort': { feature: 'files', capability: 'files', recovery: true },
  'windows.list': { feature: 'observation', capability: 'windows', readOnly: true }, 'screen.capture': { feature: 'observation', capability: 'screenshots', readOnly: true },
  'control.begin': { receipt: true, feature: 'input', capability: 'input' }, 'control.status': { feature: 'input', capability: 'input', readOnly: true, recovery: true }, 'control.end': { feature: 'input', capability: 'input', recovery: true },
  'input.execute': { receipt: true, feature: 'input', capability: 'input' }, 'input.status': { feature: 'input', capability: 'input', readOnly: true, recovery: true }, 'input.cancel': { feature: 'input', capability: 'input', recovery: true },
  'annotation.show': { receipt: true, feature: 'annotation', capability: 'annotation' }, 'annotation.update': { feature: 'annotation', capability: 'annotation' },
  'annotation.status': { feature: 'annotation', capability: 'annotation', readOnly: true, recovery: true }, 'annotation.clear': { feature: 'annotation', capability: 'annotation', recovery: true },
  'annotation.track.start': { receipt: true, feature: 'annotation', capability: 'tracking', dynamic: true }, 'annotation.track.status': { feature: 'annotation', capability: 'tracking', readOnly: true, recovery: true }, 'annotation.track.stop': { feature: 'annotation', capability: 'tracking', recovery: true }
});
export function computerActionDefinition(action) { return COMPUTER_ACTIONS[action]; }
/** Feature admission reads only its actual enabled flags, not unrelated rendering/tracking parameters. */
export function projectComputerFeaturePolicy(value, feature, legacyEnabled) {
  if (value !== undefined && !object(value)) throw new TypeError('computerSettings must be an object.');
  const saved = value ?? {};
  const invalid = field => { throw Object.assign(new TypeError(`Invalid computerSettings.${field}.`), {code:'COMPUTER_SETTINGS_INVALID',field}); };
  if (saved.enabled !== undefined && typeof saved.enabled !== 'boolean') invalid('enabled');
  if (legacyEnabled !== undefined && typeof legacyEnabled !== 'boolean') invalid('enabled');
  if (saved.features !== undefined && !object(saved.features)) invalid('features');
  const own = saved.features?.[feature];
  if (own !== undefined && typeof own !== 'boolean') invalid('features.' + feature);
  return { enabled: legacyEnabled ?? saved.enabled ?? DEFAULT_COMPUTER_SETTINGS.enabled, feature, allowed: own ?? DEFAULT_COMPUTER_SETTINGS.features[feature] };
}
export function assertComputerFeaturePolicyEnabled(policy, instanceId) {
  if (!policy.enabled || !policy.allowed) throw Object.assign(new Error(`Computer ${instanceId ?? ''} ${!policy.enabled ? 'enabled' : 'features.' + policy.feature} is disabled. Change RabiLink → 电脑控制.`), {code:'COMPUTER_FEATURE_DISABLED',feature:policy.feature,field:!policy.enabled?'enabled':'features.'+policy.feature,instanceId});
}
export function assertComputerFeatureEnabled(settings, feature, instanceId) {
  assertComputerFeaturePolicyEnabled(projectComputerFeaturePolicy(settings,feature),instanceId);
}

export function assertComputerActionEnabled(settings, action, instanceId) {
  const entry = computerActionDefinition(action); if (!entry) throw new Error('Unknown computer action. Read the current computer operation schema.');
  if (entry.recovery) return;
  assertComputerFeatureEnabled(settings, entry.feature, instanceId);
  if (entry.dynamic && !normalizeComputerSettings(settings).annotation.dynamicEnabled) throw Object.assign(new Error('Dynamic annotation is disabled. Change RabiLink → 电脑控制 → 屏幕标注.'), { code: 'COMPUTER_DYNAMIC_DISABLED', field: 'annotation.dynamicEnabled', instanceId });
}
export function isComputerReadOnlyAction(action) { return computerActionDefinition(action)?.readOnly === true; }
