import { normalizeKnowledgeSearchText } from "../../src/roleKnowledgeSearch.js";
import type { SqliteKnowledgeRow } from "./knowledgeSqlitePrototype.js";

/** Same deterministic distribution as the original 100k experiment. */
export function syntheticKnowledgeRow(n:number):SqliteKnowledgeRow {
  return {
    id:`synthetic-${String(n).padStart(6,"0")}`,
    text:normalizeKnowledgeSearchText(`Synthetic knowledge record ${n}. 中文合成索引测试。 bucket${n%100} literal%_ unicode😀 topic${n%37}. `+
      `Deterministic nested content for search, status facets and stable keyset. token-${String(n).padStart(6,"0")}`),
    kind:n%2?"recent":"plan",status:n%3?"open":"done",archived:n%10===0,
    tags:[`group${n%10}`],updatedAt:`2026-01-${String(1+n%28).padStart(2,"0")}T00:00:00.000Z`
  };
}
