export function normalizeDshBinding(value: unknown): { baseUrl: string; sessionId: string };
export function sendDshTask(binding: { baseUrl?: string; sessionId: string }, prompt: string): Promise<unknown>;
