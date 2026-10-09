import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';

function rig(options = {}) {
  const calls = [], pending = [];
  let comments = options.comments ?? [], reads = 0, timer;
  const plugin = { info: { editorType: 'word' }, executeMethod(method, args, callback) {
    calls.push([method, args]);
    const run = () => {
      if (method === 'GetAllComments') {
        reads++;
        callback(options.badBefore && reads === 1 ? null : options.badAfter && reads > 1 ? [] : structuredClone(comments));
      } else if (method === 'AddComment') {
        comments.push({ Id: '1_949', Data: { Text: options.wrongText ? 'wrong' : args[0].Text } });
        if (options.throwAfterAdd) throw Error('native error');
        callback('1_949');
      } else if (method === 'MoveToComment') callback(undefined);
      if (options.duplicate) callback(undefined);
    };
    if (options.manual) pending.push(run); else run();
  } };
  const bridge = createR7Bridge(plugin, { editorType: 'word', clock: { now: () => 0 },
    timers: { schedule(fn) { timer = fn; return {}; }, clear() {} } });
  return { bridge, calls, pending, expire: () => timer(), comments: () => comments };
}

test('comment uses editor events, proves new internal ID and text, then reveals it', async () => {
  const f = rig({ comments: [{ Id: 'old', Data: { Text: 'note' } }] });
  assert.deepEqual(await f.bridge.insertComment({ text: 'note' }),
    { ok: true, commentsBefore: 1, commentsAfter: 2, id: '1_949', chars: 4, bytes: 4 });
  assert.deepEqual(f.calls.map(x => x[0]), ['GetAllComments', 'AddComment', 'GetAllComments', 'MoveToComment']);
  assert.deepEqual(f.calls.at(-1)[1], ['1_949']);
});

test('unreadable baseline refuses without mutation; wrong post-state holds the lease', async () => {
  const pre = rig({ badBefore: true });
  assert.equal((await pre.bridge.insertComment({ text: 'note' })).ok, false);
  assert.equal(pre.calls.length, 1);
  assert.equal(pre.bridge.getState().busy, false);
  for (const options of [{ badAfter: true }, { wrongText: true }, { throwAfterAdd: true }]) {
    const f = rig(options);
    assert.equal((await f.bridge.insertComment({ text: 'note' })).code, 'APPLY_UNCERTAIN');
    assert.equal(f.bridge.getState().busy, true);
    assert.equal((await f.bridge.insertComment({ text: 'again' })).code, 'EDITOR_BUSY');
    assert.equal(f.calls.filter(x => x[0] === 'AddComment').length, 1);
    assert.equal(f.calls.some(x => x[0] === 'MoveToComment'), false);
  }
});

test('duplicate callbacks never add or reveal twice', async () => {
  const f = rig({ duplicate: true });
  assert.equal((await f.bridge.insertComment({ text: 'note' })).ok, true);
  assert.equal(f.calls.length, 4);
});

test('malformed or excessive baseline IDs refuse before creating a comment', async () => {
  for (const comments of [
    [{ Id: '', Data: { Text: 'old' } }],
    [{ Id: 'same', Data: { Text: 'one' } }, { Id: 'same', Data: { Text: 'two' } }],
    Array.from({ length: 1001 }, (_, i) => ({ Id: String(i), Data: { Text: 'old' } })),
    [{ Id: 'old', Data: { Text: 'x'.repeat(65537) } }]
  ]) {
    const f = rig({ comments });
    assert.equal((await f.bridge.insertComment({ text: 'note' })).ok, false);
    assert.equal(f.calls.length, 1);
    assert.equal(f.bridge.getState().busy, false);
  }
});

test('invalid comment requests dispatch nothing', async () => {
  for (const request of [undefined, null, {}, { text: '' }, { text: 7 },
    { text: 'bad\u0007' }, { text: 'x'.repeat(65537) }]) {
    const f = rig();
    assert.equal((await f.bridge.insertComment(request)).code, 'TOOL_ERROR');
    assert.equal(f.calls.length, 0);
  }
});

test('cancel or timeout before dispatch prevents every late write', async () => {
  for (const action of ['abort', 'expire', 'invalidate']) {
    const f = rig({ manual: true }), controller = new AbortController();
    const p = f.bridge.insertComment({ text: 'note', signal: controller.signal });
    if (action === 'abort') controller.abort(); else if (action === 'expire') f.expire(); else f.bridge.invalidate();
    assert.equal((await p).ok, false);
    f.pending.shift()();
    assert.equal(f.calls.length, 1);
    assert.equal(f.bridge.getState().busy, false);
  }
});

test('cancel or timeout after dispatch never produces late success or another mutation', async () => {
  for (const action of ['abort', 'expire', 'invalidate']) {
    const f = rig({ manual: true }), controller = new AbortController();
    const p = f.bridge.insertComment({ text: 'note', signal: controller.signal });
    f.pending.shift()();
    if (action === 'abort') controller.abort(); else if (action === 'expire') f.expire(); else f.bridge.invalidate();
    assert.equal((await p).code, 'APPLY_UNCERTAIN');
    f.pending.shift()();
    assert.equal(f.calls.length, 2);
    assert.equal(f.bridge.getState().busy, true);
  }
});
