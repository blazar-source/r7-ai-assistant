import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextWindow, CONTEXT_DROP_MARKER } from '../../src/agent/context.js';
import { AGENT_CEILINGS } from '../../src/shared/limits.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

function window(ceilingBytes = 400) {
  const context = createContextWindow({ ceilingBytes });
  context.append({ role: 'system', content: 'rules' });
  context.append({ role: 'user', content: 'исходная задача' });
  return context;
}

// Accounted size of the messages exactly as the window exposes them.
function accounted(messages) {
  return messages.reduce((sum, message) => sum + utf8ByteLength(message.content) + 16, 0);
}

// Every public read used by the invariant assertions, so no test restates the ceiling check
// against a private copy of the algorithm.
function totalOf(context) {
  return accounted(context.messages());
}

// Appends and records the accounted total after the append, so the invariant is checked
// after EVERY single append rather than only at the end.
function appendAndTrack(context, message, totals) {
  context.append(message);
  totals.push(totalOf(context));
  return context;
}

test('keeps everything while it fits and reports nothing dropped', () => {
  const context = window();
  context.append({ role: 'user', content: 'tool_results: small' });
  assert.equal(context.dropped(), 0);
  assert.equal(context.messages().length, 3);
});

test('evicts oldest tool results first, never the system message or the original request', () => {
  // Ceiling 500 leaves room for the 91-byte marker, so evicting A keeps C whole AND records the
  // drop. The pinned prefix is untouched.
  const context = window(500);
  context.append({ role: 'user', content: 'A'.repeat(150) });
  context.append({ role: 'user', content: 'B'.repeat(150) });
  context.append({ role: 'user', content: 'C'.repeat(150) });
  const messages = context.messages();
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.ok(context.dropped() >= 1);
  assert.ok(messages.some(message => message.content === CONTEXT_DROP_MARKER));
  assert.ok(!messages.some(message => message.content === 'A'.repeat(150)));
  // The brief's assertion, restored: evicting A leaves room for C whole, so C must survive
  // WHOLE. Truncating the newest message while an evictable older one remains is the bug.
  assert.ok(messages.some(message => message.content.startsWith('C'.repeat(150))));
});

test('inserts the drop marker once, and cumulative bytes far above the ceiling still fit each request', () => {
  const context = window(300);
  for (let index = 0; index < 40; index += 1) context.append({ role: 'user', content: `step ${index}: ` + 'X'.repeat(100) });
  const messages = context.messages();
  const markerCount = messages.filter(message => message.content === CONTEXT_DROP_MARKER).length;
  assert.equal(markerCount, 1);
  assert.ok(context.dropped() >= 30);
  assert.ok(messages.length <= 4);
});

test('a single oversized newest message is truncated, not silently kept whole', () => {
  const context = window(300);
  context.append({ role: 'user', content: 'Y'.repeat(5000) });
  const messages = context.messages();
  const total = messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8'), 0);
  assert.ok(total <= 300);
});

test('the invariant holds after every append of a long randomised sequence and the pins never move', () => {
  const ceilingBytes = 1024;
  const context = window(ceilingBytes);
  let seed = 1234567;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let step = 0; step < 600; step += 1) {
    const roll = random();
    const marker = roll < 0.4;
    const unit = marker ? '"type":"tool_results"' : roll < 0.8 ? 'м' : 'x';
    const length = 1 + Math.floor(random() * 400);
    const content = (marker ? 'q' : 'p') + `#${step} ` + unit.repeat(length);
    context.append({ role: 'user', content });
    const messages = context.messages();
    assert.ok(accounted(messages) <= ceilingBytes, `append ${step} broke the ceiling`);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[0].content, 'rules');
    assert.equal(messages[1].content, 'исходная задача');
    assert.ok(messages.every(message => typeof message.content === 'string'));
  }
  assert.ok(context.dropped() > 0);
  assert.equal(context.messages().filter(message => message.content === CONTEXT_DROP_MARKER).length, 1);
});

