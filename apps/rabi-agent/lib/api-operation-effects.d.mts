type EffectContract = { method: string; effects?: { mode?: string; request?: { bodyPath: readonly string[]; modes: Readonly<Record<string,string>> } } };
export function operationEffectMode(contract: EffectContract, body?: unknown): string;
export function operationIsReadOnly(contract: EffectContract, method?: string, body?: unknown): boolean;
export function markOperationEffect<T extends {body?: unknown;bodyText?:string}>(options:T,contract:EffectContract,method:string):T;
export function selectedOperationReadOnly(options:object):boolean|undefined;
export function copyOperationEffect<T extends object>(source:object,target:T):T;
