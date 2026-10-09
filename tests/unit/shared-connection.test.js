import test from 'node:test';
import assert from 'node:assert/strict';
import { createController } from '../../src/ui/controller.js';
import { SettingsStore } from '../../src/config/storage.js';
import { webcrypto } from 'node:crypto';

const profile = { endpoint: 'https://example.invalid/v1/chat/completions', model: 'qwen', apiKey: 'synthetic-shared' };
function fixture() {
  let value = null;
  const records = { async read() { return structuredClone(value); }, async write(next, expected) {
    if ((value?.revision ?? null) !== expected) return false; value = structuredClone(next); return true;
  } };
  const local = { getItem() { return null; }, removeItem() {} };
  const sent = [];
  const make = (editorType, transport = async settings => { sent.push(settings); return {content: '{"type":"final","message":"ok"}'}; }) => createController({
    store: new SettingsStore(local, {records, crypto: webcrypto}), crypto: webcrypto, transport,
    bridge: { getState() { return {editorType}; }, invalidate() {} }
  });
  return {make, sent, records};
}

test('save and check configures all editors already open and a restarted controller', async () => {
  const f = fixture(); const word = f.make('word'); const cell = f.make('cell'); const slide = f.make('slide');
  assert.equal(typeof word.saveAndTestConnection, 'function');
  assert.equal(await word.saveAndTestConnection(profile, null), true);
  for (const panel of [cell, slide, f.make('word')]) {
    await panel.syncSettings();
    assert.equal(panel.getState().settings.apiKey, profile.apiKey);
    assert.equal(await panel.testConnection(), true);
    panel.dispose();
  }
  word.dispose();
});

test('failed connection check does not replace a saved working profile', async () => {
  const f = fixture(); const word = f.make('word');
  assert.equal(typeof word.saveAndTestConnection, 'function');
  await word.saveAndTestConnection(profile, null);
  const bad = f.make('cell', async () => ({content: 'invalid'})); await bad.syncSettings();
  assert.equal(await bad.saveAndTestConnection({...profile, apiKey: 'synthetic-invalid'}, bad.getState().settingsRevision), false);
  const reloaded = f.make('slide'); await reloaded.syncSettings();
  assert.equal(reloaded.getState().settings.apiKey, profile.apiKey);
  for (const p of [word, bad, reloaded]) p.dispose();
});

test('a stale settings dialog cannot commit over another editors saved profile', async () => {
  const f = fixture(); const word = f.make('word'); const slide = f.make('slide');
  assert.equal(typeof word.saveAndTestConnection, 'function');
  await word.saveAndTestConnection(profile, null);
  assert.equal(await slide.saveAndTestConnection({...profile, model: 'stale'}, null), false);
  assert.equal(slide.getState().status, 'SETTINGS_CONFLICT');
  await slide.syncSettings(); assert.equal(slide.getState().settings.model, 'qwen');
  word.dispose(); slide.dispose();
});

test('shared storage failure blocks requests and publishes a visible error', async () => {
  const f = fixture(); const c = f.make('word');
  await c.saveAndTestConnection(profile, null);
  f.records.read = async () => { throw Error('synthetic private storage error'); };
  assert.equal(await c.analyze('question'), false);
  assert.equal(c.getState().status, 'STORAGE_UNAVAILABLE');
  assert.equal(f.sent.length, 1);
  c.dispose();
});