test('a newest message far larger than the whole window is truncated to fit, never kept whole', () => {
  const ceilingBytes = 512;
  const context = window(ceilingBytes);
  context.append({ role: 'user', content: 'H'.repeat(20000) });
  const messages = context.messages();
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.equal(messages.length, 3);
  assert.ok(accounted(messages) <= ceilingBytes);
  assert.ok(messages[2].content.length > 0);
  assert.ok(utf8ByteLength(messages[2].content) < 20000);
  assert.ok(context.dropped() >= 1);
});

test('terminates promptly under far more appends than the ceiling can hold', () => {
  const context = window(AGENT_CEILINGS.activeContextBytes);
  const content = '{"type":"tool_results","results":[]}'.padEnd(4000, 'q');
  const started = Date.now();
  for (let step = 0; step < 2000; step += 1) context.append({ role: 'user', content });
  const elapsed = Date.now() - started;
  const messages = context.messages();
  assert.ok(elapsed < 20000, `2000 appends took ${elapsed} ms`);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, 'исходная задача');
  assert.ok(accounted(messages) <= AGENT_CEILINGS.activeContextBytes);
  assert.equal(messages.filter(message => message.content === CONTEXT_DROP_MARKER).length, 1);
  assert.ok(context.dropped() > 1000);
});

test('the default ceiling comes from AGENT_CEILINGS and the reads are frozen', () => {
  const context = createContextWindow();
  assert.equal(context.totalBytes(), 0);
  context.append({ role: 'system', content: 's' });
  context.append({ role: 'user', content: 'u' });
  assert.equal(context.totalBytes(), 34);
  const messages = context.messages();
  assert.ok(Object.isFrozen(messages));
  assert.ok(messages.every(message => Object.isFrozen(message)));
  assert.throws(() => messages.push({ role: 'user', content: 'nope' }), TypeError);
  const long = createContextWindow();
  long.append({ role: 'system', content: 'rules' });
  long.append({ role: 'user', content: 'request' });
  long.append({ role: 'user', content: 'x'.repeat(AGENT_CEILINGS.activeContextBytes + 5000) });
  assert.ok(long.totalBytes() <= AGENT_CEILINGS.activeContextBytes);
  assert.throws(() => createContextWindow().append({ role: 'user', content: 7 }), /INVALID_DATA/);
});

// ---------------------------------------------------------------------------
// Fix round 1 — one test per reviewed finding.
// ---------------------------------------------------------------------------

test('FINDING 1: the newest message is identified by position, so it is never evicted as a husk', () => {
  // The reviewer's first measurement: ceiling 120 with the pins and an A/B history. Once the
  // exhausted window is under budget, the newest message must still be the last element — a
  // truncated last element at worst, never a missing one.
  const context = window(120);
  const totals = [totalOf(context)];
  appendAndTrack(context, { role: 'user', content: 'A'.repeat(150) }, totals);
  appendAndTrack(context, { role: 'user', content: 'B'.repeat(150) }, totals);
  for (const total of totals) assert.ok(total <= 120, `accounted total ${total} exceeded ceiling 120`);
  const messages = context.messages();
  assert.equal(context.totalBytes(), totalOf(context));
  assert.ok(context.totalBytes() <= 120);
  assert.ok(messages.length >= 2);
  assert.ok(messages.some(message => message.content.startsWith('B'.repeat(150)) || 'B'.repeat(150).startsWith(message.content)), 'the newest message is still the last element');
  assert.ok(messages.at(-1).content.length > 0, 'the newest message was not emptied');
  assert.ok(!messages.some(message => message.content === 'A'.repeat(150)));
  // The true marker is 105 content bytes (121 accounted), and the pins alone are 66: the two cannot
  // coexist in 120 bytes, so no marker can exist here at all. The newest message keeps the remaining
  // room instead of being emptied for a marker that could never fit.
  assert.equal(context.messages().filter(message => message.content === CONTEXT_DROP_MARKER).length, 0);
  // A refused append is atomic: it must never publish the over-budget husk it was working on.
  const refused = createContextWindow({ ceilingBytes: 20 });
  refused.append({ role: 'system', content: 'rules' });
  const beforeBytes = refused.totalBytes();
  const beforeMessages = refused.messages().map(message => message.content);
  assert.throws(() => refused.append({ role: 'user', content: 'x'.repeat(30) }), /AGENT_LIMIT/);
  assert.equal(refused.totalBytes(), beforeBytes, 'the refused append published nothing');
  assert.deepEqual(refused.messages().map(message => message.content), beforeMessages, 'the published window is unchanged');
  assert.equal(refused.messages().length, 1);
});

