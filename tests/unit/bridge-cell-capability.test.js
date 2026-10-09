import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createR7Bridge } from '../../src/plugin/bridge.js';

for (const transport of ['callCommand', 'executeCommand']) {
  test(`Cell ${transport} probes its range even when the exported Word getter throws`, async () => {
    let wordReads = 0; let writes = 0;
    const Api = {
      GetDocument() { wordReads++; throw Error('Word root unavailable in Cell'); },
      GetActiveSheet() { return { GetRange() { return { GetValue() { return ''; }, SetValue() { writes++; } }; } }; }
    };
    const plugin = { info: { editorType: 'cell' } };
    if (transport === 'callCommand') plugin.callCommand = (body, _close, _recalc, cb) => cb(JSON.parse(JSON.stringify(runInNewContext(`(${body})();`, { Api }))));
    else plugin.executeCommand = (_command, source, cb) => cb(JSON.parse(JSON.stringify(runInNewContext(source, { Api }))));
    const bridge = createR7Bridge(plugin, { editorType: 'cell' });
    const result = await bridge.probeCapabilities();
    assert.equal(result.selectionRead.available, true);
    assert.equal(result.mutation.available, true);
    assert.equal(wordReads, 0); assert.equal(writes, 0);
    bridge.dispose();
  });
}

test('Cell range without a setter exposes reads only; a missing sheet fails closed', async () => {
  for (const [sheet, read, write] of [[{ GetRange() { return { GetValue() {} }; } }, true, false], [null, false, false]]) {
    const plugin = { info: { editorType: 'cell' }, callCommand(body, _close, _recalc, cb) {
      cb(JSON.parse(JSON.stringify(runInNewContext(`(${body})();`, { Api: { GetActiveSheet() { return sheet; } } }))));
    } };
    const bridge = createR7Bridge(plugin, { editorType: 'cell' });
    const result = await bridge.probeCapabilities();
    assert.equal(result.selectionRead.available, read); assert.equal(result.mutation.available, write);
    bridge.dispose();
  }
});
