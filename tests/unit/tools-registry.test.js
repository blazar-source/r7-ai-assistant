import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defineTool, createRegistry, TOOL_DESCRIPTION_BYTES } from '../../src/tools/registry.js';
import { validateArguments } from '../../src/tools/schemas.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';

const readTool = { name: 'read_selection', description: 'Читает выделенный текст.', kind: 'read', editors: ['word'], policy: 'auto', requires: [],
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

test('registry.tools publishes no withheld descriptor, so no consumer can reach one', () => {
  const denyRead = { ...readTool, name: 'read_secret', policy: 'deny' };
  const denyMutate = { ...insertTool, name: 'delete_all', policy: 'deny' };
  const registry = createRegistry([readTool, insertTool, denyRead, denyMutate]);
  const published = registry.tools.map(tool => tool.name).sort();
  assert.deepEqual(published, ['insert_paragraph', 'read_selection'],
    'the published descriptor list is the non-denied set itself, not a filtered view of another list');
  assert.equal(published.includes('read_secret'), false);
  assert.equal(published.includes('delete_all'), false);
  assert.equal(Object.isFrozen(registry.tools), true);
  // The withheld handlers are still DEFINED (the probe-driven switch back is one policy value), they
  // are simply not reachable through the registry object's own public surface.
  assert.equal(registry.tools.some(tool => tool.policy === 'deny'), false);
  for (const mode of ['EDIT', 'ASK']) {
    const offered = registry.catalogue({ editor: 'word', capabilities: ['document.read', 'document.write'], mode });
    assert.equal(offered.some(tool => tool.name === 'read_secret'), false);
    assert.equal(offered.some(tool => tool.name === 'delete_all'), false);
  }
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

test('defineTool constructs exactly the nine validated fields from a normal descriptor', () => {
  const tool = defineTool(readTool);
  assert.deepEqual(Object.keys(tool),
    ['name', 'description', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute']);
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
  const proto = { name: 'read_proto', description: 'Читает прототипный дескриптор.', kind: 'read', editors: ['word'], policy: 'auto', requires: [],
    schema: { type: 'object', additionalProperties: false, required: [], properties: {} },
    precondition: () => null, execute: () => ({ ok: true, data: { from: 'proto' } }) };
  const descriptor = Object.create(proto);
  const tool = defineTool(descriptor);
  assert.deepEqual(Object.keys(tool),
    ['name', 'description', 'kind', 'editors', 'schema', 'policy', 'requires', 'precondition', 'execute']);
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

// --- THE MODEL-FACING GUIDANCE: an authored, bounded, static field of the descriptor ----------------
//
// The measured defect: the owner's pilot request named no tool, the model called `insert_paragraph`
// eight times (which inserts at the CURRENT CARET, so every call landed inside the title paragraph and
// the paragraph count never moved), and it never called `insert_blocks`, `set_heading`, `insert_table`
// or `format_range`. The model was given `name (kind, policy)` and nothing about what a tool is FOR, so
// the guidance has to be authored data on the descriptor rather than a guess in the model's head.
const described = description => ({ ...readTool, description });

test('defineTool requires one authored, non-empty, single-line description inside the byte bound', () => {
  assert.equal(TOOL_DESCRIPTION_BYTES, 256, 'the model-facing text bound is a named, pinned constant');
  assert.equal(defineTool(described('Читает выделение.')).description, 'Читает выделение.');
  assert.throws(() => defineTool({ ...readTool, description: undefined }), /INVALID_DATA/, 'a descriptor with no description');
  assert.throws(() => defineTool({ ...readTool, description: null }), /INVALID_DATA/);
  assert.throws(() => defineTool(described('')), /INVALID_DATA/, 'an empty description');
  assert.throws(() => defineTool(described('   ')), /INVALID_DATA/, 'a whitespace-only description');
  assert.throws(() => defineTool(described(7)), /INVALID_DATA/, 'a non-string description');
  assert.throws(() => defineTool(described('я'.repeat(300))), /INVALID_DATA/, 'past the byte bound');
  assert.throws(() => defineTool(described('первая\nвторая')), /INVALID_DATA/,
    'a second line would be injected into the one-line model-facing tool list');
});

test('the description is authored on the descriptor and can never come from call arguments', () => {
  // The authored string is COPIED onto the frozen descriptor, so a caller-controlled object is never
  // consulted again: a getter that answers differently on every read cannot make the tool's own
  // guidance change after construction.
  let reads = 0;
  const changing = { ...readTool };
  Object.defineProperty(changing, 'description', { enumerable: true,
    get() { reads += 1; return `АВТОРСКОЕ ${reads}`; } });
  const tool = defineTool(changing);
  const buildReads = reads;
  assert.ok(buildReads >= 1, 'the authored string is read while the descriptor is validated and built');
  assert.equal(tool.description, tool.description, 'the frozen tool answers one stable value');
  assert.equal(tool.description.startsWith('АВТОРСКОЕ'), true);
  assert.equal(reads, buildReads, 'no later read of the tool touches the caller-supplied object');
  assert.equal(Object.isFrozen(tool), true);
  // The model supplies `arguments`, never descriptor fields: arguments are validated against the
  // closed SCHEMA (unknown keys are refused), so nothing a caller sends can become the guidance.
  assert.throws(() => validateArguments(tool.schema, { description: 'ПОДМЕНА' }, 1024), /TOOL_ERROR/);
  assert.equal(tool.description.startsWith('АВТОРСКОЕ'), true);
});

test('the model-facing catalogue withholds confirm tools while their descriptors still resolve', () => {
  const registry = createRegistry([readTool, insertTool, cellTool, confirmTool]);
  const request = { editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' };
  const catalogue = registry.catalogue(request);
  assert.deepEqual(catalogue.map(tool => tool.name), ['read_selection', 'insert_paragraph', 'replace_selection']);
  const modelFacing = registry.modelCatalogue(catalogue);
  assert.deepEqual(modelFacing.map(tool => tool.name), ['read_selection', 'insert_paragraph'],
    'a confirm-policy tool is never named to the model, so a proposal cannot reach the run-ending PREVIEW_READY');
  assert.equal(Object.isFrozen(modelFacing), true);
  assert.deepEqual(registry.modelCatalogue(registry.catalogue({ editor: 'word', capabilities: ['document.read'], mode: 'EDIT' }))
    .map(tool => tool.name), ['read_selection']);
  assert.deepEqual(registry.modelCatalogue([]), []);
  assert.throws(() => registry.modelCatalogue('read_selection'), /INVALID_DATA/);
  // ... while the confirm descriptor STILL RESOLVES, which is what keeps the panel's Preview/Apply
  // path alive: the runtime validates the batch against `catalogue` and publishes PREVIEW_READY from
  // the descriptor it finds there (measured: withholding it from `catalogue` instead breaks 12
  // controller preview/apply tests, because `validateBatch` resolves through that very array).
  assert.equal(registry.resolve(catalogue, 'replace_selection').policy, 'confirm');
  assert.equal(registry.resolve(registry.tools, 'replace_selection').policy, 'confirm');
});

test('every published and offered descriptor carries a bounded non-empty description', () => {
  const registry = createRegistry([readTool, insertTool, cellTool, confirmTool]);
  const request = { editor: 'word', capabilities: ['document.read', 'document.write'], mode: 'EDIT' };
  const lists = [registry.tools, registry.catalogue(request), registry.modelCatalogue(registry.catalogue(request))];
  for (const list of lists) {
    for (const tool of list) {
      assert.equal(typeof tool.description, 'string', `${tool.name} carries a description`);
      assert.ok(tool.description.trim().length > 0, `${tool.name} description is not empty`);
      assert.ok(utf8ByteLength(tool.description) <= TOOL_DESCRIPTION_BYTES, `${tool.name} is inside the byte bound`);
      assert.equal(/[\u0000-\u001f\u007f]/.test(tool.description), false, `${tool.name} stays on one line`);
    }
  }
});
