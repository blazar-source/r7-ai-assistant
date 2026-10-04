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
  // Every authored command in the bundle is the bridge adapter's own leg, whose body is an inline
  // forward to one of the two reviewed static bodies (`capabilityBody`/`contextBody`). The bodies
  // themselves are reached as function REFERENCES, so the bundle contains no second copy of them: the
  // assertion below proves the boundary (an inline synchronous body, the documented close/recalculate
  // arguments) and `auditSource` above proves the referenced bodies are static and read `Api` only.
  let commands = 0; const forwarded = [];
  walk(parse(source, { ecmaVersion: 'latest' }), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'callCommand') {
      commands++;
      const body = node.arguments[0];
      assert.equal(body.type, 'ArrowFunctionExpression', `the command body stays a literal inline function, got ${body.type}`);
      assert.equal(body.async, false); assert.equal(body.generator, false);
      assert.equal(node.arguments[1].value, false); assert.equal(node.arguments[2].value, false);
      assert.equal(body.body.type, 'CallExpression', 'the body is the adapter forward');
      assert.match(body.body.callee.name, /^(capabilityBody|contextBody)$/);
      assert.equal(body.body.arguments.length, 0, 'the reviewed body takes no arguments');
      forwarded.push(body.body.callee.name);
    }
  });
  assert.deepEqual(forwarded.sort(), ['capabilityBody', 'contextBody'],
    'both reviewed static bodies remain reachable as the adapter commands');
  for (const forbidden of ['sourceMappingURL', 'sourcesContent', 'node:', 'https-mock', 'esbuild', 'acorn', 'synthetic', 'example.invalid', 'BEGIN PRIVATE KEY', 'window.parent', 'innerHTML']) assert.equal(source.includes(forbidden), false, forbidden);
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
