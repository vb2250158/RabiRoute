/** Wire identity only; importing this module never loads the DSH client/runtime. */
export const dshSessionIdPattern=/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isDshSessionId(value:string):boolean {return dshSessionIdPattern.test(String(value||'').trim());}
