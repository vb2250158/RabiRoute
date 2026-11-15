export interface SpeechExpressionField {id:string;label:string;type:'text'|'enum'|'number';maxLength?:number;values?:string[];min?:number;max?:number}
export interface SpeechExpressionPolicy {enabled:boolean;fields:SpeechExpressionField[]}
export type SpeechExpression=Record<string,string|number>;
export function normalizeSpeechExpression(value:unknown,policy?:Partial<SpeechExpressionPolicy>):SpeechExpression;
export function speechExpressionInstruction(policy?:Partial<SpeechExpressionPolicy>):string;
export function createSpeechExpressionDecoder(policy?:Partial<SpeechExpressionPolicy>):{
 push(delta:string):{delta:string;text:string;expression?:SpeechExpression;warning?:string|null};
 finish():{delta:string;text:string;expression:SpeechExpression;warning:string|null};
 getState():{text:string;expression:SpeechExpression;warning:string|null};
};
