// A tiny text-extraction DOM for the bridge's document-delta confirmation, injected ONLY through the
// bridge's `document` option. This is NOT a browser and NOT a general HTML parser: it is the platform
// boundary the tests stand in for, so that the counting rule can be exercised without a browser. It
// implements exactly what the confirmation uses — `createElement('div')`, the `innerHTML` setter, and a
// child/text tree — and it deliberately does NOT implement `textContent` (a flat `textContent` would
// concatenate blocks with no separator, which is the very defect the block separators close).
//
// The parser is small and explicit: elements, attributes, self-closing and void tags, comments and the
// common named entities plus numeric references. Unknown named entities are left verbatim, like the
// platform leaves an unrecognised reference. Attribute VALUES are decoded but never enter the text
// stream, which is what makes "markup never counts" testable.
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const NAMED_ENTITIES = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0']]);
// The block set the bridge's separator rule names, written independently here so the fixture and the
// implementation cannot drift apart silently. `br` is a line break rather than a block, and it is a
// separator for the same reason: the line really ends there.
export const BLOCK_TAGS = Object.freeze(new Set(['address', 'article', 'aside', 'blockquote', 'body', 'br', 'dd', 'div',
  'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul']));

export class HtmlElement {
  constructor(tag) { this.nodeType = 1; this.tagName = String(tag).toUpperCase(); this.attributes = {}; this.children = []; this.text = null; }
  get nodeName() { return this.tagName; }
  get childNodes() { return this.children; }
  getAttribute(name) { const key = String(name).toLowerCase(); return Object.hasOwn(this.attributes, key) ? this.attributes[key] : null; }
  set innerHTML(html) { this.children = parseHtml(html, this); this.text = null; }
  get innerHTML() { throw new Error('the counted path never reads innerHTML'); }
}
class TextNode { constructor(data) { this.nodeType = 3; this.nodeName = '#text'; this.nodeValue = data; this.data = data; } }

// A small scanner rather than a chain of replaces: a named entity may itself START with a shorter one,
// so `&amp;lt;` must decode to `&lt;` and never to `<`, or the entity vocabulary would collapse into
// text the document never contained.
export function decodeEntities(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('&', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    const semi = text.indexOf(';', at);
    const body = semi < 0 ? null : text.slice(at + 1, semi);
    if (body !== null && body.length <= 32 && !/[\s&]/.test(body)) {
      if (/^#x[0-9a-f]+$/i.test(body)) { out += String.fromCodePoint(parseInt(body.slice(2), 16)); i = semi + 1; continue; }
      if (/^#[0-9]+$/.test(body)) { out += String.fromCodePoint(parseInt(body.slice(1), 10)); i = semi + 1; continue; }
      if (NAMED_ENTITIES.has(body)) { out += NAMED_ENTITIES.get(body); i = semi + 1; continue; }
    }
    out += '&';
    i = at + 1;
  }
  return out;
}

export function parseHtml(html, owner = null) {
  const source = String(html);
  const root = { tagName: '#ROOT', children: [] };
  const stack = [root];
  const append = node => stack.at(-1).children.push(node);
  let i = 0;
  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('</', i)) {
      const close = source.indexOf('>', i);
      const name = source.slice(i + 2, close < 0 ? source.length : close).trim().toLowerCase();
      for (let depth = stack.length - 1; depth >= 1; depth--) {
        if (stack[depth].tagName.toLowerCase() === name) { stack.length = depth; break; }
      }
      i = close < 0 ? source.length : close + 1;
      continue;
    }
    if (source[i] === '<' && /[a-z!?]/i.test(source[i + 1] ?? '')) {
      let cursor = i + 1;
      while (cursor < source.length && !/[\s/>]/.test(source[cursor])) cursor++;
      const name = source.slice(i + 1, cursor).toLowerCase();
      const attributes = {};
      let selfClosing = false;
      while (cursor < source.length && source[cursor] !== '>') {
        if (/\s/.test(source[cursor])) { cursor++; continue; }
        if (source[cursor] === '/') { selfClosing = true; cursor++; continue; }
        let end = cursor;
        while (end < source.length && !/[\s=/>]/.test(source[end])) end++;
        const attribute = source.slice(cursor, end).toLowerCase();
        cursor = end;
        while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
        let value = '';
        if (source[cursor] === '=') {
          cursor++;
          while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
          const quote = source[cursor];
          if (quote === '"' || quote === "'") {
            const end = source.indexOf(quote, cursor + 1);
            value = source.slice(cursor + 1, end < 0 ? source.length : end);
            cursor = end < 0 ? source.length : end + 1;
          } else {
            let end = cursor;
            while (end < source.length && !/[\s>]/.test(source[end])) end++;
            value = source.slice(cursor, end);
            cursor = end;
          }
        }
        if (attribute !== '') attributes[attribute] = decodeEntities(value);
      }
      const hitEnd = cursor >= source.length || source[cursor] !== '>';
      const element = new HtmlElement(name);
      element.attributes = attributes;
      append(element);
      i = hitEnd ? source.length : cursor + 1;
      // An unclosed tag at the end of the document still owns any text the platform would have put in
      // it, so the element is pushed even then; only the `i` advance differs.
      if (!selfClosing && !VOID_TAGS.has(name)) stack.push(element);
      continue;
    }
    const next = source.indexOf('<', i);
    const end = next < 0 ? source.length : next;
    const raw = source.slice(i, end);
    if (raw !== '') append(new TextNode(decodeEntities(raw)));
    // A `<` the platform does not read as a tag (here: `<` followed by a space or any other non-name
    // character) stays TEXT. Without this the scan would stop at the same `<` on every pass and never
    // advance — an infinite loop inside a parser that is supposed to be inert.
    if (end === i) { append(new TextNode('<')); i += 1; } else i = end;
  }
  return root.children;
}

// `createElement('div')` + an assigned `innerHTML` yields a parsed child tree, exactly like the
// platform's inert container parse the bridge's text extraction walks.
export function htmlDocument() {
  return { createElement(tag) { return new HtmlElement(tag); } };
}
