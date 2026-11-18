/** Installed4.18.4 owns these fixed cache roots. Native acknowledgements do not certify that every file was removed. */
export const napcatCacheMaintenanceActions: ReadonlySet<string> = new Set(["clean_cache", "clean_stream_temp_file"]);
export const napcatCacheMaintenanceDescription = "The selected native instance owns its fixed cache paths. No caller path or filename is accepted. "
    + "The native handler may catch individual deletion errors, so the durable result records the native acknowledgement without claiming complete cleanup.";
