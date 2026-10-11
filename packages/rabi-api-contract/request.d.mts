export declare const API_METHODS: readonly string[];
export declare const API_HEADERS: readonly string[];
export declare function apiRequestHeaderAllowed(name: string): boolean;
export declare function validateApiRequest(value: unknown): {
  method: string; path: string; headers: Record<string, string>; body?: unknown; bodyBase64?: string; operationId?: string; mutation: boolean;
};
