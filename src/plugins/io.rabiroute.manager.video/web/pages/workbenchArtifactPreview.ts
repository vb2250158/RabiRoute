// §2.2: an artifact previewed inside the card. The bytes always come from the
// run-scoped endpoint — the browser cannot read a local path, and the owner
// re-checks ownership, root and hash on every read.
import { artifactKind, type ArtifactKind } from "./workbenchCardView";

export type PreviewArtifact = { id: string; name: string; path: string; href: string };

export type Preview =
  | { mode: "text"; url: string; kind: ArtifactKind }
  | { mode: "image"; url: string; kind: ArtifactKind }
  | { mode: "video"; url: string; kind: ArtifactKind }
  | { mode: "audio"; url: string; kind: ArtifactKind }
  | { mode: "none"; kind: ArtifactKind; reason: string };

/** Which renderer a card body should use; text needs a fetch, the rest can bind src. */
export function previewFor(artifact: PreviewArtifact | undefined, resolve: (href: string) => string): Preview {
  if (!artifact) return { mode: "none", kind: "other", reason: "还没有产物。" };
  const kind = artifactKind(artifact.path || artifact.name);
  const url = resolve(artifact.href);
  if (kind === "image") return { mode: "image", url, kind };
  if (kind === "video") return { mode: "video", url, kind };
  if (kind === "audio") return { mode: "audio", url, kind };
  if (kind === "text") return { mode: "text", url, kind };
  return { mode: "none", kind, reason: "这一类文件不提供内联预览，可用「下载」查看。" };
}

/** §2.2: the text shown in the card body, trimmed to the first few lines. */
export function previewText(source: string, lineLimit = 6) {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const shown = lines.slice(0, lineLimit).join("\n");
  return { text: shown, truncated: lines.length > lineLimit };
}

/** Only the first artifact of a card is previewed; the rest stay in the list. */
export function primaryArtifact(artifacts: readonly PreviewArtifact[]): PreviewArtifact | undefined {
  return artifacts[0];
}