test('FINDING 1: at the default ceiling the invariant holds after every append', () => {
  const ceilingBytes = AGENT_CEILINGS.activeContextBytes;
  const context = createContextWindow({ ceilingBytes });
  context.append({ role: 'system', content: 'rules' });
  const totals = [totalOf(context)];
  // The reviewer's second measurement: a legal 65 479-byte first request. Sixteen bytes below
  // the ceiling it must be kept whole.
  appendAndTrack(context, { role: 'user', content: 'R'.repeat(65479) }, totals);
  assert.equal(context.totalBytes(), 65516);
  assert.ok(context.totalBytes() <= ceilingBytes);
  assert.equal(context.messages().at(-1).content.length, 65479, 'the 65 479-byte request is kept whole, not dropped');
  // Slightly larger and the request can no longer be held in addition to the pins. The only
  // acceptable outcomes are a real AGENT_LIMIT or an append that stays inside the ceiling —
  // never an over-budget window.
  const tight = createContextWindow({ ceilingBytes });
  tight.append({ role: 'system', content: 'rules' });
  const before = totalOf(tight);
  let outcome = 'accepted';
  try {
    tight.append({ role: 'user', content: 'R'.repeat(65536) });
  } catch (error) {
    assert.equal(error.code, 'AGENT_LIMIT');
    outcome = 'refused';
  }
  const after = totalOf(tight);
  assert.ok(after <= ceilingBytes, `the window was left over budget (${after} > ${ceilingBytes}) after a ${outcome} append`);
  if (outcome === 'accepted') {
    assert.equal(tight.messages().at(-1).role, 'user');
    assert.ok(utf8ByteLength(tight.messages().at(-1).content) >= 1, 'the newest message is still present');
  } else {
    assert.equal(after, before, 'a refused append must leave the window untouched');
    assert.equal(tight.messages().length, 1);
  }
});

test('FINDING 2: eviction is tried before truncation, so an evictable older message pays first', () => {
  // Ceiling 330 with B = 100 B and C = 150 B. Evicting the older messages is enough for C to survive
  // WHOLE. The reviewed bug kept B and cut the newest message, because truncation ran in the same
  // iteration as a successful eviction. The fix evicts first and truncates only when nothing is
  // evictable, so C must be present whole.
  const context = window(330);
  context.append({ role: 'user', content: 'A'.repeat(20) });
  context.append({ role: 'user', content: 'B'.repeat(100) });
  const totals = [totalOf(context)];
  appendAndTrack(context, { role: 'user', content: 'C'.repeat(150) }, totals);
  for (const total of totals) assert.ok(total <= 330, `accounted total ${total} exceeded ceiling 330`);
  const messages = context.messages();
  assert.ok(messages.some(message => message.content.startsWith('C'.repeat(150))), 'C survived whole');
  assert.ok(!messages.some(message => message.content === 'B'.repeat(100)), 'B was evicted instead of C being cut');
  assert.ok(!messages.some(message => message.content === 'A'.repeat(20)), 'the oldest message went too');
  assert.ok(context.dropped() >= 1);
  assert.equal(context.totalBytes(), totalOf(context));
});

