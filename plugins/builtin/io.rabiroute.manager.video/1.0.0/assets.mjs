import { checkedFs } from "./requestAccess.mjs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { VideoError } from "./service.mjs";
import { safeTarget } from "./models.mjs";
export const assetTypes = { image: { extension: "png", mime: "image/png", maxBytes: 9 * 1024 ** 2 }, video: { extension: "mp4", mime: "video/mp4", maxBytes: 64 * 1024 ** 2 }, audio: { extension: "wav", mime: "audio/wav", maxBytes: 16 * 1024 ** 2 } };
export class VideoAssets {
  constructor(runtime) { this.runtime = runtime; this.root = path.join(runtime.stateRoot, "assets"); this.pending = false; this.closed = false; }
  async read(id, access) {
    const fs = checkedFs(access);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new VideoError("素材编号无效。");
    const file = await safeTarget(this.root, `${id}.json`, access);
    const record = JSON.parse(await fs.readFile(file, "utf8").catch(() => { access?.assert(); throw new VideoError("参考素材不存在，请重新上传。", 404); }));
    if (record.id !== id || !Object.hasOwn(assetTypes, record.kind)) throw new VideoError("素材记录无效。");
    return record;
  }
  async file(id, access) { const record = await this.read(id, access); return { record, file: await safeTarget(this.root, `${id}.${assetTypes[record.kind].extension}`, access) }; }
  async upload(request, kind, access, inspect) {
    const fs = checkedFs(access); access?.assert();
    const type = Object.hasOwn(assetTypes, kind) ? assetTypes[kind] : undefined;
    if (!type) throw new VideoError("不支持的参考素材类型。");
    if (this.runtime.readOnly || this.closed) throw new VideoError("素材服务只读或正在关闭。", 423);
    if (this.pending) throw new VideoError("请等待当前素材检查完成。", 409);
    if (Number(request.headers["content-length"]) > type.maxBytes) throw new VideoError("参考素材文件过大。", 413);
    this.pending = true;
    let uploadedFile;
    try {
      if (!inspect && this.runtime.installed && !await this.runtime.installed(access)) throw new VideoError("请先在模型管理中安装视频运行环境，再上传参考素材。", 409);
      await fs.mkdir(this.root, { recursive: true });
      const id = randomUUID(), file = await safeTarget(this.root, `${id}.${type.extension}`, access);
      uploadedFile = file;
      const handle = await fs.open(file, "wx"); let size = 0;
      const timer = setTimeout(() => request.destroy(), (this.runtime.getTimeoutMs?.("video.asset.upload", 120000) ?? 120000));
      try { for await (const chunk of request) { access?.assert(); size += chunk.length; if (size > type.maxBytes) throw new VideoError("参考素材文件过大。", 413); access?.beforeMutation(); await handle.writeFile(chunk); access?.assert(); } }
      finally { clearTimeout(timer); await handle.close(); }
      access?.assert();
      if (!size || this.closed) throw new VideoError("素材上传未完成。");
      let metadata;
      try { metadata = inspect ? await inspect(kind, file, access) : await this.runtime.inspectAsset(id, kind, access); }
      catch (error) { access?.assert(); if (inspect && error instanceof VideoError) throw error; throw new VideoError("素材无法解码或超出限制，请检查格式、尺寸、帧率和时长。", 422); }
      if (this.closed) throw new VideoError("素材服务正在关闭。", 503);
      const record = { id, kind, size, ...metadata };
      await fs.writeFile(await safeTarget(this.root, `${id}.json`, access), JSON.stringify(record), { flag: "wx" });
      return record;
    } catch (error) {
      // Failed inspection has no asset record; discard only the file created by this upload.
      if (uploadedFile) { access?.beforeMutation(); await fs.rm(uploadedFile,{force:true}); }
      throw error;
    } finally { this.pending = false; }
  }
  async remove(id, access) {
    if (this.runtime.readOnly || this.closed) throw new VideoError("素材服务只读或正在关闭。",423);
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new VideoError("素材编号无效。");
    const fs = checkedFs(access);
    access?.beforeMutation();
    for (const extension of ["json",...Object.values(assetTypes).map(type=>type.extension)]) await fs.rm(await safeTarget(this.root,`${id}.${extension}`,access),{force:true});
  }
}
