export declare const API_METHODS: readonly string[];
export declare const API_HEADERS: readonly string[];
export declare function apiRequestHeaderAllowed(name: string): boolean;
export declare function validateApiRequest(value: unknown): {
  method: string; path: string; headers: Record<string, string>; body?: unknown; bodyBase64?: string; operationId?: string; mutation: boolean;
};
export declare function apiRequestTimingPolicy(request: { method?: string; path?: string }, options?: { defaultBudgetMs?: number }): {
  budgetMs: number; budgetParameterValid: boolean; maxAttempts: 1; pathTemplate: '/api/roles/:roleId/message-endpoint-history';
} | undefined;
export declare function apiRequestDiagnosticPath(request: { method?: string; path?: string }): string;
