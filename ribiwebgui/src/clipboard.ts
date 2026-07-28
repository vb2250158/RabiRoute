export type ClipboardCopyEnvironment = {
  clipboard?: Pick<Clipboard, "writeText"> | null;
  document?: Document | null;
};

function browserClipboard(): Pick<Clipboard, "writeText"> | null {
  try {
    return typeof navigator !== "undefined" ? navigator.clipboard || null : null;
  } catch {
    return null;
  }
}

function browserDocument(): Document | null {
  return typeof document !== "undefined" ? document : null;
}

export async function copyTextToClipboard(
  text: string,
  environment: ClipboardCopyEnvironment = {}
): Promise<void> {
  const clipboard = environment.clipboard === undefined
    ? browserClipboard()
    : environment.clipboard;
  if (clipboard && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return;
    } catch {
      // HTTP LAN pages and embedded browsers may expose the API but reject it.
    }
  }

  const currentDocument = environment.document === undefined
    ? browserDocument()
    : environment.document;
  if (!currentDocument?.body || typeof currentDocument.execCommand !== "function") {
    throw new Error("当前浏览器不允许自动复制，请手动选择文本复制。");
  }

  const textarea = currentDocument.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  currentDocument.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    if (!currentDocument.execCommand("copy")) {
      throw new Error("当前浏览器拒绝复制，请手动选择文本复制。");
    }
  } finally {
    currentDocument.body.removeChild(textarea);
  }
}
