// Host-only public SDK boundary. Executes actual authored literal function objects,
// never serialized source/vendor code. No native-effect/format compatibility claim.
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { bindPanel } from '../../src/ui/entry.js';
import { mountPanel } from '../../src/ui/view.js';
import { dom } from './dom.js';
import { htmlDocument } from './html-document.js';

export const checkpoint = () => new Promise(resolve => setImmediate(resolve));
export function nativeRig({ editor = 'word', replacement = 'replacement', mode = 'EDIT', include = true, automatic = true, returnStatus = false, script = null } = {}) {
  let time = 0; let serial = 0; const tasks = new Map(); const calls = []; const http = []; const events = {};
  const state = { id: 'PRIVATE-SYNTHETIC-DOCUMENT-ID', tracking: false, text: 'original', receipt: true, auto: automatic, contextOverride: null, throwWrite: false, waitModel: null };
  const clock = { now: () => time };
  const timers = { schedule(fn, ms) { const token = {}; tasks.set(token, { fn, at: time + ms }); return token; }, clear(token) { tasks.delete(token); } };
  const api = { GetDocumentId() { return state.id; }, GetDocument() { return { GetRangeBySelect() { assert.fail('range is presence only'); }, IsTrackRevisions() { return state.tracking; } }; }, ReplaceTextSmart() { assert.fail('write must use proven executeMethod'); } };
  function record(call, value) {
    calls.push(call); call.value = value;
    if (state.auto) call.callback(value);
    return returnStatus;
  }
  const plugin = { info: { editorType: editor }, attachEvent(name, fn) { events[name] = fn; }, detachEvent(name) { delete events[name]; },
    executeMethod(name, params, callback) {
      assert.ok(['GetSelectedText', 'ReplaceTextSmart'].includes(name), 'no other SDK methods');
      if (name === 'GetSelectedText') { assert.deepEqual(params, []); return record({ name, params, callback }, state.text); }
      const call = { name, params, callback }; const result = record(call, state.receipt);
      if (state.throwWrite) throw Error('private SDK failure');
      return result;
    },
    callCommand(body, close, recalculate, callback) {
      assert.equal(close, false); assert.equal(recalculate, false);
      const old = Object.getOwnPropertyDescriptor(globalThis, 'Api');
      let result;
      try { globalThis.Api = api; result = body(); }
      finally { if (old) Object.defineProperty(globalThis, 'Api', old); else delete globalThis.Api; }
      // Native-compatible primitive-array transport; ordinary objects are rejected.
      assert.ok(Array.isArray(result));
      const filtered = result.every(value => value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value)) ? result : undefined;
      return record({ name: result.length === 6 ? 'presence' : 'context', body, callback }, state.contextOverride ?? filtered);
    }
  };
  const tree = dom(); let bridge; let controller;
  const binding = bindPanel(plugin, tree.root, {
    // The insert confirmation parses the document export with the platform DOM; this host rig supplies the
    // fixture boundary the plugin page supplies as `document`.
    platformDocument: htmlDocument(),
    bridgeFactory(p, options) { bridge = createR7Bridge(p, { ...options, timers, clock }); return bridge; },
    controllerFactory({ bridge: b }) { controller = createController({ bridge: b, timers, clock, store: new SettingsStore(null),
      crypto: { randomUUID() { return `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`; } },
      // The controller injects this transport into the Agent Runtime, which consumes the raw
      // envelope `{ content: <model text> }` the real strict-bank transport also returns: the ASK
      // answer or the EDIT replacement proposal is a scripted model envelope, not a parsed object.
      transport: async (...args) => {
        http.push(args);
        if (state.waitModel) await state.waitModel;
        // An optional scripted envelope sequence lets one run script a later step (for example a
        // refusal followed by a plain final answer).
        const scripted = script === null ? null : script(http.length);
        if (scripted !== null) return { content: JSON.stringify(scripted) };
        const model = mode === 'ASK' ? { type: 'final', message: 'answer' }
          : { type: 'tool_calls', calls: [{ tool: 'replace_selection', arguments: { text: replacement } }] };
        return { content: JSON.stringify(model) };
      }
    }); return controller; }, viewFactory: mountPanel
  });
  plugin.init(); controller.saveSettings({ endpoint: 'https://example.invalid/v1/chat/completions', apiKey: 'synthetic' });
  controller.setMode(mode); controller.setIncludeContext(include);
  return { ...tree, plugin, state, calls, http, tasks, events, binding, bridge, controller,
    writes() { return calls.filter(call => call.name === 'ReplaceTextSmart'); },
    advance(ms, fire = true) { time += ms; if (fire) for (const [token, task] of [...tasks]) if (task.at <= time) { tasks.delete(token); task.fn(); } },
    async preview() { assert.equal(await controller.analyze('edit'), true); assert.ok(controller.getState().preview); },
    close() { binding.dispose(); }
  };
}
