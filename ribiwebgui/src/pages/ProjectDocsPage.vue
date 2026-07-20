<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { marked } from "marked";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "../i18n";

type GuideDocument = {
  key: string;
  path: string;
  title: string;
  summary: string;
  source: string;
  searchText: string;
  section: string;
  order: number;
  locale: "zh-CN" | "en";
};

type OutlineItem = {
  id: string;
  title: string;
  depth: number;
};

const { isEnglish, setLocale } = useI18n();
const route = useRoute();
const router = useRouter();

const rawDocuments = import.meta.glob("../../../docs/user-guide/*.md", {
  eager: true,
  query: "?raw",
  import: "default"
}) as Record<string, string>;

const languageSwitchPattern = /<!-- docs-language-switch -->[\s\S]*?<!-- \/docs-language-switch -->/g;
const repositoryBase = "https://github.com/vb2250158/RabiRoute/blob/main/";
const pageOrder = [
  "README",
  "first-route",
  "interface-and-status",
  "routes-and-adapters",
  "speech-api",
  "agents-and-sessions",
  "personas-and-rules",
  "operations-and-troubleshooting",
  "safety-and-data",
  "faq-and-support"
];

function cleanSource(source: string): string {
  return source.replace(languageSwitchPattern, "").trim();
}

function documentPath(modulePath: string): string {
  const normalized = modulePath.replace(/\\/g, "/");
  return `docs/user-guide/${normalized.split("/docs/user-guide/")[1] || normalized.split("/").pop() || "README.md"}`;
}

function documentKey(path: string): string {
  return (path.split("/").pop() || "README.md").replace(/_en\.md$/, "").replace(/\.md$/, "");
}

function titleFrom(source: string, path: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.trim() || documentKey(path);
}

function summaryFrom(source: string, fallback: string): string {
  const lines = source.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(">") || line.startsWith("|") || line.startsWith("```") || line.startsWith("<")) continue;
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) continue;
    return line.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*_]/g, "");
  }
  return fallback;
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

function sectionFor(key: string, locale: "zh-CN" | "en"): string {
  const labels = locale === "en"
    ? ["Start here", "Use RabiRoute", "Operate safely", "Help"]
    : ["开始使用", "日常使用", "运行与安全", "获得帮助"];
  if (key === "README" || key === "first-route") return labels[0];
  if (["interface-and-status", "routes-and-adapters", "speech-api", "agents-and-sessions", "personas-and-rules"].includes(key)) return labels[1];
  if (["operations-and-troubleshooting", "safety-and-data"].includes(key)) return labels[2];
  return labels[3];
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}

function slugBase(value: string): string {
  const slug = stripInlineMarkdown(value)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return slug || "section";
}

function headingEntries(source: string): OutlineItem[] {
  const entries: OutlineItem[] = [];
  const counts = new Map<string, number>();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^(#{1,3})\s+(.+?)\s*#*$/);
    if (!match) continue;
    const title = stripInlineMarkdown(match[2]);
    const base = slugBase(title);
    const seen = counts.get(base) || 0;
    counts.set(base, seen + 1);
    entries.push({ id: seen ? `${base}-${seen + 1}` : base, title, depth: match[1].length });
  }
  return entries;
}

const allDocuments = Object.entries(rawDocuments)
  .map(([modulePath, raw]) => {
    const path = documentPath(modulePath);
    const source = cleanSource(String(raw));
    const key = documentKey(path);
    const locale = path.endsWith("_en.md") ? "en" : "zh-CN";
    const order = pageOrder.indexOf(key);
    return {
      key,
      path,
      title: titleFrom(source, path),
      summary: summaryFrom(source, locale === "en" ? "Open this guide." : "打开这篇使用指南。"),
      source,
      searchText: plainSearchText(source),
      section: sectionFor(key, locale),
      order: order < 0 ? pageOrder.length : order,
      locale
    } satisfies GuideDocument;
  })
  .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));