test('FINDING 3: the original user request is pinned once anything follows it', () => {
  // The reviewer's measurement: ceiling 40 with a 30-byte request, which the module shortened to 3
  // characters. The request is the message being fitted while it is the newest one, so that much is
  // legitimate — but nothing that follows it may ever shorten it again.
  const tight = createContextWindow({ ceilingBytes: 40 });
  tight.append({ role: 'system', content: 'rules' });
  tight.append({ role: 'user', content: 'R'.repeat(30) });
  assert.ok(totalOf(tight) <= 40);
  const requestAfterFirst = tight.messages()[1].content;
  assert.ok(requestAfterFirst.length > 0 && requestAfterFirst.length <= 30);
  // Every append that follows must shorten the NEWEST message, never the request. With only the
  // pins able to fit there is nothing left to shorten, so the append is refused instead — and the
  // request keeps every byte it had.
  assert.throws(() => tight.append({ role: 'user', content: 'ф'.repeat(60) }), /AGENT_LIMIT/);
  assert.equal(tight.messages()[1].content, requestAfterFirst, 'the request kept every byte it had');
  assert.ok(totalOf(tight) <= 40, 'the window stayed inside the ceiling');
  // A second shape: this window can only hold the pins, so the following append is refused outright
  // rather than cutting the request to make room for it.
  const pin = createContextWindow({ ceilingBytes: 80 });
  pin.append({ role: 'system', content: 'rules' });
  pin.append({ role: 'user', content: 'R'.repeat(30) });
  const lockedTotal = totalOf(pin);
  const lockedRequest = pin.messages()[1].content;
  assert.ok(lockedTotal <= 80);
  assert.equal(lockedRequest.length, 30, 'the request was kept while it was the newest message');
  assert.throws(() => pin.append({ role: 'user', content: 'next' }), /AGENT_LIMIT/);
  assert.equal(pin.messages()[1].content, lockedRequest, 'the pinned request was not cut to fit the append');
  assert.equal(pin.messages()[1].content.length, 30, 'the request is still 30 bytes');
  assert.equal(totalOf(pin), lockedTotal, 'the refused append left the window untouched');
  // A request that fits is kept whole, never shortened to make room for it.
  const roomy = createContextWindow({ ceilingBytes: 120 });
  roomy.append({ role: 'system', content: 'rules' });
  roomy.append({ role: 'user', content: 'R'.repeat(80) });
  assert.equal(roomy.messages()[1].content, 'R'.repeat(80));
  assert.equal(roomy.messages()[1].content.length, 80);
});

