import { setTimeout as delay } from "node:timers/promises";

/** Commands used only on the installed WorkBuddy main renderer's private pipe. */
export interface WorkbuddyDesktopComposerPort {
  evaluate<T>(expression: string): Promise<T>;
  focusComposer(expression: string): Promise<void>;
  enableRendererFocus(): Promise<void>;
  disableRendererFocus?(): Promise<void>;
  insertText(text: string): Promise<void>;
  observeWindow(): Promise<{ window: number; minimized: boolean; isForeground: boolean }>;
}

const composer = `function findComposer() {
  const pages = document.querySelectorAll('.wb-home-page');
  if (pages.length !== 1) return null;
  const editor = pages[0].querySelectorAll('.cr-input-container [contenteditable="true"]');
  const send = pages[0].querySelectorAll('button.cr-send-button');
  if (editor.length !== 1 || send.length !== 1) return null;
  return { editor: editor[0], send: send[0] };
}
function enabled(button) {
  return !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}
function empty(c) {
  if (!c || enabled(c.send)) return false;
  const text = c.editor.textContent.trim();
  return !text || (text.length === 25 && text.includes('添加上下文') && text.includes('调用技能')
    && c.editor.children.length === 1 && c.editor.firstElementChild.tagName === 'P');
}`;

// WorkBuddy 5.11 renders only a label on the trigger. Read the committed
// InputBoxScope and the native input store that supplies HomeInput's send draft.
const workspacePicker = String.raw`function committedAncestors(element) {
  const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'));
  const path = [];
  for (let fiber = key && element[key]; fiber; fiber = fiber.return) path.push(fiber);
  const root = path.pop();
  let current = root?.stateNode?.current;
  if (!current || (current !== root && current !== root.alternate)) return [];
  const ancestors = [];
  for (const entry of path.reverse()) {
    let child = current.child;
    while (child && child !== entry && child !== entry.alternate) child = child.sibling;
    if (!child) return [];
    ancestors.unshift(child);
    current = child;
  }
  return current.stateNode === element ? ancestors : [];
}
function workspacePath(value) {
  if (typeof value !== 'string') return '';
  let path = value.trim().replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+)/i.test(path) || /(?:^|\\)\.{1,2}(?:\\|$)/.test(path)) return '';
  return (path.length === 3 ? path : path.replace(/\\+$/, '')).toLowerCase();
}
function readWorkspace() {
  const controls = document.querySelectorAll('.wb-home-page button.cr-workspace-picker');
  if (controls.length !== 1) return null;
  const picker = controls[0];
  const ancestors = committedAncestors(picker);
  const component = ancestors.find(fiber => fiber.type?.name === 'WorkspacePicker');
  const scope = ancestors.find(fiber => fiber.type?.name === 'InputBoxScope')?.memoizedProps;
  const provider = scope?.providers?.workspace;
  if (!component || !provider || provider.selectionPending || !Array.isArray(provider.options)
    || (provider.selectionMode !== 'space' && provider.selectionMode !== 'cwd')
    || typeof scope.store?.getSnapshot !== 'function') return null;
  const draft = scope.store.getSnapshot()?.draft?.selections;
  if (!draft) return null;
  const isSpace = provider.selectionMode === 'space';
  const options = provider.options;
  const optionPath = option => option.disabled || option.clickOnly || typeof option.value !== 'string'
    || option.value.startsWith('__') ? '' : workspacePath(isSpace ? option.cwd : option.value);
  const value = isSpace ? draft.spaceId : draft.cwd;
  const matches = options.filter(option => option.value === value);
  const cwd = workspacePath(draft.cwd);
  const selected = matches.length === 1 && !!cwd && optionPath(matches[0]) === cwd
    && workspacePath(scope.selections?.cwd) === cwd
    && (isSpace ? scope.selections.spaceId === value : !draft.spaceId && !scope.selections?.spaceId) ? cwd : '';
  return { picker, component, selected, options, optionPath };
}
function findWorkspaceChoice(state, keys) {
  const rows = [...document.querySelectorAll('.cr-workspace-picker-dropdown .cr-workspace-picker-popover__item[role="menuitemradio"]')];
  return rows.filter(row => {
    if (!row.getClientRects().length || row.getAttribute('aria-disabled') === 'true') return false;
    const ancestors = committedAncestors(row);
    const fragment = ancestors.find(fiber => fiber.tag === 7 && typeof fiber.key === 'string');
    return !!fragment && keys.includes(fragment.key) && ancestors.includes(state.component);
  });
}`;

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, signal?: AbortSignal): Promise<T> {
  const deadline = performance.now() + 2500;
  while (true) {
    signal?.throwIfAborted();
    const value = await read();
    if (ready(value) || performance.now() >= deadline) return value;
    await delay(100, undefined, { signal });
  }
}

