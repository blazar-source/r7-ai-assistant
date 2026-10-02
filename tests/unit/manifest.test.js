import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('R7 manifest advertises the mandatory inside panels with local planned assets and no context initialization', async () => {
  const config = JSON.parse(await readFile(new URL('../../src/plugin/config.json', import.meta.url), 'utf8'));
  assert.equal(config.guid, 'asc.{7C91D48E-5F12-4B36-8A90-2DFA8467C013}');
  assert.equal(config.name, 'R7 AI Assistant'); assert.equal(config.variations.length, 1);
  const variation = config.variations[0];
  assert.deepEqual(variation.EditorsSupport, ['word', 'cell', 'slide']);
  assert.equal(variation.isVisual, true); assert.equal(variation.isInsideMode, true); assert.equal(variation.isModal, false);
  assert.equal(variation.isViewer, false); assert.equal(variation.initDataType, 'none'); assert.equal(variation.initData, '');
  assert.equal(variation.url, 'index.html'); assert.deepEqual(variation.icons, ['resources/icon.png', 'resources/icon@2x.png']);
  assert.deepEqual(variation.buttons, []);
  for (const asset of [variation.url, ...variation.icons]) assert.match(asset, /^(?:index\.html|resources\/icon(?:@2x)?\.png)$/);
  assert.equal(config.baseUrl, undefined); assert.equal(config.url, undefined);
});
