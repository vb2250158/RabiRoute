export type AgentProfile = { revision: number; id: string; name: string; systemPrompt: string; skills: { id: string; title: string; content: string; enabled: boolean }[]; mcp: { id: string; label: string; enabled: boolean }[]; personaRef?: { roleId: string; sourceDeviceId: string } | null };
export function validateAgentProfile(value: unknown): AgentProfile;
export const PROFILE_LIMITS: Readonly<Record<string, number>>;
export class AgentProfileError extends Error { statusCode: number; code: string; }
export function createAgentProfileService(options: { readStore(): unknown; writeStore(store: unknown): void }): { readForApplication(principal: unknown, deviceId: string): unknown; saveForApplication(principal: unknown, deviceId: string, input: unknown): unknown; readOperationForApplication(principal: unknown, deviceId: string, key: string): unknown; acknowledge(principal: unknown, input: unknown): unknown };
