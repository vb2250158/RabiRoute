import fs from "node:fs";
import { registerPluginTranslations } from "../src/i18n/translationRegistry";

/** Tests of product copy activate the same source catalogs used by the real Web entries. */
export async function registerSourcePluginTranslations(): Promise<() => void> {
  const root = new URL("../../src/plugins/", import.meta.url);
  const disposers: Array<() => void> = [];
  for (const directory of fs.readdirSync(root)) {
    const entry = new URL(`${directory}/web/translations.ts`, root);
    if (!fs.existsSync(entry)) continue;
    const { pluginTranslations } = await import(entry.href);
    disposers.push(registerPluginTranslations(directory, pluginTranslations));
  }
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
