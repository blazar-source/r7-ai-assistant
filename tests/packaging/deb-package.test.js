import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, posix } from 'node:path';
import { buildDeb, inspectDeb } from '../../scripts/build-deb.mjs';

const root = resolve(import.meta.dirname, '../..');
const guid = '{7C91D48E-5F12-4B36-8A90-2DFA8467C013}';
const owned = ['LICENSE','THIRD_PARTY_NOTICES.md','config.json','index.html','panel.js','resources/icon.png','resources/icon@2x.png','styles.css'];
const payloadRoot = 'usr/share/r7-ai-assistant/plugin';
const hash = data => createHash('sha256').update(data).digest('hex');

test('DEB metadata is the required release-candidate package identity', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(readFileSync(result.debPath));
  assert.deepEqual(deb.control, { Architecture: 'amd64', Description: 'Data-only R7 AI Assistant plugin payload', Maintainer: 'R7 AI Assistant maintainers', Package: 'r7-ai-assistant', Version: '0.9.0-pilot-rc.1' });
});

test('DEB regular-file inventory equals the contract manifest plus its uninstall manifest', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(readFileSync(result.debPath));
  const expected = [...owned.map(name => `${payloadRoot}/${name}`), 'usr/share/doc/r7-ai-assistant/product-owned-files.txt', 'usr/share/r7-ai-assistant/compatibility.json', 'usr/bin/r7-ai-assistant-preflight'].sort();
  assert.deepEqual(Object.keys(deb.data).sort(), expected);
  assert.equal(deb.data['usr/share/doc/r7-ai-assistant/product-owned-files.txt'].toString('utf8'), `${owned.map(name => `$HOME/.local/share/r7-office/editors/sdkjs-plugins/${guid}/${name}`).join('\n')}\n`);
});

test('documented activation copies packaged payload files directly into the GUID target', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(readFileSync(result.debPath));
  const deployment = readFileSync(resolve(root, 'docs/deployment.md'), 'utf8');
  const sourceMatch = deployment.match(/cp -a "\/usr\/share\/r7-ai-assistant\/plugin\/\." "\$TARGET\/"/);
  assert.ok(sourceMatch, 'deployment must copy the packaged plugin directory contents');
  const sourceRoot = 'usr/share/r7-ai-assistant/plugin';
  const activated = Object.keys(deb.data)
    .filter(name => name.startsWith(`${sourceRoot}/`))
    .map(name => posix.relative(sourceRoot, name))
    .sort();
  assert.deepEqual(activated, owned.slice().sort());
  assert.ok(activated.includes('panel.js'));
  assert.ok(!activated.some(name => name.startsWith(`${guid}/`)));
});

test('DEB plugin payload bytes match dist/plugin bytes', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(readFileSync(result.debPath));
  for (const name of owned) assert.equal(hash(deb.data[`${payloadRoot}/${name}`]), hash(readFileSync(resolve(root, 'dist/plugin', name))), name);
});

test('DEB data archive explicitly contains every payload parent directory', async () => {
  const result = await buildDeb();
  const deb = inspectDeb(readFileSync(result.debPath));
  const files = [...owned.map(name => `${payloadRoot}/${name}`), 'usr/share/doc/r7-ai-assistant/product-owned-files.txt', 'usr/share/r7-ai-assistant/compatibility.json', 'usr/bin/r7-ai-assistant-preflight'];
  const expectedDirectories = [...new Set(files.flatMap(name => {
    const parts = name.split('/');
    return parts.slice(0, -1).map((_, index) => `${parts.slice(0, index + 1).join('/')}/`);
  }))].sort();
  assert.deepEqual(deb.directories, expectedDirectories);
  for (const file of files) assert.ok(deb.directories.includes(`${file.slice(0, file.lastIndexOf('/'))}/`), file);
});
