// Descriptions supplement the enforced schemas now included in the model request
// (agent-runtime.test.js verifies the actual wire). Keep required names and units
// discoverable; optional property names and bounds come from the complete schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCellTools } from '../../src/tools/cell.js';
import { utf8ByteLength } from '../../src/shared/bytes.js';
import { TOOL_DESCRIPTION_BYTES } from '../../src/tools/registry.js';

const tools = createCellTools({});

test('every Cell tool NAMES each of its required arguments in the description the model reads', () => {
  assert.ok(tools.length >= 7, 'the whole Cell catalogue is present');
  for (const tool of tools) {
    const required = tool.schema?.required ?? [];
    assert.ok(Array.isArray(required), `${tool.name}: the schema declares its required arguments`);
    for (const key of required) {
      assert.ok(tool.description.includes(key),
        `${tool.name}: the model-facing description never names its required argument "${key}"`);
    }
  }
});

test('serialisation arguments are named wherever the model has to supply them', () => {
  // The two arguments the failed run guessed wrong, pinned BY NAME rather than by count: `write_range` takes an
  // ADDRESS and a matrix of CELLS, and `format_cells` takes an ADDRESS. A rename of either key must fail here.
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.match(byName.get('write_range').description, /address/);
  assert.match(byName.get('write_range').description, /cells/);
  assert.equal(byName.get('write_range').schema.required.includes('values'), false,
    'the argument really is called cells, which is why the description has to say so');
  assert.match(byName.get('read_range').description, /address/);
  assert.match(byName.get('format_cells').description, /address/);
  assert.match(byName.get('add_sheet').description, /name/);
});

test('format_cells describes editor units that its numeric schema cannot express', () => {
  const formatCells = tools.find((tool) => tool.name === 'format_cells');
  assert.match(formatCells.description, /columnWidth.*символах.*НЕ пикселях/);
  assert.match(formatCells.description, /rowHeight\/fontSize.*пункты/);
});

test('the selector of every sheet-aware tool is named, and every description stays inside its ceiling', () => {
  for (const tool of tools) {
    const keys = Object.keys(tool.schema?.properties ?? {});
    if (keys.includes('sheetIndex')) {
      assert.ok(tool.description.includes('sheet') && tool.description.includes('sheetIndex'),
        `${tool.name}: a sheet-aware tool must name both selector spellings`);
    }
    assert.ok(utf8ByteLength(tool.description) <= TOOL_DESCRIPTION_BYTES,
      `${tool.name}: the description exceeds the model-facing ceiling`);
  }
});
