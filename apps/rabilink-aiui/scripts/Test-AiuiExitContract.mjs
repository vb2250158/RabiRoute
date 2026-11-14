import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../pages/home/index.ink', import.meta.url), 'utf8');
const methods = source.slice(source.indexOf('  requestChatExit() {'), source.indexOf('  async executeLingzhuAgentPrompt('));
function fixture(exitMiniProgram, finish) {
  const logs = [], timers = new Set();
  const context = vm.createContext({ wx: { exitMiniProgram }, Promise, Error, Object,
    console: { info: value => logs.push(value), warn: value => logs.push(value) },
    setTimeout(fn) { timers.add(fn); return fn; }, clearTimeout(fn) { timers.delete(fn); } });
  const page = { ...vm.runInContext(`({${methods}})`, context), pageVisible: true, destroyed: false,
    data: {}, finish, setData(patch) { Object.assign(this.data, patch); } };
  return { page, logs, timeout() { for (const fn of [...timers]) fn(); }, timers };
}

test('exit waits for host acknowledgement, deduplicates requests and records no user text', async () => {
  let callbacks, calls = 0;
  const f = fixture(options => { calls++; callbacks = options; });
  const first = f.page.requestChatExit(), second = f.page.requestChatExit();
  assert.equal(first, second); assert.equal(calls, 1);
  assert.equal(f.logs.includes('[RabiLink AIUI] exit:accepted'), false);
  callbacks.success();
  assert.equal((await first).requested, true);
  callbacks.fail({ errMsg: 'private host detail' });
  assert.equal(f.timers.size, 0); assert.equal(f.page.chatExitPending, null);
  assert.deepEqual(f.logs, ['[RabiLink AIUI] exit:requested', '[RabiLink AIUI] exit:accepted']);
});

test('host rejection, throws and silence cannot return a terminal exit receipt', async () => {
  for (const behavior of ['reject', 'throw', 'silence']) {
    const f = fixture(options => {
      if (behavior === 'reject') options.fail();
      if (behavior === 'throw') throw Error('private error');
    });
    const pending = f.page.executeChatTool({ functionName: 'close_app' });
    const check = assert.rejects(pending, /APP_EXIT_(REJECTED|UNCONFIRMED)/);
    if (behavior === 'silence') f.timeout();
    await check;
    assert.equal(f.page.data.agentStatus, '退出未确认');
    assert.equal(f.logs.includes('[RabiLink AIUI] exit:accepted'), false);
    assert.equal(f.timers.size, 0);
  }
});

test('page lifecycle fences new exits and late failures do not rewrite a hidden page', async () => {
  let callbacks, calls = 0;
  const f = fixture(options => { callbacks = options; calls++; });
  const pending = f.page.requestChatExit();
  f.page.pageVisible = false;
  const before = { ...f.page.data };
  callbacks.fail();
  await assert.rejects(pending, /APP_EXIT_REJECTED/);
  assert.deepEqual(f.page.data, before);
  await assert.rejects(f.page.requestChatExit(), /APP_EXIT_PAGE_INACTIVE/);
  assert.equal(calls, 1);
});

test('Page.finish is used only when wx exit is absent; missing capability fails explicitly', async () => {
  let finishes = 0;
  const fallback = fixture(undefined, () => { finishes++; });
  assert.equal((await fallback.page.requestChatExit()).requested, true);
  assert.equal(finishes, 1);
  await assert.rejects(fixture().page.requestChatExit(), /APP_EXIT_UNAVAILABLE/);
});
