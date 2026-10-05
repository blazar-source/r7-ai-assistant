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
  // FOUR legs are carried inline, and the fourth is the STRUCTURE read: like the search it is a READ that
  // builds the `Api` facade itself and receives DATA — here the extraction cap — from the `scope` binding
  // the vendor's `callCommand` wrapper injects (never from source text). It carries its own primitives
  // (`GetStatistics`, `GetPageCount`, `GetAllHeadingParagraphs`, …) instead of the identity probe, so the
  // classification below is by the primitive each body authors rather than by the refusal literal every
  // body now contains.
  let commands = 0; const legs = [];
  walk(parse(source, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'callCommand') {
      commands++;
      const body = node.arguments[0];
      assert.equal(body.type, 'FunctionExpression', `the command body stays a literal inline function, got ${body.type}`);
      assert.equal(body.async, false); assert.equal(body.generator, false);
      assert.equal(node.arguments[1].value, false); assert.equal(node.arguments[2].value, false);
      const carried = source.slice(body.start, body.end);
      assert.equal(/\b(?:capabilityBody|contextBody)\b/.test(carried), false,
        'the carried body must be self-contained, never a forward to a module-scope binding');
      assert.match(carried, /typeof Api !== ['"]undefined['"]/, 'the carried body reads the public Api facade itself');
      if (carried.includes('.GetAllHeadingParagraphs(')) {
        assert.match(carried, /\bscope\b/, 'the structure body takes its extraction cap from the injected command scope');
        assert.match(carried, /GetStatistics/, 'and reads the measured statistics primitive');
        legs.push('structure');
      } else if (carried.includes('.Search(')) {
        assert.match(carried, /\bscope\b/, 'the search body takes its needle from the injected command scope');
        assert.match(carried, /GetText/, 'and reads each match through the measured primitive');
        legs.push('search');
      } else {
        assert.match(carried, /GetRangeBySelect/, 'and carries the authored document probe');
        legs.push(carried.includes('CAPABILITY_UNAVAILABLE') ? 'capability' : 'context');
      }
    }
  });
  assert.equal(commands, 4, 'the adapter dispatches exactly the four authored command legs');
  assert.deepEqual(legs.sort(), ['capability', 'context', 'search', 'structure'],
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
