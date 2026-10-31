export class TransportError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>);
}
/** Inspects only DTO own data, rejecting accessors, proxies and custom classes. */
export function clone<T>(value: T, location: string): T;