const query = ref("");
const activeKey = ref("README");
const documents = computed(() => allDocuments.filter(document => document.locale === (isEnglish.value ? "en" : "zh-CN")));
const activeDocument = computed(() => documents.value.find(document => document.key === activeKey.value) || documents.value[0]);

watch(documents, value => {
  if (value.length && !value.some(document => document.key === activeKey.value)) activeKey.value = value[0].key;
});

watch(
  () => route.query.page,
  value => {
    const page = Array.isArray(value) ? value[0] : value;
    const nextKey = typeof page === "string" && documents.value.some(document => document.key === page) ? page : "README";
    if (nextKey !== activeKey.value) activeKey.value = nextKey;
    if (page && nextKey === "README") void router.replace({ query: { ...route.query, page: undefined } });
  },
  { immediate: true }
);

const labels = computed(() => isEnglish.value ? {
  eyebrow: "RabiRoute User Guide",
  title: "Use RabiRoute with confidence",
  subtitle: "Task-based instructions for setup, routing, daily operation, safety, and troubleshooting.",
  badge: "user guides",
  search: "Search the user guide",
  count: "guides",
  empty: "No guide matches this search.",
  toc: "On this page",
  nav: "User guide navigation"
} : {
  eyebrow: "RabiRoute 使用手册",
  title: "从第一条消息到稳定运行",
  subtitle: "按真实任务组织的配置、路由、日常运维、安全与排障说明。",
  badge: "篇用户指南",
  search: "搜索使用手册",
  count: "篇指南",
  empty: "没有找到匹配的指南。",
  toc: "本页目录",
  nav: "使用手册导航"
});

const filteredDocuments = computed(() => {
  const tokens = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return documents.value;
  return documents.value.filter(document => {
    const haystack = `${document.title} ${document.summary} ${document.searchText}`.toLowerCase();
    return tokens.every(token => haystack.includes(token));
  });
});

const groupedDocuments = computed(() => {
  const groups = new Map<string, GuideDocument[]>();
  for (const document of filteredDocuments.value) {
    const items = groups.get(document.section) || [];
    items.push(document);
    groups.set(document.section, items);
  }
  return [...groups.entries()].map(([section, items]) => ({ section, items }));
});

const outline = computed(() => headingEntries(activeDocument.value?.source || "").filter(item => item.depth > 1));

const renderedMarkdown = computed(() => {
  const source = activeDocument.value?.source || "";
  const html = marked.parse(source, { async: false, gfm: true }) as string;
  if (typeof DOMParser === "undefined") return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const headings = headingEntries(source);
  parsed.querySelectorAll("h1, h2, h3").forEach((heading, index) => {
    const entry = headings[index];
    if (entry) heading.id = entry.id;
  });
  return parsed.body.innerHTML;
});

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

async function selectDocument(key: string, headingId = ""): Promise<void> {
  activeKey.value = key;
  const page = key === "README" ? undefined : key;
  if (route.query.page !== page) {
    await router.replace({ query: { ...route.query, page } });
  }
  await nextTick();
  if (headingId) scrollToHeading(headingId);
  else window.scrollTo({ top: 0, behavior: "smooth" });
}

