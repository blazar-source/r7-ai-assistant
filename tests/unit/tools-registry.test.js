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

test('defineTool freezes its own copies of editors and requires', () => {
  const input = { ...readTool, editors: ['word'], requires: ['document.read'] };
  const tool = defineTool(input);
  assert.equal(Object.isFrozen(tool.editors), true);
  assert.equal(Object.isFrozen(tool.requires), true);
  assert.notEqual(tool.editors, input.editors);
  assert.notEqual(tool.requires, input.requires);
});

test('mutating a descriptor after defineTool cannot change the catalogue', () => {
  const input = { ...readTool, editors: ['word'], requires: ['document.read'] };
  const registry = createRegistry([input]);
  input.editors.push('cell');
  input.requires.push('document.write');
  const cell = registry.catalogue({ editor: 'cell', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  const word = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' });
  assert.deepEqual(cell.map(tool => tool.name), []);
  assert.deepEqual(word.map(tool => tool.name), ['read_selection']);
});

test('catalogue always omits deny tools while keeping their non-deny counterparts', () => {
  const denyRead = { ...readTool, name: 'read_secret', policy: 'deny' };
  const denyMutate = { ...insertTool, name: 'delete_all', policy: 'deny' };
  const registry = createRegistry([readTool, insertTool, denyRead, denyMutate]);
  const full = ['document.read', 'document.write'];
  const edit = registry.catalogue({ editor: 'word', capabilities: full, mode: 'EDIT' }).map(tool => tool.name).sort();
  assert.deepEqual(edit, ['insert_paragraph', 'read_selection']);
  const ask = registry.catalogue({ editor: 'word', capabilities: full, mode: 'ASK' }).map(tool => tool.name).sort();
  assert.deepEqual(ask, ['read_selection']);
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

test('defineTool constructs exactly the eight validated fields from a normal descriptor', () => {
  const tool = defineTool(readTool);
  assert.deepEqual(Object.keys(tool),
    ['name', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute']);
  assert.equal(tool.name, 'read_selection');
  assert.equal(tool.kind, 'read');
  assert.equal(tool.schema, readTool.schema);
  assert.equal(tool.execute, readTool.execute);
  assert.equal(tool.precondition, readTool.precondition);
  assert.equal(Object.isFrozen(tool.editors), true);
  assert.equal(Object.isFrozen(tool.requires), true);
  assert.notEqual(tool.editors, readTool.editors);
  assert.notEqual(tool.requires, readTool.requires);
});

test('a descriptor carrying its fields on the prototype still yields a complete usable tool', () => {
  // Object.keys() only enumerates own properties, so the enumerable-key allowlist cannot see
  // these fields; the tool must be assembled from the validated values, never from the spread.
  const proto = { name: 'read_proto', kind: 'read', editors: ['word'], policy: 'auto', requires: [],
    schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    precondition: () => null, execute: () => ({ ok: true, data: { from: 'proto' } }) };
  const descriptor = Object.create(proto);
  const tool = defineTool(descriptor);
  assert.deepEqual(Object.keys(tool),
    ['name', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute']);
  assert.equal(tool.execute, proto.execute);
  const registry = createRegistry([descriptor]);
  const listed = registry.catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'EDIT' });
  assert.deepEqual(listed.map(entry => entry.name), ['read_proto']);
  assert.deepEqual(registry.resolve(listed, 'read_proto').execute(), { ok: true, data: { from: 'proto' } });
});

test('a non-enumerable execute cannot become a catalogue entry with no handler', () => {
  const descriptor = { ...readTool, name: 'read_hidden' };
  Object.defineProperty(descriptor, 'execute', { value: readTool.execute, enumerable: false });
  const tool = defineTool(descriptor);
  assert.equal(typeof tool.execute, 'function');
  const listed = createRegistry([descriptor]).catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'EDIT' });
  assert.deepEqual(listed.map(entry => entry.name), ['read_hidden']);
  assert.equal(listed[0].execute, readTool.execute);
});

test('catalogue rejects a mode, capabilities or editor it cannot interpret', () => {
  const registry = createRegistry([readTool, insertTool]);
  assert.throws(() => registry.catalogue({ editor: 'word', capabilities: [], mode: 'ask' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: 'word', capabilities: [] }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: 'word', capabilities: [], mode: true }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: 'word', capabilities: 'document.read', mode: 'EDIT' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: 'word', capabilities: [7], mode: 'EDIT' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: '', capabilities: [], mode: 'EDIT' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ editor: null, capabilities: [], mode: 'EDIT' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue({ capabilities: [], mode: 'EDIT' }), /INVALID_DATA/);
  assert.throws(() => registry.catalogue(null), /INVALID_DATA/);
  assert.throws(() => registry.catalogue(undefined), /INVALID_DATA/);
  const full = ['document.read', 'document.write'];
  assert.deepEqual(registry.catalogue({ editor: 'word', capabilities: full, mode: 'ASK' })
    .filter(tool => tool.kind === 'mutate'), []);
  assert.deepEqual(registry.catalogue({ editor: 'word', capabilities: full, mode: 'EDIT' })
    .filter(tool => tool.kind === 'mutate').map(tool => tool.name), ['insert_paragraph']);
});

test('createRegistry rejects a descriptors argument that is not an array', () => {
  assert.throws(() => createRegistry(null), /INVALID_DATA/);
  assert.throws(() => createRegistry(undefined), /INVALID_DATA/);
  assert.throws(() => createRegistry('read_selection'), /INVALID_DATA/);
});
