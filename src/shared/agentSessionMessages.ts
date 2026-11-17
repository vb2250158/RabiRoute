type JsonRecord = Record<string, any>;
function object(value:unknown):JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function agentMessageText(content:unknown):string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    const item = object(part);
    if (['text','input_text','output_text'].includes(item.type) && typeof item.text === 'string') return item.text;
    if (['image','input_image'].includes(item.type)) return '[图片]';
    return '';
  }).filter(Boolean).join('\n');
}

export function agentMessageTime(value:unknown):string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

/** The history view and its preview share the same user/final-message boundary. */
export function codexVisibleMessage(value:unknown):{role:'user'|'assistant';text:string}|undefined {
  const record = object(value), payload = object(record.payload);
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    return {role:'user',text:typeof payload.message === 'string' ? payload.message : ''};
  }
  if (record.type === 'event_msg' && payload.type === 'task_complete') {
    return {role:'assistant',text:typeof payload.last_agent_message === 'string' ? payload.last_agent_message : ''};
  }
  if (record.type === 'response_item' && payload.type === 'message'
    && (payload.role === 'user' || payload.role === 'assistant' && payload.phase === 'final_answer')) {
    return {role:payload.role,text:agentMessageText(payload.content)};
  }
  return undefined;
}

export function agentMessagePreview(text:string):string {
  let content = text.trim();
  if (content.startsWith('# Files mentioned by the user:')) {
    const request = content.indexOf('## My request:');
    if (request >= 0) content = content.slice(request + '## My request:'.length);
  }
  if (content.startsWith('## 消息源')) {
    const message = content.indexOf('## 消息内容');
    if (message >= 0) content = content.slice(message + '## 消息内容'.length).split('[回传参数]')[0];
  }
  const singleLine = content.replace(/\s+/g,' ').trim();
  return Array.from(singleLine.slice(0,320)).slice(0,160).join('');
}
