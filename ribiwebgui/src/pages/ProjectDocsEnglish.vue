<script setup lang="ts">
import { computed, ref } from "vue";
import { marked } from "marked";

type MarkdownDocument = {
  path: string;
  title: string;
  section: string;
  summary: string;
  source: string;
  searchText: string;
};

const rawDocuments = import.meta.glob("../../../docs/**/*_en.md", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

const languageSwitchPattern = /<!-- docs-language-switch -->[\s\S]*?<!-- \/docs-language-switch -->/g;
const repositoryBase = "https://github.com/vb2250158/RabiRoute/blob/main/";

function cleanSource(source: string): string {
  return source.replace(languageSwitchPattern, "").trim();
}

function documentPath(modulePath: string): string {
  const normalized = modulePath.replace(/\\/g, "/");
  return `docs/${normalized.split("/docs/")[1] || normalized.split("/").pop() || "README_en.md"}`;
}

function titleFrom(source: string, path: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.replace(/^docs\//, "").replace(/_en\.md$/, "");
}

function summaryFrom(source: string): string {
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```")) continue;
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
    return line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
  }
  return "Open the document to read the current guide and maturity notes.";
}

function sectionFor(path: string): string {
  const file = path.split("/").pop() || path;
  if (file === "README_en.md" || /current-capabilities|getting-started|configuration|troubleshooting/.test(file)) return "Start here";
  if (/architecture|code-architecture|project-function-map|agent-context|routing|pipeline|plan-and-memory|rabi-agent/.test(file)) return "Architecture & routing";
  if (/adapter|napcat|windows|wecom|voice/.test(file)) return "Operations & extensions";
  if (/rabilink|xiaomi|xiaoai|mobile-app/.test(path)) return "Experimental integrations";
  return "Designs & history";
}

function plainSearchText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`|~-]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const documents = Object.entries(rawDocuments)
  .map(([modulePath, raw]) => {
    const path = documentPath(modulePath);
    const source = cleanSource(String(raw));
    return {
      path,
      title: titleFrom(source, path),
      section: sectionFor(path),
      summary: summaryFrom(source),
      source,
      searchText: plainSearchText(source)
    } satisfies MarkdownDocument;
  })
  .sort((left, right) => left.section.localeCompare(right.section) || left.title.localeCompare(right.title));

const query = ref("");
const activePath = ref(documents.find(document => document.path === "docs/README_en.md")?.path || documents[0]?.path || "");

const filteredDocuments = computed(() => {
  const normalized = query.value.trim().toLowerCase();
  if (!normalized) return documents;
  return documents.filter(document => `${document.title} ${document.summary} ${document.searchText}`.includes(normalized));
});

const groupedDocuments = computed(() => {
  const groups = new Map<string, MarkdownDocument[]>();
  for (const document of filteredDocuments.value) {
    const items = groups.get(document.section) || [];
    items.push(document);
    groups.set(document.section, items);
  }
  return [...groups.entries()].map(([section, items]) => ({ section, items }));
});

const activeDocument = computed(() => documents.find(document => document.path === activePath.value) || documents[0]);
const renderedMarkdown = computed(() => marked.parse(activeDocument.value?.source || "", { async: false, gfm: true }) as string);

function normalizeRepositoryPath(fromPath: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0].split("?")[0]).replace(/\\/g, "/");
  const stack = fromPath.split("/");
  stack.pop();
  for (const part of clean.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function selectDocument(path: string): void {
  activePath.value = path;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function handleArticleClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") || "";
  if (!href || href.startsWith("#") || /^https?:/i.test(href) || !activeDocument.value) return;
  if (!/\.md(?:$|[?#])/i.test(href)) return;
  event.preventDefault();
  const targetPath = normalizeRepositoryPath(activeDocument.value.path, href);
  const localTarget = documents.find(document => document.path === targetPath || document.path === targetPath.replace(/\.md$/, "_en.md"));
  if (localTarget) {
    selectDocument(localTarget.path);
    return;
  }
  window.open(`${repositoryBase}${targetPath}`, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div class="page-shell markdown-docs-page">
    <header class="markdown-docs-header app-card">
      <div>
        <div class="eyebrow">RabiRoute Documentation</div>
        <h1 class="page-title">Project documentation</h1>
        <p class="page-subtitle">English pages are rendered directly from the repository's reviewed <code>_en.md</code> files.</p>
      </div>
      <v-chip color="secondary" variant="tonal" prepend-icon="mdi-translate">{{ documents.length }} English guides</v-chip>
    </header>

    <div class="markdown-docs-layout">
      <aside class="markdown-docs-sidebar app-card">
        <v-text-field
          v-model="query"
          label="Search documentation"
          prepend-inner-icon="mdi-magnify"
          clearable
          density="compact"
        />
        <div class="markdown-docs-count">{{ filteredDocuments.length }} of {{ documents.length }} documents</div>
        <nav aria-label="English documentation">
          <section v-for="group in groupedDocuments" :key="group.section" class="markdown-docs-group">
            <h2>{{ group.section }}</h2>
            <button
              v-for="document in group.items"
              :key="document.path"
              type="button"
              :class="{ active: document.path === activeDocument?.path }"
              @click="selectDocument(document.path)"
            >
              <strong>{{ document.title }}</strong>
              <span>{{ document.summary }}</span>
            </button>
          </section>
        </nav>
      </aside>

      <main class="markdown-docs-article app-card">
        <div class="markdown-docs-meta">
          <v-chip size="small" color="secondary" variant="tonal">{{ activeDocument?.section }}</v-chip>
          <code>{{ activeDocument?.path }}</code>
        </div>
        <article class="markdown-body" data-no-i18n @click="handleArticleClick" v-html="renderedMarkdown" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.markdown-docs-page {
  display: grid;
  gap: 18px;
}

.markdown-docs-header {
  display: flex;
  gap: 22px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 24px 26px;
  background:
    radial-gradient(circle at 88% 20%, rgba(25, 191, 193, .14), transparent 30%),
    linear-gradient(145deg, rgba(255, 255, 255, .98), rgba(240, 250, 251, .92));
}

.markdown-docs-layout {
  display: grid;
  grid-template-columns: minmax(250px, 320px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.markdown-docs-sidebar {
  position: sticky;
  top: 82px;
  max-height: calc(100vh - 104px);
  padding: 16px;
  overflow: auto;
}

.markdown-docs-count {
  margin: -4px 2px 14px;
  color: #789;
  font-size: 11px;
  font-weight: 750;
}

.markdown-docs-group + .markdown-docs-group {
  margin-top: 18px;
}

.markdown-docs-group h2 {
  margin: 0 0 7px;
  color: #557084;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.markdown-docs-group button {
  display: grid;
  width: 100%;
  gap: 3px;
  margin: 0 0 5px;
  padding: 10px 11px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: #102a43;
  text-align: left;
  cursor: pointer;
}

.markdown-docs-group button:hover,
.markdown-docs-group button.active {
  border-color: rgba(25, 191, 193, .22);
  background: rgba(25, 191, 193, .08);
}

.markdown-docs-group strong {
  font-size: 13px;
  line-height: 1.35;
}

.markdown-docs-group span {
  display: -webkit-box;
  overflow: hidden;
  color: #6b7f91;
  font-size: 10px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.markdown-docs-article {
  min-width: 0;
  padding: 28px clamp(20px, 4vw, 48px) 54px;
}

.markdown-docs-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  align-items: center;
  margin-bottom: 20px;
}

.markdown-docs-meta code {
  color: #6b7f91;
  font-size: 11px;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  color: #0c2a4a;
  line-height: 1.25;
}

.markdown-body :deep(h1) { margin: 0 0 18px; font-size: clamp(30px, 4vw, 44px); }
.markdown-body :deep(h2) { margin: 34px 0 13px; padding-top: 6px; border-top: 1px solid rgba(12, 42, 74, .1); font-size: 23px; }
.markdown-body :deep(h3) { margin: 24px 0 10px; font-size: 17px; }
.markdown-body :deep(p),
.markdown-body :deep(li) { color: #425c70; font-size: 14px; line-height: 1.75; }
.markdown-body :deep(a) { color: #087f91; font-weight: 750; text-decoration-thickness: 1px; text-underline-offset: 3px; }
.markdown-body :deep(code) { padding: 2px 5px; border-radius: 4px; background: #edf4f6; color: #0c6470; font-family: "Cascadia Mono", Consolas, monospace; }
.markdown-body :deep(pre) { overflow: auto; padding: 16px; border-radius: 8px; background: #071827; color: #d7f8ff; }
.markdown-body :deep(pre code) { padding: 0; background: transparent; color: inherit; }
.markdown-body :deep(blockquote) { margin: 16px 0; padding: 11px 15px; border-left: 3px solid #19bfc1; background: rgba(25, 191, 193, .07); }
.markdown-body :deep(table) { width: 100%; margin: 18px 0; border-collapse: collapse; font-size: 12px; }
.markdown-body :deep(th),
.markdown-body :deep(td) { padding: 10px; border: 1px solid rgba(12, 42, 74, .12); text-align: left; vertical-align: top; }
.markdown-body :deep(th) { background: #eef8f8; color: #0c2a4a; }

@media (max-width: 900px) {
  .markdown-docs-layout { grid-template-columns: 1fr; }
  .markdown-docs-sidebar { position: static; max-height: 420px; }
}

@media (max-width: 640px) {
  .markdown-docs-header { align-items: stretch; flex-direction: column; }
  .markdown-docs-article { padding-inline: 18px; }
}
</style>
