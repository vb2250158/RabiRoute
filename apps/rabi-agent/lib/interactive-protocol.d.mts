export * from './computer-control-contract.mjs';
export const TERMINAL_LIMITS: Readonly<{ idPattern: string; inputBytes: number; eventCodeUnits: number; replayBytes: number; replayEvents: number;
  waitMs: number; transportSessions: number; retainedSessions: number; inputReceipts: number;
  inputQueueBytes: number; minCols: number; maxCols: number; minRows: number; maxRows: number; streamQueueBytes: number; heartbeatMs: number }>;
export const COMPUTER_LIMITS: Readonly<{ chunkBytes: number; chunkBase64CodeUnits: number; uploadBytes: number; uploadIdPattern: string; hashPattern: string }>;
export const terminalIdSchema: Readonly<Record<string, unknown>>;
export const terminalRequestSchema: Readonly<Record<string, unknown>>;
export const terminalSnapshotSchema: Readonly<Record<string, unknown>>;
export const terminalListSchema: Readonly<Record<string, unknown>>;
export const terminalEventSchema: Readonly<Record<string, unknown>>;
export const terminalReadSchema: Readonly<Record<string, unknown>>;
export const computerRequestSchema: Readonly<Record<string, unknown>>;
export const computerResponseSchema: Readonly<Record<string, unknown>>;

export const computerSourceSchema: Readonly<Record<string, unknown>>;
export const computerInputActionSchema: Readonly<Record<string, unknown>>;
export const computerAnnotationShapeSchema: Readonly<Record<string, unknown>>;
export const computerControlRequestBranches: readonly Readonly<Record<string, unknown>>[];

export const computerTrackingTargetSchema: Readonly<Record<string, unknown>>;

export function computerRequestSchemaForDefinition(definition:import("./computer-control-contract.mjs").ComputerSettingsDefinition):Readonly<Record<string,unknown>>;
