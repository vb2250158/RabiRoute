import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  submitWorkbuddyDesktopComposer, WorkbuddyDesktopSubmissionDeclined, type WorkbuddyDesktopComposerPort
} from "./workbuddyDesktopComposer.js";

const target = { value: "space-right", cwd: "C:/Projects/shared", label: "shared" };
const other = { value: "space-wrong", cwd: "D:/Projects/shared", label: "shared" };
const workspace = "c:\\Projects\\shared\\";
const prompt = "Create a test chat.";

function fixture(initial = other, options = [other, target]) {
  let open = false;
  let selected = initial;
  const selectedOptions: string[] = [];
  const events: string[] = [];
  const editor = {
    textContent: "",
    get innerText() { return this.textContent; },
    contains: () => false
  };
  const send = {
    get disabled() { return !editor.textContent; },
    getAttribute: () => null,
    click: () => { events.push("send"); }
  };
  const picker = {
    getAttribute: () => String(open),
    click: () => { open = !open; }
  };
  const rows = options.map(option => ({
    textContent: option.label,
    getClientRects: () => [1],
    getAttribute: () => null,
    click: () => {
      selected = option;
      selectedOptions.push(option.value);
      open = false;
    }
  }));
  const selections = () => ({ cwd: selected.cwd, spaceId: selected.value });
  type Fiber = { child?: Fiber; sibling?: Fiber; return?: Fiber; [key: string]: unknown };
  const root = { stateNode: { current: {} } } as Fiber & { stateNode: { current: Fiber } };
  root.stateNode.current = root;
  function attach(parent: Fiber, properties: object): Fiber {
    return { return: parent, ...properties };
  }
  const scope = attach(root, {
    type: function InputBoxScope() {},
    memoizedProps: {
      providers: { workspace: { options, selectionMode: "space" } },
      get selections() { return selections(); },
      store: { getSnapshot: () => ({ draft: { selections: selections() } }) }
    }
  });
  const component = attach(scope, { type: function WorkspacePicker() {} });
  const buttonFiber = attach(component, { stateNode: picker });
  function bind(element: object, fiber: object) {
    Object.defineProperty(element, "__reactFiber$fixture", { value: fiber, enumerable: true });
  }
  bind(picker, buttonFiber);
  root.child = scope;
  scope.child = component;
  component.child = buttonFiber;
  let previous = buttonFiber;
  rows.forEach((row, index) => {
    const fragment = attach(component, { tag: 7, key: options[index].value });
    const rowFiber = attach(fragment, { stateNode: row });
    bind(row, rowFiber);
    fragment.child = rowFiber;
    previous.sibling = fragment;
    previous = fragment;
  });
  const page = {
    querySelectorAll: (selector: string) => selector.includes("contenteditable") ? [editor] : [send]
  };
  const document = {
    activeElement: null as unknown,
    querySelector: () => page,
    querySelectorAll: (selector: string) => {
      if (selector === ".wb-home-page") return [page];
      if (selector.includes("button.cr-workspace-picker")) return [picker];
      return open ? rows : [];
    }
  };
  const port: WorkbuddyDesktopComposerPort = {
    evaluate: async <T>(expression: string): Promise<T> => runInNewContext(expression, { document }) as T,
    focusComposer: async expression => {
      assert.equal(runInNewContext(expression, { document }), editor);
      document.activeElement = editor;
    },
    enableRendererFocus: async () => {},
    insertText: async text => { events.push("type"); editor.textContent = text; },
    observeWindow: async () => ({ window: 1, minimized: true, isForeground: false })
  };
  return {
    events,
    selectedOptions,
    choose: (option: typeof target) => { selected = option; },
    submit: (onArm?: () => void) => submitWorkbuddyDesktopComposer(port, {
      workspace, prompt, beforeSubmit: () => { events.push("arm"); onArm?.(); }
    })
  };
}

test("chooses the native workspace identity among identical display names", async () => {
  const app = fixture();
  await app.submit();
  assert.deepEqual(app.selectedOptions, [target.value]);
  assert.deepEqual(app.events, ["type", "arm", "send"]);
});

test("existing selection of a different directory with the same display name cannot type or send", async () => {
  const app = fixture(other, [other]);
  await assert.rejects(app.submit(), /无法验证目标工作区的完整路径/);
  assert.deepEqual(app.selectedOptions, []);
  assert.deepEqual(app.events, []);
});

test("a displayed option without a native full path cannot type, arm, or send", async () => {
  const unknown = { ...target, cwd: "shared" };
  const app = fixture(unknown, [unknown, other]);
  await assert.rejects(app.submit(), /无法验证目标工作区的完整路径/);
  assert.deepEqual(app.events, []);
});

test("a correctly preselected workspace sends once without changing the picker", async () => {
  const app = fixture(target);
  await app.submit();
  assert.deepEqual(app.selectedOptions, []);
  assert.deepEqual(app.events, ["type", "arm", "send"]);
});

test("rechecks the selected path in the same renderer command that clicks Send", async () => {
  const app = fixture(target);
  await assert.rejects(app.submit(() => app.choose(other)), WorkbuddyDesktopSubmissionDeclined);
  assert.deepEqual(app.events, ["type", "arm"]);
});
