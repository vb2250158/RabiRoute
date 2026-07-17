import { LOCALE_CHANGED_EVENT, type AppLocale, translateText } from "./index";

const localizedAttributes = ["aria-label", "placeholder", "title"] as const;
const originalText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const skippedTags = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA"]);

function shouldSkip(element: Element | null): boolean {
  if (!element) return false;
  if (skippedTags.has(element.tagName)) return true;
  if (element.closest("[data-no-i18n]")) return true;
  return element instanceof HTMLElement && element.isContentEditable;
}

function localizeTextNode(node: Text, locale: AppLocale): void {
  if (shouldSkip(node.parentElement)) return;
  const current = node.nodeValue || "";
  if (!originalText.has(node)) originalText.set(node, current);
  const source = originalText.get(node) || current;
  const next = translateText(source, locale);
  if (current !== next) node.nodeValue = next;
}

function localizeAttributes(element: Element, locale: AppLocale): void {
  if (shouldSkip(element)) return;
  let originals = originalAttributes.get(element);
  if (!originals) {
    originals = new Map<string, string>();
    originalAttributes.set(element, originals);
  }
  for (const attribute of localizedAttributes) {
    const current = element.getAttribute(attribute);
    if (current == null) continue;
    if (!originals.has(attribute)) originals.set(attribute, current);
    const source = originals.get(attribute) || current;
    const next = translateText(source, locale);
    if (current !== next) element.setAttribute(attribute, next);
  }
}

function localizeTree(root: Node, locale: AppLocale): void {
  if (root.nodeType === Node.TEXT_NODE) {
    localizeTextNode(root as Text, locale);
    return;
  }
  if (!(root instanceof Element) && !(root instanceof DocumentFragment) && !(root instanceof Document)) return;
  if (root instanceof Element) localizeAttributes(root, locale);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) localizeTextNode(node as Text, locale);
    else localizeAttributes(node as Element, locale);
    node = walker.nextNode();
  }
}

export function installDomLocalizer(): () => void {
  let locale = (document.documentElement.lang === "en" ? "en" : "zh-CN") as AppLocale;
  const apply = () => localizeTree(document.body, locale);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        const node = record.target as Text;
        const current = node.nodeValue || "";
        const source = originalText.get(node);
        if (source == null || current !== translateText(source, locale)) originalText.set(node, current);
        localizeTextNode(node, locale);
        continue;
      }
      if (record.type === "attributes") {
        const element = record.target as Element;
        const attribute = record.attributeName;
        if (attribute && localizedAttributes.includes(attribute as typeof localizedAttributes[number])) {
          const originals = originalAttributes.get(element) || new Map<string, string>();
          const current = element.getAttribute(attribute) || "";
          const source = originals.get(attribute);
          if (source == null || current !== translateText(source, locale)) originals.set(attribute, current);
          originalAttributes.set(element, originals);
          localizeAttributes(element, locale);
        }
        continue;
      }
      for (const node of record.addedNodes) localizeTree(node, locale);
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...localizedAttributes]
  });
  const onLocaleChanged = (event: Event) => {
    locale = (event as CustomEvent<AppLocale>).detail;
    apply();
  };
  window.addEventListener(LOCALE_CHANGED_EVENT, onLocaleChanged);
  apply();
  return () => {
    observer.disconnect();
    window.removeEventListener(LOCALE_CHANGED_EVENT, onLocaleChanged);
  };
}