test('FINDING 4: truncation never splits a surrogate pair', () => {
  // Ceiling 103 gives the 40-emoji newest message a budget of 47 bytes. The largest prefix whose
  // encoding fits 47 bytes is 23 code units — one code unit INTO an emoji — which is exactly where a
  // naive prefix leaves a lone high surrogate behind.
  const context = createContextWindow({ ceilingBytes: 103 });
  context.append({ role: 'system', content: 's' });
  context.append({ role: 'user', content: 'request' });
  context.append({ role: 'user', content: '\u{1F600}'.repeat(40) });
  const last = context.messages().at(-1);
  const rest = accounted(context.messages().slice(0, -1));
  const budget = 103 - rest - 16;
  let naive = 0;
  let low = 0;
  let high = '\u{1F600}'.repeat(40).length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8ByteLength('\u{1F600}'.repeat(40).slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  naive = low;
  assert.ok(naive % 2 !== 0, 'the naive cut really would split an emoji, or this test proves nothing');
  assert.ok(last.content.isWellFormed(), 'the truncated content is still well formed');
  assert.ok(!/\p{Surrogate}/u.test(last.content), 'no lone surrogate survives the cut');
  assert.equal(last.content.length % 2, 0, 'the cut lands on an emoji boundary');
  assert.ok(utf8ByteLength(last.content) <= budget + 4, 'the accounting still holds');
  assert.ok(context.totalBytes() <= 103);
  // The observer-visible proof: JSON encoding the content stays 4 bytes per emoji, never a 6-byte
  // \ud83d escape for one split pair.
  assert.equal(Buffer.byteLength(JSON.stringify(last.content), 'utf8') - 2, utf8ByteLength(last.content));
  // The narrowest shape: the cut falls between the leading 'a' and the first emoji.
  const narrow = createContextWindow({ ceilingBytes: 130 });
  narrow.append({ role: 'system', content: 'rules' });
  narrow.append({ role: 'user', content: 'request' });
  narrow.append({ role: 'user', content: 'a\u{1F600}\u{1F600}\u{1F600}' });
  const narrowLast = narrow.messages().at(-1);
  assert.ok(narrowLast.content.isWellFormed());
  assert.ok(!narrowLast.content.endsWith('\uD83D'), 'no lone high surrogate is left at the cut');
  assert.ok(narrow.totalBytes() <= 130);
});

test('FINDING 5: a caller-supplied dropMarker is protected in both eviction scans', () => {
  // The marker text itself carries the tool-results discriminator. Without the guard the marker is
  // evicted by the tool-result scan and never re-inserted; with the guard it stays at index 2.
  const dropMarker = '"type":"tool_results" marker';
  const context = createContextWindow({ ceilingBytes: 440, dropMarker });
  context.append({ role: 'system', content: 'rules' });
  context.append({ role: 'user', content: 'reply' });
  for (let index = 0; index < 12; index += 1) context.append({ role: 'user', content: `m${index}:` + 'x'.repeat(40) });
  const messages = context.messages();
  assert.equal(messages.filter(message => message.content === dropMarker).length, 1, 'the marker is still present');
  assert.ok(context.totalBytes() <= 440);
  assert.ok(context.dropped() > 0);
  // The marker is the message at index 2, exactly where it is inserted.
  assert.equal(messages[2].content, dropMarker);
});

test('FINDING 6: the tool-result scan drops the oldest result, not the oldest message', () => {
  const toolResult = '{"type":"tool_results","results":[]}';
  // §12.3 names "completed tool-result messages, then the oldest complete assistant/tool-result
  // pairs". The tool-result scan is tried first, and this test holds it to that priority: the older
  // tool result must go while the OLDER plain message A survives. Plain oldest-first eviction would
  // drop A instead, so this assertion is exactly what makes the tool-result scan observable.
  //
  // The design's separate pair branch is deliberately NOT implemented: a non-newest tool result is
  // always found by the tool-result scan first and a newest tool result is never evicted, so a pair
  // branch would be unreachable dead code. That reachability argument is recorded in the module and
  // in the Task 6 fix-round report.
  const context = window(290);
  context.append({ role: 'user', content: 'A'.repeat(20) });
  context.append({ role: 'user', content: toolResult });
  context.append({ role: 'user', content: 'B'.repeat(20) });
  context.append({ role: 'user', content: 'C'.repeat(20) });
  context.append({ role: 'user', content: 'D'.repeat(60) });
  const messages = context.messages();
  assert.ok(context.totalBytes() <= 290);
  assert.ok(!messages.some(message => message.content === toolResult), 'the tool result was dropped first');
  assert.ok(messages.some(message => message.content === 'A'.repeat(20)), 'the older plain message survived, proving the scan ran');
  assert.ok(messages.some(message => message.content === CONTEXT_DROP_MARKER), 'the drop was recorded');
  assert.equal(messages[0].content, 'rules');
  assert.equal(messages[1].content, 'исходная задача');
  assert.ok(messages.at(-1).content.startsWith('D'));
  assert.equal(context.totalBytes(), totalOf(context));
  assert.ok(messages.at(-1).content.length > 0, 'the newest message was not emptied');
});

test('FINDING 1: the invariant holds for every ceiling from 1 to 700 with mixed content', () => {
  let seed = 987654321;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let refusals = 0;
  for (let ceilingBytes = 1; ceilingBytes <= 700; ceilingBytes += 1) {
    const context = createContextWindow({ ceilingBytes });
    assert.ok(context.totalBytes() <= ceilingBytes, `empty window over budget at ${ceilingBytes}`);
    for (let step = 0; step < 12; step += 1) {
      const roll = random();
      const content = roll < 0.3
        ? '"type":"tool_results"' + 'q'.repeat(Math.floor(random() * 60))
        : roll < 0.6 ? 'м'.repeat(1 + Math.floor(random() * 40)) : 'x'.repeat(1 + Math.floor(random() * 40));
      try {
        context.append({ role: step === 0 ? 'system' : 'user', content });
      } catch (error) {
        assert.equal(error.code, 'AGENT_LIMIT', `unexpected error at ceiling ${ceilingBytes}`);
        // A refused append must be the impossible-budget case: nothing in the window is over budget
        // and adding this message could not have been accommodated.
        assert.ok(context.totalBytes() <= ceilingBytes, `ceiling ${ceilingBytes} broken by a refusal`);
        refusals += 1;
        break;
      }
      assert.ok(context.totalBytes() <= ceilingBytes, `ceiling ${ceilingBytes} broken at step ${step}`);
      const messages = context.messages();
      assert.ok(messages.every(message => message.content.isWellFormed()));
      if (messages.length > 0) assert.equal(messages[0].role, 'system');
    }
  }
  assert.ok(refusals > 0, 'the sweep must cover at least one refused append');
});
