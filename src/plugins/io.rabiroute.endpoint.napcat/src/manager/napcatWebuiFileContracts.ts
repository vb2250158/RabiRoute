type Row = Record<string, unknown>;
const routes: Readonly<Record<string, {
    method: "GET" | "POST";
    fields: readonly string[];
}>> = {
    "/api/File/list": { method: "GET", fields: ["path", "onlyDirectory"] }, "/api/File/read": { method: "GET", fields: ["path"] },
    "/api/File/create": { method: "POST", fields: ["path"] }, "/api/File/mkdir": { method: "POST", fields: ["path"] }, "/api/File/delete": { method: "POST", fields: ["path"] },
    "/api/File/download": { method: "POST", fields: ["path"] }, "/api/File/write": { method: "POST", fields: ["path", "content"] },
    "/api/File/move": { method: "POST", fields: ["sourcePath", "targetPath"] }, "/api/File/rename": { method: "POST", fields: ["oldPath", "newPath"] },
    "/api/File/batchDelete": { method: "POST", fields: ["paths"] }, "/api/File/batchDownload": { method: "POST", fields: ["paths"] }, "/api/File/batchMove": { method: "POST", fields: ["items"] },
    "/api/File/font/delete/webui": { method: "POST", fields: [] }, "/api/OB11Config/ExportConfig": { method: "GET", fields: [] }
};
export function assertNapcatWebuiFileRequest(method: string, pathname: string, body: Row): boolean {
    const route = routes[pathname];
    if (!route || route.method !== method)
        return false;
    if (!body || Object.keys(body).some(k => !route.fields.includes(k)))
        throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    if (route.fields.includes("path") && pathname !== "/api/File/list" && typeof body.path !== "string")
        throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    for (const field of [
        "sourcePath", "targetPath", "oldPath", "newPath"
    ])
        if (route.fields.includes(field) && typeof body[field] !== "string")
            throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    if (pathname === "/api/File/write" && typeof body.content !== "string")
        throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    if (route.fields.includes("paths") && (!Array.isArray(body.paths) || !body.paths.length || body.paths.some(x => typeof x !== "string")))
        throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    if (route.fields.includes("items") && (!Array.isArray(body.items) || !body.items.length || body.items.some(x => !x || typeof x !== "object" || Object.keys(x).some(k => !["sourcePath", "targetPath"].includes(k)) || typeof x.sourcePath !== "string" || typeof x.targetPath !== "string")))
        throw new Error("NAPCAT_WEBUI_FILE_REQUEST_INVALID");
    return true;
}
export function assertNapcatWebuiMultipart(pathname: string, query: Row, files: readonly {
    field: string;
    filename: string;
    bytes: Uint8Array;
}[]): void {
    const fields = pathname === "/api/File/upload" ? "files" : pathname === "/api/File/font/upload/webui" ? "file" : pathname === "/api/OB11Config/ImportConfig" ? "configFile" : "";
    if (!fields || !files.length || Object.keys(query).some(k => pathname !== "/api/File/upload" || k !== "path") || pathname === "/api/File/upload" && typeof query.path !== "string")
        throw new Error("NAPCAT_WEBUI_MULTIPART_INVALID");
    for (const file of files)
        if (file.field !== fields || !file.filename || /[\\/\0]/.test(file.filename) || !(file.bytes instanceof Uint8Array))
            throw new Error("NAPCAT_WEBUI_MULTIPART_INVALID");
}
