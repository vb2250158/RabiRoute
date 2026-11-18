import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WEB_CHAT_ATTACHMENT_COUNT, WEB_CHAT_ATTACHMENT_MAX_BYTES, WEB_CHAT_ATTACHMENTS_MAX_BYTES } from '../shared/agentWebChat.js';

export function decodeWebChatAttachments(value: unknown) {
  if (!Array.isArray(value) || value.length > WEB_CHAT_ATTACHMENT_COUNT) throw new Error('附件数量超过限制。');
  let total = 0;
  return value.map((item, index) => {
    if (typeof item?.name !== 'string' || typeof item?.contentBase64 !== 'string') throw new Error('附件格式无效。');
    const safeName = item.name.replace(/[<>:"/\\|?*`\u0000-\u001f\u007f\u2028\u2029]/g, '_').trim();
    const name = Array.from(safeName).slice(0, 60).join('').replace(/[. ]+$/, '') || `attachment-${index + 1}`;
    const encoded = item.contentBase64;
    if (encoded.length > Math.ceil(WEB_CHAT_ATTACHMENT_MAX_BYTES / 3) * 4) throw new Error('单个附件不能超过 10 MiB。');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('附件编码无效。');
    total += bytes.length;
    if (bytes.length > WEB_CHAT_ATTACHMENT_MAX_BYTES) throw new Error('单个附件不能超过 10 MiB。');
    if (total > WEB_CHAT_ATTACHMENTS_MAX_BYTES) throw new Error('附件合计不能超过 25 MiB。');
    return { name, bytes };
  });
}

export async function storeWebChatAttachments(root: string, attachments: ReturnType<typeof decodeWebChatAttachments>, assertCurrent?: () => void) {
  assertCurrent?.();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(path.resolve(root), 'message-'));
  const written: string[] = [];
  try {
    for (const [index, attachment] of attachments.entries()) {
      assertCurrent?.();
      const file = path.join(directory, `${index + 1}-${attachment.name}`);
      written.push(file);
      await writeFile(file, attachment.bytes, { flag: 'wx', mode: 0o600 });
    }
    assertCurrent?.();
    return ['[WebChat 附件]', ...written.map((file, index) => `- ${attachments[index].name} · ${attachments[index].bytes.length} B · \`${file}\``)].join('\n');
  } catch (error) {
    await Promise.allSettled(written.map(file => unlink(file)));
    await rmdir(directory).catch(() => {});
    throw error;
  }
}
