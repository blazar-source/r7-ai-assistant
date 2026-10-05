import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parse } from 'acorn';
import { buildPlugin } from '../../scripts/build-plugin.mjs';
import { auditSource } from '../../scripts/static-audit.mjs';
import { inventory } from '../fixtures/archive.js';
const root = new URL('../../', import.meta.url);
const expected = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'config.json', 'index.html', 'panel.js', 'resources/icon.png', 'resources/icon@2x.png', 'styles.css'];
function hash(data) { return createHash('sha256').update(data).digest('hex'); }
function walk(node, callback) { if (!node?.type) return; callback(node); for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => walk(child, callback)); else if (value && typeof value === 'object') walk(value, callback); }
// A COMMENT-STRIPPED view of an authored command body, for the leg classifier below. The classifier is a
// TEXT match, and these bodies are densely commented, so a body that DROPPED a call while KEEPING the
// sentence that names it — a route note such as `document.Push(…)` or `Api.CreateTable(…)` sitting next to
// the code that used to make the call — satisfied the very `carried.includes(...)`/regex match the
// classifier uses to recognise the living call, and was blessed as that leg. Stripping line and block
// comments first makes the matches see CODE only; string literals are preserved, so a `//` or `/*` inside a
// string is never mistaken for a comment.
function withoutComments(source) {
  let out = '';
  let quote = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      out += char;
      if (char === '\\') { out += next === undefined ? '' : next; index += 1; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && next === '/') { while (index < source.length && source[index] !== '\n') index += 1; out += '\n'; continue; }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

test('dual build produces byte-identical ZIP STORE/.plugin exact root allowlist with canonical manifest', async () => {
  const a = await buildPlugin({ output: 'dist/task4-package-a' });
  const b = await buildPlugin({ output: 'dist/task4-package-b' });
  assert.ok(a.archive?.length > 22);
  const entries = inventory(a.archive);
  assert.deepEqual(entries.map(e => e.name), expected);
  assert.deepEqual(a.archive, b.archive); assert.equal(hash(a.archive), hash(b.archive));
  assert.deepEqual(entries.find(e => e.name === 'config.json').data, await readFile(new URL('src/plugin/config.json', root)));
  assert.deepEqual(await readFile(a.pluginPath), a.archive); assert.deepEqual(await readFile(a.zipPath), a.archive);
  for (const item of entries) { assert.equal(item.method, 0); assert.equal(item.time, 0); assert.equal(item.date, 33); }
});
test('generated authored browser bundle passes audit with literal synchronous static command and no dev runtime', async () => {
  const built = await buildPlugin({ output: 'dist/task4-package-bundle' });
  const bundle = inventory(built.archive).find(e => e.name === 'panel.js'); assert.ok(bundle);
  const source = bundle.data.toString('utf8'); assert.deepEqual(auditSource(source, 'panel.js'), []);
  // Every authored command in the bundle is the bridge adapter's own leg, and each body must be
  // SELF-CONTAINED. The native does not call the function: it stringifies it and evaluates the text
  // inside the editor, where none of the adapter's module bindings exist. A body that merely FORWARDS to
  // a module-scope name (`() => contextBody()`) is therefore unevaluable there — measured on the live
  // Windows R7-Office 2026.3.1 as `ReferenceError: contextBody is not defined` from its own sdk-all-min.js
  // evaluator, with the insert dying before the model was ever called — so each body must carry its own
  // authored statements and name neither reviewed body. The two module-level literals stay in the bundle
  // because the `executeCommand` fallback composes their source as text, and `auditSource` above proves
  // they are static and read `Api` only.
  //
  // FIVE legs are carried inline, and the fifth is the BLOCK APPEND: the FIRST body that mutates the
  // document through the `Api` builder. Like the search and the structure read it builds the facade
  // itself and receives DATA — here the whole block array — from the `scope` binding the vendor's
  // `callCommand` wrapper injects (never from source text), and it is classified by its own mutating
  // primitive (`Push`, one call per block, the route the Lead measured to append at the END), which is
  // what distinguishes it from the structure body it shares
  // `GetAllParagraphs`/`GetAllHeadingParagraphs` with; the legacy whole-array insert primitive — measured
  // to land at the START and to replace existing text under a selection — is authored nowhere.
  // SIX legs are carried inline, and the last one is the TABLE INSERT: the second body that MUTATES the
  // document through the `Api` builder. Like the block append it builds the facade itself and receives DATA
  // — here the whole matrix — from the `scope` binding the vendor's `callCommand` wrapper injects (never
  // from source text), and it is classified by its own CREATION primitive (`CreateTable`, which no other
  // leg authors) BEFORE the `.Push(` branch, because it shares the measured append primitive with the block
  // body. It reads the document's own table count around the insert (`GetAllTables`) and the legacy
  // whole-array insert primitive — measured to land at the START and to replace existing text under a
  // selection — is authored nowhere.
  // SEVEN legs are carried inline, and the last one is the HEADING STYLE ASSIGNMENT: the third body that
  // MUTATES the document through the `Api` builder, and the FIRST one that APPENDS NOTHING — it changes an
  // EXISTING paragraph in place. Like the other two it builds the facade itself and receives DATA — the
  // validated `{ paragraph, level, styleName }` triple — from the `scope` binding the vendor's `callCommand`
  // wrapper injects (never from source text), and it is classified by its ONE mutating call
  // (`paragraph.SetStyle`, which no other leg authors) BEFORE every other branch. That order is
  // load-bearing: this body also READS `GetAllHeadingParagraphs`, so without its own branch it would be
  // classified as the STRUCTURE leg it shares that read with. It reads the document's own heading count
  // around the mutation (`GetAllHeadingParagraphs`), verifies the addressed paragraph's own text with a
  // second read of `GetAllParagraphs`, and authors NEITHER the append primitive nor the legacy whole-array
  // insert primitive — the one route measured to land at the START and to replace existing text under a
  // selection, which this leg must never take because its contract is that the text does NOT change.
  // EIGHT legs are carried inline, and the last one is the RANGE FORMAT: the fourth body that MUTATES the
  // document through the `Api` builder, the SECOND one that APPENDS NOTHING, and the ONE leg whose schema
  // advertises a SINGLE formatting property. It is classified by its ONE mutating call
  // (`paragraph.GetParaPr().SetJc`, which no other leg authors), and that branch is placed BEFORE the
  // heading body's `.SetStyle(` branch because BOTH legs author `GetParaPr()` — without its own branch this
  // body would be classified as the heading leg it shares that read with. It takes its
  // `{ paragraph, start, end, align }` address from the injected command scope, resolves the range through
  // the paragraph's own `GetRange`, and proves the mutation through the MEASURED `GetJc` readback of the
  // same paragraph-properties chain. The character-level properties are absent BY CONSTRUCTION — the
  // vendored SDK exposes setters only for them and the schema refuses them as unknown keys — so this body
  // must never author `SetBold`/`SetItalic`/`SetFontSize`, and it appends nothing and never takes the legacy
  // whole-array insert primitive (measured to land at the START and to replace existing text under a
  // selection), because its contract is that the addressed paragraph's TEXT does not change.
  let commands = 0; const legs = [];
  walk(parse(source, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'callCommand') {
      commands++;
      const body = node.arguments[0];
      assert.equal(body.type, 'FunctionExpression', `the command body stays a literal inline function, got ${body.type}`);
      assert.equal(body.async, false); assert.equal(body.generator, false);
      assert.equal(node.arguments[1].value, false); assert.equal(node.arguments[2].value, false);
      const carried = source.slice(body.start, body.end);
      const code = withoutComments(carried);
      assert.equal(/\b(?:capabilityBody|contextBody)\b/.test(code), false,
        'the carried body must be self-contained, never a forward to a module-scope binding');
      assert.match(code, /typeof Api !== ['"]undefined['"]/, 'the carried body reads the public Api facade itself');
      if (code.includes('.SetJc(')) {
        assert.match(code, /\bscope\b/, 'the format body takes its address from the injected command scope');
        assert.match(code, /GetRange\(/, 'and resolves the addressed region through the paragraph\u2019s own GetRange');
        assert.match(code, /GetAllParagraphs/, 'and checks the index against the document\u2019s own paragraph list');
        assert.match(code, /GetParaPr\(\)/, 'and reads the addressed paragraph through the paragraph-properties chain');
        assert.match(code, /GetJc\(\)/, 'and proves the mutation through the measured GetJc readback');
        assert.equal(code.includes('InsertContent'), false, 'and never the legacy whole-array primitive');
        assert.equal(code.includes('document.Push('), false, 'and never the append primitive: this leg changes an existing paragraph in place');
        // THE PROPERTIES THIS LEG CANNOT PROVE ARE AUTHORED NOWHERE. The SDK inspection found SETTERS ONLY on
        // the range/text-properties types, so a body that reached one of these would be applying an effect it
        // has no getter to read back — exactly what the closed schema refuses.
        for (const setter of ['.SetBold(', '.SetItalic(', '.SetFontSize(', '.SetColor(', '.SetFontFamily(', '.SetHighlight(']) {
          assert.equal(code.includes(setter), false, `the format body must not author ${setter}: the SDK exposes no getter for it`);
        }
        legs.push('format');
      } else if (code.includes('CreateTable')) {
        assert.match(code, /\bscope\b/, 'the table body takes its matrix from the injected command scope');
        assert.match(code, /GetAllTables/, 'and reads the document\u2019s own table count around the insert');
        assert.match(code, /GetCell/, 'and fills and re-reads every cell through the measured cell chain');
        assert.equal(code.includes('InsertContent'), false, 'and never the legacy whole-array primitive');
        legs.push('table');
      } else if (code.includes('.Push(')) {
        assert.match(code, /\bscope\b/, 'the append body takes its blocks from the injected command scope');
        assert.match(code, /CreateParagraph/, 'and builds each paragraph through the measured factory');
        assert.match(code, /GetAllParagraphs/, 'and reads the document\u2019s own counts around the append');
        legs.push('blocks');
      } else if (code.includes('.SetStyle(')) {
        assert.match(code, /\bscope\b/, 'the heading body takes its address, level and style name from the injected command scope');
        assert.match(code, /GetAllHeadingParagraphs/, 'and reads the document\u2019s own heading count around the mutation');
        assert.match(code, /GetAllParagraphs/, 'and re-reads the addressed paragraph\u2019s own text');
        // THE PROOF'S OWN CHAIN, pinned because the whole leg now rests on it: the addressed paragraph's
        // style is read through the MEASURED `GetParaPr().GetStyle().GetName()` route (measured on the
        // target), never by comparing the two paragraph lists — which were measured to hand out DIFFERENT
        // wrapper objects, so no reference comparison can hold.
        assert.match(code, /GetParaPr\(\)/, 'and proves the assignment through the measured paragraph-properties chain');
        assert.equal(/GetAllHeadingParagraphs\(\)[^;]*===/.test(code), false,
          'and never compares the two paragraph lists by identity: they answer different wrapper objects (measured)');
        assert.equal(code.includes('InsertContent'), false, 'and never the legacy whole-array primitive');
        assert.equal(code.includes('document.Push('), false, 'and never the append primitive: this leg changes an existing paragraph in place');
        legs.push('heading');
      } else if (code.includes('.GetAllHeadingParagraphs(')) {
        assert.match(code, /\bscope\b/, 'the structure body takes its extraction cap from the injected command scope');
        assert.match(code, /GetStatistics/, 'and reads the measured statistics primitive');
        legs.push('structure');
      } else if (code.includes('.Search(')) {
        assert.match(code, /\bscope\b/, 'the search body takes its needle from the injected command scope');
        assert.match(code, /GetText/, 'and reads each match through the measured primitive');
        legs.push('search');
      } else {
        assert.match(code, /GetRangeBySelect/, 'and carries the authored document probe');
        legs.push(code.includes('CAPABILITY_UNAVAILABLE') ? 'capability' : 'context');
      }
    }
  });
  assert.equal(commands, 8, 'the adapter dispatches exactly the eight authored command legs');
  assert.deepEqual(legs.sort(), ['blocks', 'capability', 'context', 'format', 'heading', 'search', 'structure', 'table'],
    'every reviewed static body is carried INLINE by the adapter, each evaluable on its own');
  // The bundle's HTML sinks are pinned again, now that the confirmation parses the document export with
  // `DOMParser` instead of a detached `createElement('div')` + `innerHTML` (the pin was dropped for that
  // container parse). A parsed document has NO browsing context, so it is the only sanctioned DOM entry
  // point in authored source; every string-into-markup sink — the same one that was dropped, its
  // whole-element and neighbour-insertion forms, the fragment parser, and the document writer — is
  // forbidden, together with everything that would mean a dev/runtime or a remote/embedded-artifact
  // escape.
  for (const forbidden of ['sourceMappingURL', 'sourcesContent', 'node:', 'https-mock', 'esbuild', 'acorn', 'synthetic', 'example.invalid', 'BEGIN PRIVATE KEY', 'window.parent', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'createContextualFragment', 'document.write(']) assert.equal(source.includes(forbidden), false, forbidden);
});
test('HTML/CSS only local authored assets plus exact separate installed SDK with documented CSP and visible focus', async () => {
  const built = await buildPlugin({ output: 'dist/task4-package-assets' }); const entries = inventory(built.archive);
  const html = entries.find(e => e.name === 'index.html'); assert.ok(html);
  const markup = html.data.toString('utf8');
  const references = [...markup.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(references.sort(), ['../v1/plugins.js', 'panel.js', 'styles.css']);
  assert.ok(markup.includes('lang="ru"')); assert.ok(markup.includes("script-src 'self' 'unsafe-eval'"));
  assert.equal(markup.includes('unsafe-inline'), false);
  const css = entries.find(e => e.name === 'styles.css').data.toString('utf8');
  assert.ok(css.includes(':focus-visible')); assert.ok(css.includes('outline:')); assert.equal(/@import|url\(|position:\s*(fixed|absolute|sticky)/i.test(css), false);
  for (const [name, size] of [['resources/icon.png', 32], ['resources/icon@2x.png', 64]]) {
    const png = entries.find(e => e.name === name).data;
    assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    let offset = 8; const compressed = []; while (offset < png.length) { const length = png.readUInt32BE(offset); if (png.toString('ascii',offset+4,offset+8) === 'IDAT') compressed.push(png.subarray(offset+8,offset+8+length)); offset += 12 + length; }
    const pixels = inflateSync(Buffer.concat(compressed)); assert.equal(pixels.length, size * (size * 4 + 1)); assert.ok(new Set(pixels).size > 4);
  }
});
test('packaged CSP permits SDK own-config bootstrap without blanket local-file or HTTP access', async () => {
  const built = await buildPlugin({ output: 'dist/task4-package-csp' });
  const entries = inventory(built.archive);
  assert.deepEqual(entries.map(e => e.name), expected, 'no extra root/runtime assets');
  const markup = entries.find(e => e.name === 'index.html').data.toString('utf8');
  const policies = [...markup.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*>/gi)];
  assert.equal(policies.length, 1, 'one enforced packaged CSP');
  const directives = policies[0][1].split(';').map(part => part.trim().split(/\s+/)).filter(([name]) => name);
  const connections = directives.filter(([name]) => name === 'connect-src');
  assert.equal(connections.length, 1);
  const sources = connections[0].slice(1);
  assert.ok(sources.includes("'self'"), "SDK GET './config.json' needs document-origin connect permission");
  assert.deepEqual(sources.slice().sort(), ["'self'", 'https:'], 'only self and HTTPS; no http:, file:, wildcard or other blanket source');
  assert.deepEqual(directives.find(([name]) => name === 'default-src'), ['default-src', "'none'"]);
});
test('build refuses output outside ignored dist tree and never accepts an arbitrary copy inventory', async () => {
  await assert.rejects(buildPlugin({ output: 'src/unsafe' }));
  await assert.rejects(buildPlugin({ output: 'dist/../src/unsafe' }));
  await assert.rejects(buildPlugin({ output: 'dist/test', files: ['.env'] }));
});
