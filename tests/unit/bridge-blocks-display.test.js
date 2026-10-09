import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';

// Real bridge and authored SDK body; only the external editor is doubled.
// Astra Word stores Push results even when isCalc=false leaves its canvas stale.
function rig({ failSecondPush = false, texts = ['Original paragraph'], failSecondInsert = false, missingInsert = false, corruptTail = false, noOpInsert = false, wrongPosition = false } = {}) {
  let insertions = 0;
  const paragraphs = [];
  function makeParagraph(initial = '') {
    let text = initial;
    const paragraph = { AddText(value) { text += value; }, SetStyle() {}, GetText: () => text };
    if (!missingInsert) paragraph.InsertParagraph = function (created, position) {
      assert.equal(position, 'after');
      if (failSecondInsert && insertions === 1) throw new Error('Native partial insert');
      insertions++;
      if (!noOpInsert) paragraphs.splice(wrongPosition ? paragraphs.length : paragraphs.indexOf(paragraph) + 1, 0, created);
      if (corruptTail) paragraphs[paragraphs.length - 1].AddText('corrupted');
      return paragraph;
    };
    return paragraph;
  }
  paragraphs.push(...texts.map(makeParagraph));
  const commands = [];
  const namespace = {};
  const api = {
    GetDocument: () => ({
      GetAllParagraphs: () => paragraphs.slice(),
      GetAllHeadingParagraphs: () => [],
      GetStyle: () => null,
      Push(paragraph) {
        if (failSecondPush && paragraphs.length === 2) throw new Error('Native partial write');
        paragraphs.push(paragraph);
      }
    }),
    CreateParagraph() { return makeParagraph(); }
  };
  const plugin = {
    info: { editorType: 'word' },
    callCommand(body, close, recalculate, callback) {
      const source = Function.prototype.toString.call(body);
      const result = new Function('Api', 'scope', 'return (' + source + ')();')(api, namespace.scope);
      commands.push({ close, recalculate });
      callback(result);
    }
  };
  const bridge = createR7Bridge(plugin, { editorType: 'word', ascNamespace: namespace });
  return { bridge, commands, text: () => paragraphs.map(p => p.GetText()) };
}

test('Word append requests layout recalculation in the write command and keeps the panel open', async () => {
  const r = rig();
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'Introduction one' }, { text: 'Introduction two' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(r.text(), ['Original paragraph', 'Introduction one', 'Introduction two']);
  assert.deepEqual(r.commands, [{ close: false, recalculate: true }],
    'the insertion itself must refresh Word; no later read or user action may be needed');
  assert.equal(r.bridge.getState().busy, false);
});

test('anchored blocks preserve order and all preceding/following paragraphs', async () => {
  const r = rig({ texts: ['Before', 'Unique heading', 'Tail'] });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'First' }, { text: 'Second' }], afterParagraphText: 'Unique heading' });
  assert.equal(result.ok, true);
  assert.deepEqual(r.text(), ['Before', 'Unique heading', 'First', 'Second', 'Tail']);
  assert.equal(r.commands[0].recalculate, true);
});

for (const texts of [['Before', 'Tail'], ['Unique heading', 'Unique heading']]) test(`missing/ambiguous anchor refuses without append: ${texts}`, async () => {
  const r = rig({ texts });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'New' }], afterParagraphText: 'Unique heading' });
  assert.equal(result.ok, false); assert.equal(result.code, 'TOOL_ERROR');
  assert.deepEqual(r.text(), texts); assert.equal(r.bridge.getState().busy, false);
});

test('an unavailable anchor method refuses before writing', async () => {
  const r = rig({ texts: ['Anchor', 'Tail'], missingInsert: true });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'New' }], afterParagraphText: 'Anchor' });
  assert.equal(result.code, 'CAPABILITY_UNAVAILABLE'); assert.deepEqual(r.text(), ['Anchor', 'Tail']);
});

for (const options of [{ failSecondInsert: true }, { corruptTail: true }, { noOpInsert: true }, { wrongPosition: true }]) test(`partial anchored insert or changed old text retains uncertain ownership: ${JSON.stringify(options)}`, async () => {
  const r = rig({ texts: ['Anchor', 'Tail'], ...options });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'First' }, { text: 'Second' }], afterParagraphText: 'Anchor' });
  assert.equal(result.code, 'APPLY_UNCERTAIN'); assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.commands.length, 1);
});

test('Word partial append remains uncertain without retry when layout recalculation is requested', async () => {
  const r = rig({ failSecondPush: true });
  const result = await r.bridge.insertBlocks({ blocks: [{ text: 'Introduction one' }, { text: 'Introduction two' }] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPLY_UNCERTAIN');
  assert.deepEqual(r.text(), ['Original paragraph', 'Introduction one']);
  assert.equal(r.commands.length, 1);
  assert.equal(r.bridge.getState().busy, true);
  assert.equal(r.bridge.getState().uncertain, true);
});
