/** The native account owns the original C2C transfer and its destination. These requests never accept a filesystem path. */
export const napcatOnlineTransferActions: ReadonlySet<string> = new Set(["receive_online_file", "refuse_online_file", "cancel_online_file"]);
export const napcatOnlineTransferDescription = "The original native OnlineApi owns the C2C peer and message/element transfer IDs. "
    + "The response acknowledges this receive/refuse/cancel request only. It does not certify completed file transfer or provide a downloaded resource. "
    + "No caller destination, URL or host path is accepted. The original durable receipt prevents automatic repetition after an uncertain native response.";
