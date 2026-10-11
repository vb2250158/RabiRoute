import type { AgentProfile } from './profile.mjs';
export type AgentProfileState = { profile: AgentProfile; applied: unknown; operations: { key: string; intentHash: string; receipt: { profile: AgentProfile; applied: unknown; savedRevision: number; idempotencyKey: string } }[] };
export function normalizeAgentProfileState(value: unknown): AgentProfileState | undefined;
