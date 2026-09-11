import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type TunnelIdentity = { deviceId: string; generation: string; publicKey: string; privateKey: string };
export type TunnelGrant = { deviceId: string; publicKey: string; services: string[] };
export type TunnelHello = { deviceId: string; generation: string; publicKey: string; ephemeral: string; nonce: string; target: string; signature: string };
export class TunnelDenied extends Error {}
const protocol = "rabi-tunnel-v1";
export function loadTunnelIdentity(file: string, deviceId: string, generation: string): TunnelIdentity {
  let keys: { publicKey: string; privateKey: string };
  try { keys = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    keys = { publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(keys), { flag: "wx", mode: 0o600 });
  }
  if (createPrivateKey(keys.privateKey).asymmetricKeyType !== "ed25519"
    || createPublicKey(keys.privateKey).export({ type: "spki", format: "pem" }).toString() !== keys.publicKey) throw new Error("Invalid tunnel identity.");
  return { ...keys, deviceId, generation };
}
export function createTunnelHandshake(identity: TunnelIdentity, target: string) {
  const ephemeral = generateKeyPairSync("x25519");
  const fields = { deviceId: identity.deviceId, generation: identity.generation, publicKey: identity.publicKey,
    ephemeral: ephemeral.publicKey.export({ type: "spki", format: "pem" }).toString(), nonce: randomBytes(24).toString("hex"), target };
  const hello: TunnelHello = { ...fields, signature: sign(null, Buffer.from(protocol + JSON.stringify(fields)), identity.privateKey).toString("base64") };
  return { hello, accept(remote: TunnelHello, grant: TunnelGrant, caller: boolean) {
    if (!remote || remote.deviceId !== grant.deviceId || remote.publicKey !== grant.publicKey || remote.target !== identity.deviceId
      || !/^[a-f0-9]{48}$/.test(remote.nonce) || typeof remote.generation !== "string" || remote.generation.length > 128) throw new TunnelDenied("peer_identity_denied");
    const { signature, ...body } = remote;
    if (createPublicKey(remote.publicKey).asymmetricKeyType !== "ed25519"
      || !verify(null, Buffer.from(protocol + JSON.stringify(body)), grant.publicKey, Buffer.from(signature, "base64"))) throw new TunnelDenied("peer_signature_denied");
    const remoteKey = createPublicKey(remote.ephemeral);
    if (remoteKey.asymmetricKeyType !== "x25519") throw new TunnelDenied("peer_key_denied");
    const secret = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: remoteKey });
    const transcript = Buffer.from(JSON.stringify(caller ? [hello, remote] : [remote, hello]));
    const derive = (label: string) => Buffer.from(hkdfSync("sha256", secret, transcript, protocol + label, 32));
    const tx = derive(caller ? "caller" : "receiver"), rx = derive(caller ? "receiver" : "caller");
    let sent = 0, received = 0;
    const iv = (n: number) => { const value = Buffer.alloc(12); value.writeBigUInt64BE(BigInt(n), 4); return value; };
    return { encode(value: unknown): Buffer {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 32_768) throw new Error("Tunnel frame too large.");
      const nonce = iv(++sent), cipher = createCipheriv("aes-256-gcm", tx, nonce);
      cipher.setAAD(Buffer.from(protocol));
      return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
    }, decode(bytes: Buffer): unknown {
      if (bytes.length < 28 || bytes.length > 32_796 || !bytes.subarray(0, 12).equals(iv(received + 1))) throw new Error("Invalid tunnel sequence.");
      const cipher = createDecipheriv("aes-256-gcm", rx, bytes.subarray(0, 12));
      cipher.setAAD(Buffer.from(protocol)); cipher.setAuthTag(bytes.subarray(-16));
      const plain = Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]);
      const value = JSON.parse(plain.toString()); received++; return value;
    } };
  } };
}
