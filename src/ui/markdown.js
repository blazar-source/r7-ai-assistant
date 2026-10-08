// A deliberately small presentation grammar. Model text never enters an HTML parser:
// tags and attributes are authored here, raw HTML is literal text, images are not loaded.
// Soft breaks become spaces; two trailing spaces or a backslash produce a hard break.
function literal(parent, text) {
  const span = parent.ownerDocument.createElement('span');
  span.textContent = text; parent.append(span);
}
function safeLink(value) {
  if (!/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }
  catch { return false; }
}
function inline(parent, source, depth = 0) {
  if (depth >= 8) { literal(parent, source); return; }
  const tokens = /(`+)([^`\n]+?)\1|\[([^\]\n]+)\]\(([^\s()]+)\)|\*\*([^*\n]+)\*\*|(?<![\p{L}\p{N}_])__([^_\n]+)__(?![\p{L}\p{N}_])|\*([^*\n]+)\*|(?<![\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])|( {2,}|\\)\n|\n/gu;
  let offset = 0;
  for (const match of source.matchAll(tokens)) {
    literal(parent, source.slice(offset, match.index));
    let element;
    if (match[1]) {
      element = parent.ownerDocument.createElement('code'); element.textContent = match[2];
    } else if (match[3]) {
      if (safeLink(match[4]) && source[match.index - 1] !== '!') {
        element = parent.ownerDocument.createElement('a');
        element.setAttribute('href', match[4]); element.setAttribute('target', '_blank');
        element.setAttribute('rel', 'noopener noreferrer'); inline(element, match[3], depth + 1);
      } else { literal(parent, match[0]); }
    } else if (match[5] || match[6] || match[7] || match[8]) {
      element = parent.ownerDocument.createElement(match[5] || match[6] ? 'strong' : 'em');
      inline(element, match[5] || match[6] || match[7] || match[8], depth + 1);
    } else if (match[9]) element = parent.ownerDocument.createElement('br');
    else literal(parent, ' ');
    if (element) parent.append(element);
    offset = match.index + match[0].length;
  }
  literal(parent, source.slice(offset));
}
export function renderMarkdown(parent, source) {
  const doc = parent.ownerDocument;
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [];
  function flush() {
    if (!paragraph.length) return;
    const p = doc.createElement('p'); inline(p, paragraph.join('\n')); parent.append(p); paragraph = [];
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines.at(index);
    const fence = /^ {0,3}(`{3,}|~{3,})[^`]*$/.exec(line);
    if (fence) {
      flush(); const codeLines = []; const marker = fence[1];
      while (++index < lines.length) {
        const end = lines.at(index).trim();
        if (end.length >= marker.length && [...end].every(char => char === marker[0])) break;
        codeLines.push(lines.at(index));
      }
      const pre = doc.createElement('pre'); const code = doc.createElement('code');
      code.textContent = codeLines.join('\n'); pre.append(code); parent.append(pre); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line);
    if (heading) {
      flush(); const h = doc.createElement(heading[1].length === 1 ? 'h3' : 'h4');
      inline(h, heading[2]); parent.append(h); continue;
    }
    const item = /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush(); const ordered = Boolean(item[2]); const list = doc.createElement(ordered ? 'ol' : 'ul');
      if (ordered) list.setAttribute('start', item[2]);
      let current = item;
      while (current && Boolean(current[2]) === ordered) {
        const li = doc.createElement('li'); inline(li, current[3]); list.append(li);
        current = /^ {0,3}(?:([-+*])|([0-9]{1,9})[.)])\s+(.+)$/.exec(lines.at(index + 1) ?? '');
        if (current && Boolean(current[2]) === ordered) index += 1;
        else break;
      }
      parent.append(list); continue;
    }
    paragraph.push(line);
  }
  flush();
}
