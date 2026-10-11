import type { AgentProfile } from './profile.mjs';
export function readAiuiPersonaTemplate(options: { read(path: string): Promise<any>; roleId: unknown; sourceDeviceId: string; skillIds?: unknown }): Promise<AgentProfile>;
