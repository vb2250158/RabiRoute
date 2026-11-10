export type ComputerFeature = 'terminal' | 'files' | 'observation' | 'agentTasks' | 'input' | 'annotation';
export type ComputerSettings = {
  enabled: boolean; features: Record<ComputerFeature, boolean> & Record<string, unknown>;
  control: { showPointer: boolean; idleExitEnabled: boolean; idleTimeoutSeconds: number; countdownSeconds: number; exitShortcut: string; exitOnLocalInput: boolean; [key: string]: unknown };
  annotation: { staticDurationMs: number | null; dynamicEnabled: boolean; backend: 'kcf' | 'template'; rateHz: number; tracking: Record<string, number | boolean>; [key: string]: unknown };
  input: { maxActions: number; nativeSegmentMs: number; [key: string]: unknown };
  performance: { mode: 'auto' | 'custom'; maxTargets: number; computeBudgetMs: number; memoryBudgetBytes: number; minRateHz: number; minAnalysisWidth: number; [key: string]: unknown }; [key: string]: unknown;
};
export type ComputerExecutionContext = { sourceId: string; connectionId?: string; sourceLabel?: string; taskId?: string; guard?: () => void; getSettings?: () => ComputerSettings; settings?: ComputerSettings; signal?: AbortSignal };
export const COMPUTER_FEATURES: Readonly<Record<ComputerFeature, Readonly<{title: string; description: string}>>>;
export const DEFAULT_COMPUTER_SETTINGS: Readonly<ComputerSettings>;
export const computerSettingsValidationSchema: Readonly<Record<string, unknown>>;
export const computerSettingsSchema: Readonly<Record<string, unknown>>;
export const COMPUTER_ACTIONS: Readonly<Record<string, Readonly<{feature: ComputerFeature; capability: string; readOnly?: boolean; recovery?: boolean; dynamic?: boolean; receipt?: boolean}>>>;
export function computerActionDefinition(action: string): typeof COMPUTER_ACTIONS[string] | undefined;
export function normalizeComputerSettings(value?: unknown, enabled?: boolean): ComputerSettings;
export function patchComputerSettings(current: unknown, patch: unknown): ComputerSettings;
export function assertComputerFeatureEnabled(settings: unknown, feature: ComputerFeature, instanceId?: string): void;
export function assertComputerActionEnabled(settings: unknown, action: string, instanceId?: string): void;
export function isComputerReadOnlyAction(action: string): boolean;

export const TERMINAL_ACTIONS: Readonly<Record<string, Readonly<{readOnly?:boolean;recovery?:boolean}>>>;
export function terminalActionDefinition(action:string): typeof TERMINAL_ACTIONS[string] | undefined;

export type InstanceAgentActionDefinition = Readonly<{newWork?:boolean;readOnly?:boolean;recovery?:boolean;newWorkUnlessFalse?:string}>;
export const INSTANCE_AGENT_OPERATIONS: Readonly<Record<string,InstanceAgentActionDefinition>>;
export const INSTANCE_AGENT_THREAD_ACTIONS: Readonly<Record<string,InstanceAgentActionDefinition>>;
export function instanceAgentActionDefinition(operation:string,params?:Record<string,unknown>):InstanceAgentActionDefinition|undefined;

export type ComputerFeaturePolicy = Readonly<{enabled:boolean;feature:ComputerFeature;allowed:boolean}>;
export function projectComputerFeaturePolicy(value:unknown,feature:ComputerFeature,legacyEnabled?:boolean):ComputerFeaturePolicy;
export function assertComputerFeaturePolicyEnabled(policy:ComputerFeaturePolicy,instanceId?:string):void;
