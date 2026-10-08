import { defineTool } from './registry.js';
import { ERROR_CODES } from '../shared/errors.js';
import { AGENT_CEILINGS, LIMITS } from '../shared/limits.js';
import { utf8ByteLength } from '../shared/bytes.js';

const REFUSAL = 'отказ';
const ok = data => Object.freeze({ ok: true, data: Object.freeze(data) });
const known = (code = ERROR_CODES.TOOL_ERROR) => Object.freeze({ ok: false, code, message: REFUSAL });
const wrongEditor = ctx => ctx?.editor === 'slide' ? null : { code: ERROR_CODES.CAPABILITY_UNAVAILABLE, message: REFUSAL };
const safeCount = value => Number.isSafeInteger(value) && value >= 0;
function entryBytes(tool, data) { try { return utf8ByteLength(JSON.stringify({ tool, ok: true, data })); } catch { return null; } }
function responseCode(response) { return typeof response?.code === 'string' && ERROR_CODES[response.code] === response.code ? response.code : ERROR_CODES.TOOL_ERROR; }
function bridgeResult(response) {
  if (!response || typeof response !== 'object') return known();
  if (response.code === ERROR_CODES.APPLY_UNCERTAIN) return known(ERROR_CODES.TOOL_UNCERTAIN);
  return response.ok === true ? null : known(responseCode(response));
}
function slideSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const { index, layoutId, shapes, drawings, images, charts, oleObjects, hasText } = value;
  if (!safeCount(index) || ![layoutId === null, safeCount(layoutId)].includes(true) || !safeCount(shapes) || !safeCount(drawings) || !safeCount(images) || !safeCount(charts) || !safeCount(oleObjects) || typeof hasText !== 'boolean') return null;
  return Object.freeze({ index, layoutId, shapes, drawings, images, charts, oleObjects, hasText });
}
function presentationData(response) {
  const { slidesCount, currentSlideIndex, slides, slidesRead, slidesTotal, truncated } = response;
  if (!safeCount(slidesCount) || !safeCount(currentSlideIndex) || !safeCount(slidesRead) || !safeCount(slidesTotal) || typeof truncated !== 'boolean' || !Array.isArray(slides)) return null;
  if (slidesTotal !== slidesCount || slidesRead !== slides.length || slidesRead > slidesTotal || slidesRead > LIMITS.slideReadSlidesMax || truncated !== (slidesRead < slidesTotal)) return null;
  if (slidesCount === 0 ? currentSlideIndex !== 0 : currentSlideIndex >= slidesCount) return null;
  const summaries = [];
  for (let index = 0; index < slides.length; index++) { const item = slideSummary(slides[index]); if (item === null || item.index !== index) return null; summaries.push(item); }
  return Object.freeze({ slidesCount, currentSlideIndex, slides: Object.freeze(summaries), slidesRead, slidesTotal, truncated });
}
function slideObject(value, ordinal) {
  if (!value || typeof value !== 'object') return null;
  const { classType, placeholder, category, text, textOmitted } = value;
  if (!safeCount(value.ordinal) || value.ordinal !== ordinal || typeof classType !== 'string' || typeof placeholder !== 'boolean' || !['shape', 'image', 'chart', 'ole', 'unknown'].includes(category) || typeof textOmitted !== 'boolean') return null;
  if (textOmitted ? text !== null : !(typeof text === 'string' || text === null)) return null;
  if (typeof text === 'string' && utf8ByteLength(text) > LIMITS.slideReadTextBytes) return null;
  return Object.freeze({ ordinal, classType, placeholder, category, text, textOmitted });
}
function addSlideData(response) {
  const { slidesCount, slideIndex, layoutId, layoutPreserved } = response;
  if (!safeCount(slidesCount) || slidesCount < 1 || !safeCount(slideIndex) || !(layoutId === null || typeof layoutId === 'string') || layoutPreserved !== true) return null;
  return Object.freeze({ slidesCount, slideIndex, layoutId, layoutPreserved });
}
function slideTextData(response) {
  const { slideIndex, objectOrdinal, textLength, textBytes } = response;
  if (!safeCount(slideIndex) || !safeCount(objectOrdinal) || !safeCount(textLength) || !safeCount(textBytes)) return null;
  return Object.freeze({ slideIndex, objectOrdinal, textLength, textBytes });
}
function slideFormatData(response) {
  const { slideIndex, objectOrdinal, applied, textLength } = response;
  const names = ['bold', 'italic', 'underline', 'fontSize', 'fontFamily', 'color'];
  if (!safeCount(slideIndex) || !safeCount(objectOrdinal) || !safeCount(textLength) || !Array.isArray(applied) || applied.length < 1) return null;
  for (const name of applied) if (!names.includes(name)) return null;
  return Object.freeze({ slideIndex, objectOrdinal, applied: Object.freeze(applied.slice()), textLength });
}
function slideTableData(response) { const { slideIndex, columns, rows, drawings, cells } = response; if (!safeCount(slideIndex) || !safeCount(columns) || !safeCount(rows) || !safeCount(drawings) || !safeCount(cells) || columns < 1 || rows < 1 || cells !== columns * rows) return null; return Object.freeze({ slideIndex, columns, rows, drawings, cells }); }
function slideImageData(response) { const { slideIndex, images, widthEmu, heightEmu, sourceBytes } = response; if (!safeCount(slideIndex) || !safeCount(images) || !safeCount(widthEmu) || !safeCount(heightEmu) || !safeCount(sourceBytes) || widthEmu < 1 || heightEmu < 1) return null; return Object.freeze({ slideIndex, images, widthEmu, heightEmu, sourceBytes }); }
function slideDuplicateData(response) { const { slidesCount, slideIndex, duplicatedFrom, layoutLength, shapes } = response; if (!safeCount(slidesCount) || slidesCount < 1 || !safeCount(slideIndex) || !safeCount(duplicatedFrom) || !safeCount(layoutLength) || layoutLength < 1 || !safeCount(shapes)) return null; return Object.freeze({ slidesCount, slideIndex, duplicatedFrom, layoutLength, shapes }); }
function slideMoveData(response) { const { slidesCount, fromIndex, toIndex, layoutLength, shapes } = response; if (!safeCount(slidesCount) || slidesCount < 1 || !safeCount(fromIndex) || !safeCount(toIndex) || !safeCount(layoutLength) || layoutLength < 1 || !safeCount(shapes)) return null; return Object.freeze({ slidesCount, fromIndex, toIndex, layoutLength, shapes }); }
function slideData(response) {
  const { slideIndex, layoutId, objectCount, objectsRead, counts, objects, truncated } = response;
  if (!safeCount(slideIndex) || ![layoutId === null, safeCount(layoutId)].includes(true) || !safeCount(objectCount) || !safeCount(objectsRead) || !counts || typeof counts !== 'object' || !Array.isArray(objects) || typeof truncated !== 'boolean') return null;
  for (const key of ['shapes', 'drawings', 'images', 'charts', 'oleObjects']) if (!safeCount(counts[key])) return null;
  if (objectsRead !== objects.length || objectsRead > objectCount || objectsRead > LIMITS.slideReadObjectsMax || truncated !== (objectsRead < objectCount)) return null;
  const listed = [];
  for (let ordinal = 0; ordinal < objects.length; ordinal++) { const item = slideObject(objects[ordinal], ordinal); if (item === null) return null; listed.push(item); }
  return Object.freeze({ slideIndex, layoutId, objectCount, objectsRead, counts: Object.freeze({ shapes: counts.shapes, drawings: counts.drawings, images: counts.images, charts: counts.charts, oleObjects: counts.oleObjects }), objects: Object.freeze(listed), truncated });
}
async function executeRead(bridge, method, request, parse, name) {
  if (!bridge || typeof bridge !== 'object') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  let response;
  try {
    if (method === 'readPresentation') {
      if (typeof bridge.readPresentation !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      response = await bridge.readPresentation(request);
    } else {
      if (typeof bridge.readSlide !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
      response = await bridge.readSlide(request);
    }
  } catch (error) { return known(responseCode(error)); }
  const refused = bridgeResult(response); if (refused) return refused;
  const data = parse(response); if (data === null) return known();
  const bytes = entryBytes(name, data);
  if (bytes === null || bytes > LIMITS.slideReadResultBytes || bytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
  return ok(data);
}
async function executeMutation(bridge, method, request, parse, name) {
  if (!bridge || typeof bridge !== 'object') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE);
  let response;
  try {
    if (method === 'addSlide') { if (typeof bridge.addSlide !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.addSlide(request); }
    else if (method === 'setSlideText') { if (typeof bridge.setSlideText !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.setSlideText(request); }
    else if (method === 'formatSlideText') { if (typeof bridge.formatSlideText !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.formatSlideText(request); }
    else if (method === 'addSlideTable') { if (typeof bridge.addSlideTable !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.addSlideTable(request); }
    else if (method === 'addSlideImage') { if (typeof bridge.addSlideImage !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.addSlideImage(request); }
    else if (method === 'duplicateSlide') { if (typeof bridge.duplicateSlide !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.duplicateSlide(request); }
    else { if (typeof bridge.moveSlide !== 'function') return known(ERROR_CODES.CAPABILITY_UNAVAILABLE); response = await bridge.moveSlide(request); }
  } catch (error) { return known(responseCode(error)); }
  const refused = bridgeResult(response); if (refused) return refused;
  const data = parse(response); if (data === null) return known();
  const bytes = entryBytes(name, data);
  if (bytes === null || bytes > LIMITS.slideReadResultBytes || bytes > AGENT_CEILINGS.toolResultBytes) return known(ERROR_CODES.BYTE_LIMIT);
  return ok(data);
}
export function createSlideTools(bridge) {
  return [
    defineTool({ name: 'read_presentation', kind: 'read', editors: ['slide'], policy: 'auto', requires: ['document.read'], description: 'Читает структуру активной презентации: слайды, layout, типы объектов и наличие текста.', schema: { type: 'object', additionalProperties: false, required: [], properties: {} }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (_args, ctx) => executeRead(bridge, 'readPresentation', { maxSlides: LIMITS.slideReadSlidesMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, presentationData, 'read_presentation') }),
    defineTool({ name: 'read_slide', kind: 'read', editors: ['slide'], policy: 'auto', requires: ['document.read'], description: 'Читает текущий слайд или slideIndex: объекты, типы, placeholder и полный текст в лимите.', schema: { type: 'object', additionalProperties: false, required: [], properties: { slideIndex: { type: 'integer', minimum: 0, maximum: LIMITS.slideReadSlidesMax - 1 } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (key !== 'slideIndex') return Promise.resolve(known()); const slideIndex = args.slideIndex; if (slideIndex !== undefined && (!safeCount(slideIndex) || slideIndex >= LIMITS.slideReadSlidesMax)) return Promise.resolve(known()); return executeRead(bridge, 'readSlide', { slideIndex: slideIndex === undefined ? null : slideIndex, maxObjects: LIMITS.slideReadObjectsMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideData, 'read_slide'); } }),
    defineTool({ name: 'add_slide', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'После текущего; layoutFromSlideIndex — лишь макет. Цель — возвращённый slideIndex. В конец: move_slide(slideIndex,slidesCount-1); текст — по новому индексу.', schema: { type: 'object', additionalProperties: false, required: [], properties: { layoutFromSlideIndex: { type: 'integer', minimum: 0 } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (key !== 'layoutFromSlideIndex') return Promise.resolve(known()); const index = args.layoutFromSlideIndex; if (index !== undefined && !safeCount(index)) return Promise.resolve(known()); return executeMutation(bridge, 'addSlide', { layoutFromSlideIndex: index === undefined ? null : index, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, addSlideData, 'add_slide'); } }),
    defineTool({ name: 'set_slide_text', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Заменяет весь текст объекта objectOrdinal на text; slideIndex необязателен и без него выбран текущий слайд.', schema: { type: 'object', additionalProperties: false, required: ['objectOrdinal', 'text'], properties: { slideIndex: { type: 'integer', minimum: 0 }, objectOrdinal: { type: 'integer', minimum: 0 }, text: { type: 'string', maxBytes: LIMITS.slideReadTextBytes } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (!['slideIndex', 'objectOrdinal', 'text'].includes(key)) return Promise.resolve(known()); const { slideIndex, objectOrdinal, text } = args; if ((slideIndex !== undefined && !safeCount(slideIndex)) || !safeCount(objectOrdinal) || typeof text !== 'string') return Promise.resolve(known()); if (utf8ByteLength(text) > LIMITS.slideReadTextBytes) return Promise.resolve(known(ERROR_CODES.BYTE_LIMIT)); return executeMutation(bridge, 'setSlideText', { slideIndex: slideIndex === undefined ? null : slideIndex, objectOrdinal, text, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideTextData, 'set_slide_text'); } }),
    defineTool({ name: 'add_table', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Добавляет таблицу columns x rows на slideIndex; slideIndex необязателен.', schema: { type: 'object', additionalProperties: false, required: ['columns', 'rows'], properties: { slideIndex: { type: 'integer', minimum: 0 }, columns: { type: 'integer', minimum: 1, maximum: LIMITS.slideTableColumnsMax }, rows: { type: 'integer', minimum: 1, maximum: LIMITS.slideTableRowsMax } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (!['slideIndex', 'columns', 'rows'].includes(key)) return Promise.resolve(known()); const { slideIndex, columns, rows } = args; if ((slideIndex !== undefined && !safeCount(slideIndex)) || !Number.isSafeInteger(columns) || columns < 1 || columns > LIMITS.slideTableColumnsMax || !Number.isSafeInteger(rows) || rows < 1 || rows > LIMITS.slideTableRowsMax) return Promise.resolve(known()); return executeMutation(bridge, 'addSlideTable', { slideIndex: slideIndex === undefined ? null : slideIndex, columns, rows, maxColumns: LIMITS.slideTableColumnsMax, maxRows: LIMITS.slideTableRowsMax, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideTableData, 'add_table'); } }),
    defineTool({ name: 'add_image', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Добавляет imageDataUrl на slideIndex с widthEmu и heightEmu; slideIndex необязателен.', schema: { type: 'object', additionalProperties: false, required: ['imageDataUrl', 'widthEmu', 'heightEmu'], properties: { slideIndex: { type: 'integer', minimum: 0 }, imageDataUrl: { type: 'string', maxBytes: LIMITS.slideImageBytesMax }, widthEmu: { type: 'integer', minimum: 1, maximum: LIMITS.slideImageEmuMax }, heightEmu: { type: 'integer', minimum: 1, maximum: LIMITS.slideImageEmuMax } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (!['slideIndex', 'imageDataUrl', 'widthEmu', 'heightEmu'].includes(key)) return Promise.resolve(known()); const { slideIndex, imageDataUrl, widthEmu, heightEmu } = args; if ((slideIndex !== undefined && !safeCount(slideIndex)) || typeof imageDataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(imageDataUrl) || imageDataUrl.length < 24 || !Number.isSafeInteger(widthEmu) || widthEmu < 1 || widthEmu > LIMITS.slideImageEmuMax || !Number.isSafeInteger(heightEmu) || heightEmu < 1 || heightEmu > LIMITS.slideImageEmuMax) return Promise.resolve(known()); if (utf8ByteLength(imageDataUrl) > LIMITS.slideImageBytesMax) return Promise.resolve(known(ERROR_CODES.BYTE_LIMIT)); return executeMutation(bridge, 'addSlideImage', { slideIndex: slideIndex === undefined ? null : slideIndex, imageDataUrl, widthEmu, heightEmu, maxImageBytes: LIMITS.slideImageBytesMax, maxImageEmu: LIMITS.slideImageEmuMax, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideImageData, 'add_image'); } }),
    defineTool({ name: 'duplicate_slide', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Дублирует slideIndex в конец презентации с проверкой layout, объектов и текста.', schema: { type: 'object', additionalProperties: false, required: ['slideIndex'], properties: { slideIndex: { type: 'integer', minimum: 0 } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 1 || !safeCount(args.slideIndex)) return Promise.resolve(known()); return executeMutation(bridge, 'duplicateSlide', { slideIndex: args.slideIndex, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideDuplicateData, 'duplicate_slide'); } }),
    defineTool({ name: 'move_slide', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Перемещает слайд fromIndex в toIndex и проверяет сохранность остальных слайдов.', schema: { type: 'object', additionalProperties: false, required: ['fromIndex', 'toIndex'], properties: { fromIndex: { type: 'integer', minimum: 0 }, toIndex: { type: 'integer', minimum: 0 } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 2 || !safeCount(args.fromIndex) || !safeCount(args.toIndex)) return Promise.resolve(known()); return executeMutation(bridge, 'moveSlide', { fromIndex: args.fromIndex, toIndex: args.toIndex, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideMoveData, 'move_slide'); } }),
    defineTool({ name: 'format_slide_text', kind: 'mutate', editors: ['slide'], policy: 'auto', requires: ['document.write'], description: 'Форматирует objectOrdinal на slideIndex?; задайте bold, italic, underline, fontSize, fontFamily или color {r,g,b}.', schema: { type: 'object', additionalProperties: false, required: ['objectOrdinal'], properties: { slideIndex: { type: 'integer', minimum: 0 }, objectOrdinal: { type: 'integer', minimum: 0 }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, underline: { type: 'boolean' }, fontSize: { type: 'integer', minimum: 1, maximum: LIMITS.slideFormatFontSizeMax }, fontFamily: { type: 'string' }, color: { type: 'object', additionalProperties: false, required: ['r', 'g', 'b'], properties: { r: { type: 'integer', minimum: 0, maximum: 255 }, g: { type: 'integer', minimum: 0, maximum: 255 }, b: { type: 'integer', minimum: 0, maximum: 255 } } } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); const names = ['bold', 'italic', 'underline', 'fontSize', 'fontFamily', 'color']; for (const key of Object.keys(args)) if (!['slideIndex', 'objectOrdinal', ...names].includes(key)) return Promise.resolve(known()); const { slideIndex, objectOrdinal, bold, italic, underline, fontSize, fontFamily, color } = args; if ((slideIndex !== undefined && !safeCount(slideIndex)) || !safeCount(objectOrdinal)) return Promise.resolve(known()); const requested = names.filter(name => args[name] !== undefined); if (requested.length < 1 || (bold !== undefined && typeof bold !== 'boolean') || (italic !== undefined && typeof italic !== 'boolean') || (underline !== undefined && typeof underline !== 'boolean') || (fontSize !== undefined && (!Number.isSafeInteger(fontSize) || fontSize < 1 || fontSize > LIMITS.slideFormatFontSizeMax)) || (fontFamily !== undefined && typeof fontFamily !== 'string')) return Promise.resolve(known()); if (color !== undefined && (color === null || typeof color !== 'object' || Array.isArray(color) || Object.keys(color).length !== 3 || !['r', 'g', 'b'].every(key => Number.isSafeInteger(color[key]) && color[key] >= 0 && color[key] <= 255))) return Promise.resolve(known()); return executeMutation(bridge, 'formatSlideText', { slideIndex: slideIndex === undefined ? null : slideIndex, objectOrdinal, bold, italic, underline, fontSize, fontFamily, color, maxFontSize: LIMITS.slideFormatFontSizeMax, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideFormatData, 'format_slide_text'); } })
  ];
}
