import test from 'node:test';
import assert from 'node:assert/strict';
import { createR7Bridge } from '../../src/plugin/bridge.js';
import { LIMITS } from '../../src/shared/limits.js';

const PNG = 'data:image/png;base64,AA==';
function wrapper(kind, options = {}) {
  return {
    GetClassType() { return 'drawing'; },
    ToJSON() {
      if (options.nonString) return {};
      if (options.unparseable) return '{';
      if (kind === 'table') {
        const columns = options.columns;
        const cells = options.cells;
        if (options.missingGraphic) return JSON.stringify({});
        if (options.invalidGraphic !== undefined) return JSON.stringify({ graphic: options.invalidGraphic });
        return JSON.stringify({ graphic: { bPresentation: true, tblGrid: Array.from({ length: columns }, () => ({ type: 'gridCol' })), tblPr: {}, content: Array.from({ length: options.rows }, (_, row) => ({ content: Array.from({ length: columns }, (_, column) => row * columns + column < cells ? { tcPr: {} } : {}) })) } });
      }
      return JSON.stringify({ blipFill: { rasterImageId: options.source } });
    },
    GetWidth() { return options.width; },
    GetHeight() { return options.height; }
  };
}
function rig(options = {}) {
  let dispatches = 0;
  let drawings = [], images = [], shapes = [], charts = [], ole = [];
  const slide = {
    GetClassType() { return options.classType ?? 'slide'; }, GetSlideIndex() { return options.actualIndex ?? 0; },
    GetAllDrawings() { return drawings; }, GetAllImages() { return images; }, GetAllShapes() { return shapes; }, GetAllCharts() { return charts; }, GetAllOleObjects() { return ole; },
    AddObject(object) { drawings = drawings.concat([object.stored]); if (object.kind === 'image') images = images.concat([object.stored]); if (options.mutateShapes) shapes = shapes.concat([{}]); return true; }
  };
  const presentation = { GetCurSlideIndex() { return 0; }, GetCurrentSlide() { return slide; }, GetSlideByIndex(index) { return index === 0 ? slide : null; }, GetSlidesCount() { return options.slideCountAfter ?? 1; } };
  const Api = {
    GetPresentation() { return presentation; },
    CreateTable(columns, rows) { const c = options.transposeTable ? rows : columns; const r = options.transposeTable ? columns : rows; return { kind: 'table', stored: wrapper('table', { columns: options.badGrid ?? c, rows: r, cells: options.badCells ?? c * r, missingGraphic: options.missingGraphic, invalidGraphic: options.invalidGraphic, nonString: options.nonString, unparseable: options.unparseable }) }; },
    CreateImage(source, width, height) { return { kind: 'image', stored: wrapper('image', { source: options.badSource ?? source, width: options.badWidth ?? width, height: options.badHeight ?? height, nonString: options.nonString, unparseable: options.unparseable }) }; }
  };
  const namespace = { scope: {} };
  const plugin = { info: { editorType: 'slide' }, callCommand(body, _close, _recalc, callback) { dispatches++; callback(new Function('Api', 'scope', 'return (' + Function.prototype.toString.call(body) + ')();')(Api, namespace.scope)); } };
  return { bridge: createR7Bridge(plugin, { editorType: 'slide', ascNamespace: namespace, clock: { now() { return 0; } }, timers: { schedule() { return {}; }, clear() {} } }), dispatches: () => dispatches };
}
const tableRequest = overrides => ({ slideIndex: null, columns: 3, rows: 2, maxColumns: LIMITS.slideTableColumnsMax, maxRows: LIMITS.slideTableRowsMax, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });
const imageRequest = overrides => ({ slideIndex: null, imageDataUrl: PNG, widthEmu: 720000, heightEmu: 360000, maxImageBytes: LIMITS.slideImageBytesMax, maxImageEmu: LIMITS.slideImageEmuMax, maxResultBytes: LIMITS.slideReadResultBytes, ...overrides });