function scrollToHeading(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleArticleClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return;
  const href = anchor.getAttribute("href") || "";
  if (!href || !activeDocument.value) return;
  if (href.startsWith("#")) {
    event.preventDefault();
    scrollToHeading(decodeURIComponent(href.slice(1)));
    return;
  }
  if (/^https?:/i.test(href) || !/\.md(?:$|[?#])/i.test(href)) return;
  event.preventDefault();
  const targetPath = normalizeRepositoryPath(activeDocument.value.path, href);
  const localTarget = allDocuments.find(document => document.path === targetPath);
  if (localTarget) {
    const headingId = href.includes("#") ? decodeURIComponent(href.split("#")[1].split("?")[0]) : "";
    if (localTarget.locale !== activeDocument.value.locale) setLocale(localTarget.locale);
    void selectDocument(localTarget.key, headingId);
    return;
  }
  window.open(`${repositoryBase}${targetPath}`, "_blank", "noopener,noreferrer");
}
</script>

<template>
  <div class="page-shell user-guide-page">
    <header class="guide-header app-card">
      <div>
        <div class="eyebrow">{{ labels.eyebrow }}</div>
        <h1 class="guide-title">{{ labels.title }}</h1>
        <p class="page-subtitle">{{ labels.subtitle }}</p>
      </div>
      <v-chip color="secondary" variant="tonal" prepend-icon="mdi-book-open-page-variant-outline">
        {{ documents.length }} {{ labels.badge }}
      </v-chip>
    </header>

    <div class="guide-layout">
      <aside class="guide-sidebar app-card">
        <v-text-field
          v-model="query"
          :label="labels.search"
          prepend-inner-icon="mdi-magnify"
          clearable
          density="compact"
        />
        <div class="guide-count">{{ filteredDocuments.length }} / {{ documents.length }} {{ labels.count }}</div>
        <nav :aria-label="labels.nav">
          <section v-for="group in groupedDocuments" :key="group.section" class="guide-group">
            <h2>{{ group.section }}</h2>
            <button
              v-for="document in group.items"
              :key="document.path"
              type="button"
              :class="{ active: document.key === activeDocument?.key }"
              @click="selectDocument(document.key)"
            >
              <strong>{{ document.title }}</strong>
              <span>{{ document.summary }}</span>
            </button>
          </section>
          <div v-if="filteredDocuments.length === 0" class="guide-empty">{{ labels.empty }}</div>
        </nav>
      </aside>

      <main class="guide-article app-card">
        <div class="guide-meta">
          <v-chip size="small" color="secondary" variant="tonal">{{ activeDocument?.section }}</v-chip>
          <span>{{ activeDocument?.summary }}</span>
        </div>
        <article class="markdown-body" data-no-i18n @click="handleArticleClick" v-html="renderedMarkdown" />
      </main>

      <aside class="guide-outline" :aria-label="labels.toc">
        <div class="guide-outline-card app-card">
          <div class="guide-outline-title">{{ labels.toc }}</div>
          <button
            v-for="item in outline"
            :key="item.id"
            type="button"
            :class="{ nested: item.depth === 3 }"
            @click="scrollToHeading(item.id)"
          >
            {{ item.title }}
          </button>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.user-guide-page {
  display: grid;
  gap: 18px;
}

.guide-header {
  display: flex;
  gap: 22px;
  align-items: flex-start;
  justify-content: space-between;
  padding: 26px 28px;
  background:
    radial-gradient(circle at 88% 18%, rgba(25, 191, 193, .16), transparent 31%),
    linear-gradient(145deg, rgba(255, 255, 255, .99), rgba(240, 250, 251, .94));
}

.guide-title {
  max-width: 760px;
  margin: 8px 0 8px;
  color: #0c2a4a;
  font-size: clamp(30px, 4vw, 46px);
  font-weight: 900;
  letter-spacing: -.035em;
  line-height: 1.08;
}

.guide-layout {
  display: grid;
  grid-template-columns: minmax(230px, 286px) minmax(0, 1fr) minmax(156px, 196px);
  gap: 18px;
  align-items: start;
}

.guide-sidebar,
.guide-outline {
  position: sticky;
  top: 82px;
  max-height: calc(100vh - 104px);
}

.guide-sidebar {
  padding: 16px;
  overflow: auto;
}

.guide-count {
  margin: -4px 2px 14px;
  color: #789;
  font-size: 11px;
  font-weight: 750;
}

.guide-group + .guide-group {
  margin-top: 18px;
}

.guide-group h2,
.guide-outline-title {
  margin: 0 0 7px;
  color: #557084;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.guide-group button {
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

.guide-group button:hover,
.guide-group button.active {
  border-color: rgba(25, 191, 193, .25);
  background: rgba(25, 191, 193, .09);
}

.guide-group strong {
  font-size: 13px;
  line-height: 1.35;
}

.guide-group span {
  display: -webkit-box;
  overflow: hidden;
  color: #6b7f91;
  font-size: 10px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.guide-empty {
  padding: 18px 8px;
  color: #789;
  font-size: 12px;
  text-align: center;
}

.guide-article {
  min-width: 0;
  padding: 30px clamp(22px, 4vw, 52px) 58px;
}

.guide-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 22px;
  color: #6b7f91;
  font-size: 11px;
}

.guide-outline-card {
  display: grid;
  gap: 2px;
  padding: 15px 12px;
}

.guide-outline button {
  padding: 6px 7px;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: #5d7284;
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
}

.guide-outline button:hover {
  border-left-color: #19bfc1;
  color: #087f91;
}

.guide-outline button.nested {
  padding-left: 17px;
  font-size: 10px;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) {
  scroll-margin-top: 94px;
  color: #0c2a4a;
  line-height: 1.25;
}

.markdown-body :deep(h1) {
  margin: 0 0 18px;
  font-size: clamp(29px, 4vw, 42px);
  letter-spacing: -.025em;
}

.markdown-body :deep(h2) {
  margin: 38px 0 14px;
  padding-top: 9px;
  border-top: 1px solid rgba(12, 42, 74, .1);
  font-size: 23px;
}

.markdown-body :deep(h3) {
  margin: 25px 0 10px;
  font-size: 17px;
}

.markdown-body :deep(p),
.markdown-body :deep(li) {
  color: #425c70;
  font-size: 14px;
  line-height: 1.75;
}

.markdown-body :deep(li + li) {
  margin-top: 5px;
}

.markdown-body :deep(a) {
  color: #087f91;
  font-weight: 750;
  text-decoration-thickness: 1px;
  text-underline-offset: 3px;
}

.markdown-body :deep(code) {
  padding: 2px 5px;
  border-radius: 4px;
  background: #edf4f6;
  color: #0c6470;
  font-family: "Cascadia Mono", Consolas, monospace;
}

.markdown-body :deep(pre) {
  overflow: auto;
  padding: 16px;
  border-radius: 8px;
  background: #071827;
  color: #d7f8ff;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
}

.markdown-body :deep(blockquote) {
  margin: 18px 0;
  padding: 12px 16px;
  border-left: 3px solid #19bfc1;
  background: rgba(25, 191, 193, .07);
}

.markdown-body :deep(table) {
  display: block;
  width: 100%;
  overflow-x: auto;
  margin: 18px 0;
  border-collapse: collapse;
  font-size: 12px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  min-width: 120px;
  padding: 10px;
  border: 1px solid rgba(12, 42, 74, .12);
  text-align: left;
  vertical-align: top;
}

.markdown-body :deep(th) {
  background: #eef8f8;
  color: #0c2a4a;
}

.markdown-body :deep(.screenshot-placeholder) {
  display: grid;
  min-height: 168px;
  gap: 8px;
  place-content: center;
  margin: 20px 0 26px;
  padding: 24px;
  border: 2px dashed rgba(8, 127, 145, .32);
  border-radius: 10px;
  background:
    linear-gradient(135deg, rgba(25, 191, 193, .06), rgba(12, 42, 74, .025)),
    repeating-linear-gradient(45deg, transparent, transparent 12px, rgba(12, 42, 74, .018) 12px, rgba(12, 42, 74, .018) 24px);
  color: #496579;
  text-align: center;
}

.markdown-body :deep(.screenshot-placeholder strong) {
  color: #0c6470;
  font-size: 15px;
}

.markdown-body :deep(.screenshot-placeholder span) {
  display: block;
  max-width: 680px;
  font-size: 12px;
  line-height: 1.6;
}

@media (max-width: 1180px) {
  .guide-layout {
    grid-template-columns: minmax(230px, 280px) minmax(0, 1fr);
  }
  .guide-outline {
    display: none;
  }
}

@media (max-width: 820px) {
  .guide-layout {
    grid-template-columns: 1fr;
  }
  .guide-sidebar {
    position: static;
    max-height: 440px;
  }
}

@media (max-width: 640px) {
  .guide-header {
    align-items: stretch;
    flex-direction: column;
  }
  .guide-article {
    padding-inline: 18px;
  }
  .guide-meta {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
