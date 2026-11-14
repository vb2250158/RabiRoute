import { gunzipSync } from 'node:zlib';
const limit = 2 * 1024 * 1024;
const int = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return bytes; };
const sized = bytes => [int(bytes.length), bytes];
/** Volcano v1 binary framing. Protocol fields are big endian; raw PCM is little endian. */
export function encodeTts(event, sessionId = '', payload = {}) {
  const data = Buffer.from(JSON.stringify(payload));
  const session = Buffer.from(sessionId);
  if (!Number.isSafeInteger(event) || data.length > limit || session.length > 256) throw Error('SPEECH_FRAME_INVALID');
  return Buffer.concat([Buffer.from([0x11, 0x14, 0x10, 0]), int(event), ...(event >= 100 ? sized(session) : []), ...sized(data)]);
}
export function encodeAsr(payload, { audio = false, last = false } = {}) {
  const bytes = audio ? Buffer.from(payload) : Buffer.from(JSON.stringify(payload));
  if (bytes.length > limit) throw Error('SPEECH_FRAME_LIMIT');
  return Buffer.concat([Buffer.from([0x11, (audio ? 0x20 : 0x10) | (last ? 2 : 0), audio ? 0 : 0x10, 0]), ...sized(bytes)]);
}
export function decodeFrame(value, { tts = false } = {}) {
  const bytes = Buffer.from(value);
  if (bytes.length < 8 || bytes.length > limit || bytes[0] >> 4 !== 1) throw Error('SPEECH_FRAME_INVALID');
  let offset = (bytes[0] & 15) * 4;
  if (offset < 4 || offset > bytes.length) throw Error('SPEECH_FRAME_INVALID');
  const type = bytes[1] >> 4, flags = bytes[1] & 15, serialization = bytes[2] >> 4, compression = bytes[2] & 15;
  if (![0, 1].includes(serialization) || ![0, 1].includes(compression)) throw Error('SPEECH_FRAME_ENCODING_UNSUPPORTED');
  const number = () => { if (offset + 4 > bytes.length) throw Error('SPEECH_FRAME_TRUNCATED'); const n = bytes.readInt32BE(offset); offset += 4; return n; };
  const field = () => { const length = number(); if (length < 0 || length > limit || offset + length > bytes.length) throw Error('SPEECH_FRAME_TRUNCATED'); const result = bytes.subarray(offset, offset + length); offset += length; return result; };
  let sequence, event, id, errorCode;
  if (type === 15) errorCode = number();
  else {
    if (flags & 1) sequence = number();
    if (flags & 4) {
      event = number();
      if (tts && (event >= 100 || [50, 51, 52].includes(event))) { const rawId = field(); if (rawId.length > 256) throw Error('SPEECH_FRAME_INVALID'); id = rawId.toString('utf8'); }
    }
  }
  let payload = field();
  if (offset !== bytes.length) throw Error('SPEECH_FRAME_TRAILING_DATA');
  if (compression === 1) { try { payload = gunzipSync(payload, { maxOutputLength: limit }); } catch { throw Error('SPEECH_FRAME_COMPRESSION_INVALID'); } }
  let data;
  if (serialization === 1) { try { data = JSON.parse(payload.toString('utf8')); } catch { throw Error('SPEECH_FRAME_JSON_INVALID'); } }
  if (errorCode !== undefined) throw Error('SPEECH_PROVIDER_ERROR_' + (Number.isSafeInteger(errorCode) ? errorCode : 'UNKNOWN'));
  return { type, flags, sequence, event, id, payload, data, last: Boolean(flags & 2) };
}