/** Submits the app's real new-task composer. The caller reconciles the native ID and receipt. */
export async function submitWorkbuddyDesktopComposer(
  port: WorkbuddyDesktopComposerPort,
  input: {
    workspace: string;
    prompt: string;
    beforeSubmit: () => void | Promise<void>;
    signal?: AbortSignal;
  }
): Promise<void> {
  const workspace = input.workspace.trim();
  const prompt = input.prompt.replace(/\r\n/g, "\n");
  if (!workspace || !prompt.trim()) throw new Error("WorkBuddy 创建会话需要已登记的工作区和首条消息。");
  input.signal?.throwIfAborted();
  const start = await port.observeWindow();
  if (!start.minimized || start.isForeground) throw new Error("WorkBuddy 主窗口需要处于最小化状态。");
  await port.enableRendererFocus();

  await port.evaluate(`(() => {
    if (document.querySelector('.wb-home-page')) return;
    const tabs = [...document.querySelectorAll('.conversation-list-tab-button[role="tab"]')].filter(tab =>
      [tab.getAttribute('aria-label'), tab.getAttribute('title'), tab.textContent.trim()]
        .some(label => label === '新建任务' || label === 'New Task'));
    if (tabs.length === 1) tabs[0].click();
  })()`);
  const expectedPath = `const expectedPath = workspacePath(${JSON.stringify(workspace)});`;
  const choice = await waitFor(() => port.evaluate<string>(`(() => { ${workspacePicker} ${expectedPath}
    if (!expectedPath) return 'invalid';
    const state = readWorkspace();
    if (!state) return 'unavailable';
    if (state.selected === expectedPath) return 'selected';
    const keys = state.options.filter(option => state.optionPath(option) === expectedPath).map(option => option.value);
    if (keys.length !== 1) return 'unverified';
    if (state.picker.getAttribute('aria-expanded') !== 'true') {
      state.picker.click();
      return 'opening';
    }
    const choices = findWorkspaceChoice(state, keys);
    if (choices.length !== 1) return 'waiting';
    choices[0].click();
    return 'selected';
  })()`), result => !["unavailable", "opening", "waiting"].includes(result), input.signal);
  if (choice !== "selected") throw new Error("WorkBuddy 无法验证目标工作区的完整路径，首条消息尚未填写。");

  const selected = `${workspacePicker} ${expectedPath}
    if (!expectedPath || readWorkspace()?.selected !== expectedPath) return false;`;
  const isSelected = await waitFor(() => port.evaluate<boolean>(`(() => { ${selected} return true; })()`), Boolean, input.signal);
  if (!isSelected) throw new Error("WorkBuddy 原生输入框未确认目标工作区的完整路径，首条消息尚未填写。");
  const editable = `(() => { ${composer} const c = findComposer(); return empty(c) ? c.editor : null; })()`;
  await port.focusComposer(editable);
  const ready = await port.evaluate<boolean>(`(() => { ${composer} ${selected}
    const c = findComposer();
    if (!empty(c) || (document.activeElement !== c.editor && !c.editor.contains(document.activeElement))) return false;
    if (c.editor.textContent.trim()) {
      const range = document.createRange(); range.selectNodeContents(c.editor);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }
    return true;
  })()`);
  if (!ready) throw new Error("WorkBuddy 无法同时确认目标工作区和可用的空输入框，首条消息尚未填写。");

  input.signal?.throwIfAborted();
  await port.insertText(prompt);
  const readyToSend = `${composer} ${selected} const c = findComposer(); const expected = ${JSON.stringify(prompt)};
    if (!c || (c.editor.innerText !== expected && c.editor.textContent !== expected) || !enabled(c.send)) return false;`;
  const populated = await waitFor(() => port.evaluate<boolean>(`(() => { ${readyToSend} return true; })()`), Boolean, input.signal);
  if (!populated) throw new Error("WorkBuddy 无法确认目标工作区或首条消息，尚未提交。");
  const current = await port.observeWindow();
  if (current.window !== start.window || !current.minimized || current.isForeground) throw new Error("WorkBuddy 主窗口状态已变化，未提交。");
  input.signal?.throwIfAborted();
  const confirmed = await port.evaluate<boolean>(`(() => { ${readyToSend} return true; })()`);
  if (!confirmed) throw new Error("WorkBuddy 提交前无法确认目标工作区或首条消息，尚未提交。");
  await input.beforeSubmit();
  const sent = await port.evaluate<boolean>(`(() => { ${readyToSend} c.send.click(); return true; })()`);
  if (!sent) throw new WorkbuddyDesktopSubmissionDeclined();
  const after = await port.observeWindow();
  if (after.window !== start.window || !after.minimized || after.isForeground) {
    throw new Error("WorkBuddy 提交后窗口状态变化，请核对原创建意图。");
  }
}

export class WorkbuddyDesktopSubmissionDeclined extends Error {
  constructor() {
    super("WorkBuddy 提交时无法确认目标工作区或首条消息，尚未提交。");
  }
}
