import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';

// Real bridge and authored SDK body; only the external editor is doubled.
// Astra Word stores Push results even when isCalc=false leaves its canvas stale.
function rig({ failSecondPush = false } = {}) {
  const paragraphs = [{ GetText: () => 'Original paragraph' }];
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
    CreateParagraph() {
      let text = '';
      return { AddText(value) { text += value; }, SetStyle() {}, GetText: () => text };
    }
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
