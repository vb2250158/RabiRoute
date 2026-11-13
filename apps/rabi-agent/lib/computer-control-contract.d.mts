export type ComputerFeature = string;
export type ComputerSettings = {
  enabled: boolean; features: Record<ComputerFeature, boolean> & Record<string, unknown>;
  control: { showPointer: boolean; idleExitEnabled: boolean; idleTimeoutSeconds: number; countdownSeconds: number; exitShortcut: string; exitOnLocalInput: boolean; [key: string]: unknown };
  annotation: { staticDurationMs: number | null; dynamicEnabled: boolean; backend: string; rateHz: number; tracking: Record<string, number | boolean>; [key: string]: unknown };
  input: { maxActions: number; nativeSegmentMs: number; [key: string]: unknown };
  performance: { mode: string; maxTargets: number; computeBudgetMs: number; memoryBudgetBytes: number; minRateHz: number; minAnalysisWidth: number; [key: string]: unknown }; [key: string]: unknown;
};
export type ComputerSettingsDiagnostic = Readonly<{field:string;message:string}>;
export type ComputerSettingsRead = Readonly<{settings:unknown;rawSettings:unknown;revision:string;schema:Readonly<Record<string,unknown>>;defaults:Readonly<ComputerSettings>;definitionDigest:string;diagnostics:readonly ComputerSettingsDiagnostic[]}>;
export type ComputerSettingsDefinitionData = Readonly<{schemaVersion:1;features:Readonly<Record<string,unknown>>;schema:Readonly<Record<string,unknown>>;actions:Readonly<Record<string,unknown>>}>;
export type ComputerSettingsDefinition = Readonly<{
 data:ComputerSettingsDefinitionData;digest:string;features:typeof COMPUTER_FEATURES;schema:Readonly<Record<string,unknown>>;validationSchema:Readonly<Record<string,unknown>>;defaults:Readonly<ComputerSettings>;actions:typeof COMPUTER_ACTIONS;
 materialize(value:unknown,enabled?:boolean):unknown;diagnose(value:unknown):readonly ComputerSettingsDiagnostic[];
 normalize(value?:unknown,enabled?:boolean):ComputerSettings;normalizeForAction(value:unknown,action:string,enabled?:boolean,input?:Record<string,unknown>):ComputerSettings;
 patchRaw(current:unknown,patch:unknown,restorePaths?:readonly string[]):Record<string,unknown>;
 selectPatch(value:unknown,paths:readonly string[]):Record<string,any>;
 projectFeaturePolicy(value:unknown,feature:ComputerFeature,legacyEnabled?:boolean):ComputerFeaturePolicy;
 actionDefinition(action:string):typeof COMPUTER_ACTIONS[string]|undefined;
 assertFeaturePolicy(policy:ComputerFeaturePolicy,instanceId?:string):void;
 assertFeature(value:unknown,feature:ComputerFeature,instanceId?:string):void;assertAction(value:unknown,action:string,instanceId?:string):void;isReadOnlyAction(action:string):boolean;
}>;
export function createComputerSettingsDefinition(data:ComputerSettingsDefinitionData,digest:string):ComputerSettingsDefinition;
export const BOOTSTRAP_COMPUTER_SETTINGS_DEFINITION:ComputerSettingsDefinition;
export type ComputerExecutionContext = { sourceId: string; connectionId?: string; sourceLabel?: string; taskId?: string; guard?: () => void; getSettings?: () => unknown; getDefinition?:()=>ComputerSettingsDefinition; settings?: unknown; signal?: AbortSignal };
export const COMPUTER_FEATURES: Readonly<Record<ComputerFeature, Readonly<{title: string; description: string}>>>;
export const DEFAULT_COMPUTER_SETTINGS: Readonly<ComputerSettings>;
export const computerSettingsValidationSchema: Readonly<Record<string, unknown>>;
export const computerSettingsSchema: Readonly<Record<string, unknown>>;
export const COMPUTER_ACTIONS: Readonly<Record<string, Readonly<{feature: ComputerFeature; capability: string; readOnly?: boolean; recovery?: boolean; dynamic?: boolean; receipt?: boolean; settingsPaths?: readonly string[]; inputSettings?: Readonly<Record<string,string>>}>>>;
export function computerActionDefinition(action: string): typeof COMPUTER_ACTIONS[string] | undefined;
export function normalizeComputerSettings(value?: unknown, enabled?: boolean): ComputerSettings;
export function normalizeComputerSettingsForAction(value: unknown, action: string, enabled?: boolean, input?:Record<string,unknown>): ComputerSettings;
export function patchComputerSettings(current: unknown, patch: unknown): ComputerSettings;
export function assertComputerFeatureEnabled(settings: unknown, feature: ComputerFeature, instanceId?: string): void;
export function assertComputerActionEnabled(settings: unknown, action: string, instanceId?: string): void;
export function isComputerReadOnlyAction(action: string): boolean;

export const TERMINAL_ACTIONS: Readonly<Record<string, Readonly<{readOnly?:boolean;recovery?:boolean}>>>;
export function terminalActionDefinition(action:string): typeof TERMINAL_ACTIONS[string] | undefined;

export type InstanceAgentActionDefinition = Readonly<{newWork?:boolean;readOnly?:boolean;recovery?:boolean;newWorkUnlessFalse?:string;reconcileAction?:string}>;
export const INSTANCE_AGENT_OPERATIONS: Readonly<Record<string,InstanceAgentActionDefinition>>;
export const INSTANCE_AGENT_THREAD_ACTIONS: Readonly<Record<string,InstanceAgentActionDefinition>>;
export function instanceAgentActionDefinition(operation:string,params?:Record<string,unknown>):InstanceAgentActionDefinition|undefined;

export type ComputerFeaturePolicy = Readonly<{enabled:boolean;feature:ComputerFeature;allowed:boolean}>;
export function projectComputerFeaturePolicy(value:unknown,feature:ComputerFeature,legacyEnabled?:boolean):ComputerFeaturePolicy;
export function assertComputerFeaturePolicyEnabled(policy:ComputerFeaturePolicy,instanceId?:string):void;
