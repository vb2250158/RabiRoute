// Card badges and the merged input list. Pure so the canvas can stay declarative
// and the two input sources can be reasoned about without a browser.
import type { FlowNode } from "./workbenchEditor";

export type ArtifactKind = "text" | "image" | "video" | "audio" | "other";

const extensions: Record<string, ArtifactKind> = {
  txt: "text", md: "text", json: "text", csv: "text", log: "text",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image",
  mp4: "video", mov: "video", webm: "video", mkv: "video",
  wav: "audio", mp3: "audio", m4a: "audio", flac: "audio", ogg: "audio",
};

export const artifactKindGlyphs: Record<ArtifactKind, string> = {
  text: "T", image: "◫", video: "▶", audio: "♪", other: "•",
};

/** The path decides the icon; an unknown extension stays a neutral dot rather than a wrong glyph. */
export function artifactKind(value: string | undefined): ArtifactKind {
  if (!value) return "other";
  const match = /\.([a-z0-9]+)(?:$|[?#])/i.exec(value);
  return match ? extensions[match[1]!.toLowerCase()] ?? "other" : "other";
}

export type ArtifactLike = { key?: string; path?: string };

/** One icon per distinct kind, plus the total the card should show. */
export function artifactBadge(artifacts: readonly ArtifactLike[]) {
  const kinds: ArtifactKind[] = [];
  for (const artifact of artifacts) {
    const kind = artifactKind(artifact.path ?? artifact.key);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return { count: artifacts.length, kinds, glyphs: kinds.map(kind => artifactKindGlyphs[kind]) };
}

export type MergedInput = {
  from: string;
  title: string;
  kind: "material" | "text";
  artifactKeys: readonly string[];
  artifactKinds: readonly ArtifactKind[];
};

/**
 * The canvas used to render material links and text links as two separate chip
 * rows; one card can receive both from the same upstream node. Merge by source
 * so a single row explains everything that card will consume at run time.
 */
export function mergedInputs(input: {
  material: readonly { from: string; sourceTitle: string; artifactKeys: readonly string[] }[];
  text: readonly { id: string; title: string }[];
}): MergedInput[] {
  const rows = new Map<string, MergedInput>();
  for (const link of input.material) {
    const keys = [...link.artifactKeys];
    const current = rows.get(link.from);
    rows.set(link.from, current
      ? { ...current, artifactKeys: [...new Set([...current.artifactKeys, ...keys])],
        artifactKinds: [...new Set([...current.artifactKinds, ...keys.map(artifactKind)])] }
      : { from: link.from, title: link.sourceTitle, kind: "material", artifactKeys: keys, artifactKinds: keys.map(artifactKind) });
  }
  for (const source of input.text) {
    const current = rows.get(source.id);
    if (current) continue;
    rows.set(source.id, { from: source.id, title: source.title, kind: "text", artifactKeys: [], artifactKinds: ["text"] });
  }
  return [...rows.values()];
}

/** Counts shown on the two corners of a card. */
export function cardBadges(node: FlowNode | undefined, outputs: readonly ArtifactLike[], inputs: readonly MergedInput[]) {
  const declared = (node?.requirements ?? []).length;
  const output = artifactBadge(outputs.length ? outputs : Array.from({ length: declared }, () => ({})));
  return {
    outputCount: output.count,
    outputGlyphs: output.glyphs,
    inputCount: inputs.length,
    inputGlyphs: [...new Set(inputs.flatMap(row => row.artifactKinds))].map(kind => artifactKindGlyphs[kind]),
  };
}
