import type { HomeDirectoryPage } from "../../src/shared/homeDeviceQueryContract.js";

/** Collect explicitly requested detail pages without accepting a partial directory. */
export async function readHomeDirectory<T>(path: string, read: (url: string) => Promise<HomeDirectoryPage<T>>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  let expectedTotal: number | undefined;
  for (let count = 0; count < 1000; count++) {
    const url = new URL(path, "http://localhost");
    url.searchParams.set("offset", String(offset));
    const page = await read(url.pathname + url.search);
    if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset
      || expectedTotal !== undefined && page.total !== expectedTotal) throw Error("Device directory changed or returned an invalid page; refresh before continuing.");
    expectedTotal = page.total;
    items.push(...page.items);
    if (page.nextOffset === null) {
      if (items.length !== page.total) throw Error("Device directory is incomplete; refresh before continuing.");
      return items;
    }
    if (page.nextOffset !== offset + page.items.length || page.nextOffset <= offset) throw Error("Device directory pagination did not advance.");
    offset = page.nextOffset;
  }
  throw Error("Device directory exceeds the page budget; use a narrower query.");
}
