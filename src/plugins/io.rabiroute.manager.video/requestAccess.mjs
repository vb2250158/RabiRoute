import fs from "node:fs/promises";

// Request-scoped fences only: background jobs must not retain this object.
export function checkedFs(access) {
  if (!access) return fs;
  const mutations = new Set(["mkdir", "copyFile", "writeFile", "rename", "open"]);
  return new Proxy(fs, { get(target, name) {
    const operation = target[name];
    if (typeof operation !== "function") return operation;
    return async (...args) => {
      const writing = mutations.has(name) && (name !== "open" || args[1] !== "r");
      if (writing) access.beforeMutation(); else access.assert();
      let value;
      try { value = await operation(...args); }
      catch (error) { access.assert(); throw error; }
      try { access.assert(); }
      catch (error) { if (name === "open") await value.close().catch(() => {}); throw error; }
      return value;
    };
  } });
}

export async function checkedReadBody(http, request, limit, access) {
  access?.assert();
  try { const body = await http.readJsonBody(request, limit); access?.assert(); return body; }
  catch (error) { access?.assert(); throw error; }
}
