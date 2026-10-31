export type ApiPathSegment = Readonly<{ name: string; tail: boolean; remainder: boolean; prefix?: string; literal?: never; caseInsensitive?: never } | { literal: string; caseInsensitive?: true; name?: never; tail?: never; remainder?: never; prefix?: never }>;
export function parseApiPathTemplate(template: string, tailNames?: readonly string[], remainderName?: string, caseInsensitiveLiterals?: readonly string[]): Readonly<{ names: readonly string[]; tails: readonly string[]; remainder?: string;
  segments: readonly ApiPathSegment[]; pattern: RegExp; openApiTemplate: string }>;
export function validApiTail(value: unknown): boolean;
export function validApiHttpMethod(value: unknown): boolean;
export function fillApiPathTemplate(template: string, values?: Readonly<Record<string, string | number>>, tailNames?: readonly string[], remainderName?: string): string;
export function apiTailPathsOverlap(left: string, right: string, leftTails?: readonly string[], rightTails?: readonly string[], leftRemainder?: string, rightRemainder?: string, leftCase?: readonly string[], rightCase?: readonly string[]): boolean;
export function apiPathTemplatesEquivalent(left: string, right: string, leftCase?: readonly string[], rightCase?: readonly string[]): boolean;
