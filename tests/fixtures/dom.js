// Minimal injected DOM boundary; no HTML parser, code execution or browser-proof claim.
export class Element {
  constructor(tag, document) { this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = []; this.attributes = {}; this.listeners = {}; this.text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('HTML must never be used'); }
  setAttribute(key,value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  addEventListener(name,callback) { (this.listeners[name] ??= []).push(callback); }
  removeEventListener(name,callback) { this.listeners[name] = (this.listeners[name] ?? []).filter(item => item !== callback); }
  focus() { this.ownerDocument.activeElement = this; }
  dispatch(name, extra = {}) { if (this.disabled) return; const event = { preventDefault() {}, target: this, ...extra }; for (const listener of this.listeners[name] ?? []) listener(event); }
}
export function dom() {
  const document = { activeElement: null, createElement(tag) { return new Element(tag, this); } };
  const root = document.createElement('main');
  function all(node = root) { return [node, ...node.children.flatMap(child => all(child))]; }
  function id(name) { return all().find(node => node.id === name); }
  return { document, root, all, id };
}
