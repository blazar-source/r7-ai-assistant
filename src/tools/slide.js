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
export function createSlideTools(bridge) {
  return [
    defineTool({ name: 'read_presentation', kind: 'read', editors: ['slide'], policy: 'auto', requires: ['document.read'], description: 'Читает структуру активной презентации: слайды, layout, типы объектов и наличие текста.', schema: { type: 'object', additionalProperties: false, required: [], properties: {} }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (_args, ctx) => executeRead(bridge, 'readPresentation', { maxSlides: LIMITS.slideReadSlidesMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, presentationData, 'read_presentation') }),
    defineTool({ name: 'read_slide', kind: 'read', editors: ['slide'], policy: 'auto', requires: ['document.read'], description: 'Читает текущий слайд или slideIndex: объекты, типы, placeholder и полный текст в лимите.', schema: { type: 'object', additionalProperties: false, required: [], properties: { slideIndex: { type: 'integer', minimum: 0, maximum: LIMITS.slideReadSlidesMax - 1 } } }, precondition: (_args, ctx) => wrongEditor(ctx), execute: (args, ctx) => { if (args === null || typeof args !== 'object' || Array.isArray(args)) return Promise.resolve(known()); for (const key of Object.keys(args)) if (key !== 'slideIndex') return Promise.resolve(known()); const slideIndex = args.slideIndex; if (slideIndex !== undefined && (!safeCount(slideIndex) || slideIndex >= LIMITS.slideReadSlidesMax)) return Promise.resolve(known()); return executeRead(bridge, 'readSlide', { slideIndex: slideIndex === undefined ? null : slideIndex, maxObjects: LIMITS.slideReadObjectsMax, maxTextBytes: LIMITS.slideReadTextBytes, maxResultBytes: LIMITS.slideReadResultBytes, signal: ctx?.signal }, slideData, 'read_slide'); } })
  ];
}
