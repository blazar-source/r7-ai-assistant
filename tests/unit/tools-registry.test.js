import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, createRegistry } from '../../src/tools/registry.js';

const readTool = { name: 'read_selection', kind: 'read', editors: ['word'], policy: 'auto', requires: [],
  schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
  precondition: () => null, execute: () => ({ ok: true, data: {} }) };
const insertTool = { ...readTool, name: 'insert_paragraph', kind: 'mutate', policy: 'auto',
  schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', maxBytes: 8192 } } } };
const cellTool = { ...readTool, name: 'read_range', editors: ['cell'] };
const confirmTool = { ...insertTool, name: 'replace_selection', policy: 'confirm' };

test('descriptor validation rejects malformed descriptors', () => {
  assert.throws(() => defineTool({ ...readTool, name: 'Bad Name' }), /INVALID_DATA/);
  assert.throws(() => defineTool({ ...readTool, kind: 'write' }), /INVALID_DATA/);
  assert.throws(() => defineTool({ ...readTool, editors: [] }), /INVALID_DATA/);
  assert.throws(() => defineTool({ ...readTool, policy: 'maybe' }), /INVALID_DATA/);
  assert.throws(() => defineTool({ ...readTool, execute: 'run()' }), /INVALID_DATA/);
  assert.throws(() => defineTool({ ...readTool, extra: 1 }), /INVALID_DATA/);
  assert.equal(Object.isFrozen(defineTool(readTool)), true);
});

test('registry rejects duplicate names', () => {
  assert.throws(() => createRegistry([readTool, { ...readTool }]), /INVALID_DATA/);
});

test('catalogue filters by editor, capability and ASK mode', () => {
  const registry = createRegistry([readTool, insertTool, cellTool, confirmTool]);
  const full = ['document.read', 'document.write'];
  const wordEdit = registry.catalogue({ editor: 'word', capabilities: full, mode: 'EDIT' }).map(tool => tool.name).sort();
  assert.deepEqual(wordEdit, ['insert_paragraph', 'read_selection', 'replace_selection']);
  const wordAsk = registry.catalogue({ editor: 'word', capabilities: full, mode: 'ASK' }).map(tool => tool.name);
  assert.deepEqual(wordAsk, ['read_selection']);
  const cellAsk = registry.catalogue({ editor: 'cell', capabilities: full, mode: 'ASK' }).map(tool => tool.name);
  assert.deepEqual(cellAsk, ['read_range']);
  const readOnly = registry.catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'EDIT' })
    .filter(tool => tool.kind === 'mutate');
  assert.deepEqual(readOnly.map(tool => tool.name), []);
  assert.deepEqual(registry.catalogue({ editor: 'word', capabilities: [], mode: 'EDIT' }), []);
});

test('resolve is an allowlist lookup and never returns an unlisted handler', () => {
  const registry = createRegistry([readTool, insertTool]);
  // The lookup is only meaningful against a populated catalogue: with no grants every tool is
  // filtered out (asserted above), so resolve could only ever return null.
  const catalogue = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  assert.equal(registry.resolve(catalogue, 'insert_paragraph').name, 'insert_paragraph');
  assert.equal(registry.resolve(catalogue, 'read_selection').kind, 'read');
  assert.equal(registry.resolve(catalogue, 'nothing_here'), null);
  assert.equal(registry.resolve(catalogue, 'toString'), null);
  assert.equal(registry.resolve(catalogue, '__proto__'), null);
});