test('add_table uses measured columns rows order and proves stored drawing structure', async () => {
  assert.deepEqual(await rig().bridge.addSlideTable(tableRequest()), { ok: true, slideIndex: 0, columns: 3, rows: 2, drawings: 1, cells: 6 });
  assert.deepEqual(await rig({ transposeTable: true }).bridge.addSlideTable(tableRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('add_table proves the measured two-column four-row graphic wrapper', async () => {
  assert.deepEqual(await rig().bridge.addSlideTable(tableRequest({ columns: 2, rows: 4 })), { ok: true, slideIndex: 0, columns: 2, rows: 4, drawings: 1, cells: 8 });
});

test('add_table refuses transposed grid dimensions despite the same recursive cell count', async () => {
  assert.deepEqual(await rig({ transposeTable: true }).bridge.addSlideTable(tableRequest({ columns: 2, rows: 4 })), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('add_table refuses a wrapper without graphic rather than throwing', async () => {
  await assert.doesNotReject(async () => {
    assert.deepEqual(await rig({ missingGraphic: true }).bridge.addSlideTable(tableRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
  });
});

test('add_table refuses null and non-object graphic values rather than throwing', async () => {
  for (const invalidGraphic of [null, false, 1, 'table']) {
    await assert.doesNotReject(async () => {
      assert.deepEqual(await rig({ invalidGraphic }).bridge.addSlideTable(tableRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
    });
  }
});

test('add_image proves drawing image source and getter size', async () => {
  assert.deepEqual(await rig().bridge.addSlideImage(imageRequest()), { ok: true, slideIndex: 0, images: 1, widthEmu: 720000, heightEmu: 360000, sourceBytes: Buffer.byteLength(PNG) });
  for (const options of [{ badSource: PNG + 'x' }, { badWidth: 1 }, { badHeight: 1 }]) assert.deepEqual(await rig(options).bridge.addSlideImage(imageRequest()), { ok: false, code: 'APPLY_UNCERTAIN' });
});

test('slide object requests refuse the closed malformed argument class before dispatch', async () => {
  for (const request of [tableRequest({ columns: 0 }), tableRequest({ columns: LIMITS.slideTableColumnsMax + 1 }), tableRequest({ columns: 1.5 }), tableRequest({ rows: 0 }), tableRequest({ rows: LIMITS.slideTableRowsMax + 1 }), tableRequest({ rows: 1.5 }), tableRequest({ extra: 1 })]) { const value = rig(); assert.equal((await value.bridge.addSlideTable(request)).code, 'TOOL_ERROR'); assert.equal(value.dispatches(), 0); }
  for (const request of [imageRequest({ imageDataUrl: '' }), imageRequest({ imageDataUrl: 'data:image/gif;base64,AA==' }), imageRequest({ imageDataUrl: 'data:image/png;base64,' + 'A'.repeat(LIMITS.slideImageBytesMax) }), imageRequest({ widthEmu: 0 }), imageRequest({ widthEmu: LIMITS.slideImageEmuMax + 1 }), imageRequest({ heightEmu: 0 }), imageRequest({ heightEmu: LIMITS.slideImageEmuMax + 1 }), imageRequest({ extra: 1 })]) { const value = rig(); const result = await value.bridge.addSlideImage(request); assert.ok(['TOOL_ERROR', 'BYTE_LIMIT'].includes(result.code)); assert.equal(value.dispatches(), 0); }
});

test('slide object proof failures settle uncertain after dispatch', async () => {
  for (const options of [{ badGrid: 2 }, { badCells: 5 }, { mutateShapes: true }, { nonString: true }, { unparseable: true }]) assert.equal((await rig(options).bridge.addSlideTable(tableRequest())).code, 'APPLY_UNCERTAIN');
  for (const options of [{ mutateShapes: true }, { nonString: true }, { unparseable: true }]) assert.equal((await rig(options).bridge.addSlideImage(imageRequest())).code, 'APPLY_UNCERTAIN');
});
