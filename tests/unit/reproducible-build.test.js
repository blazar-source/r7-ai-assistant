import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipStore } from '../../scripts/zip-store.mjs';
import { verifyReproducibleBuild } from '../../scripts/verify-reproducible-build.mjs';

const commit = '339bfa2d81ea9d42f859c6705ad1104aec747ef6';
import { createHash } from 'node:crypto';
const payload = Buffer.from('payload');
const payloadHash = createHash('sha256').update(payload).digest('hex');
const provenance = Buffer.from(`${JSON.stringify({ files: { 'payload.txt': { sha256: payloadHash } }, sourceCommit: commit, toolchain: { esbuild: '0.25.10', node: process.version } })}\n`);
const archive = zipStore([{ name: 'payload.txt', data: payload }, { name: 'provenance.json', data: provenance }]);

function harness({ dirty = false, secondArchive = archive, secondProvenance = provenance } = {}) {
  const outputs = new Map();
  let build = 0;
  return {
    git: async args => args[0] === 'rev-parse' ? `${commit}\n` : dirty ? ' M tracked-file\n' : '',
    clean: async output => outputs.delete(output),
    build: async output => {
      build += 1;
      outputs.set(`${output}/r7-ai-assistant.zip`, build === 1 ? archive : secondArchive);
      outputs.set(`${output}/provenance.json`, build === 1 ? provenance : secondProvenance);
    },
    read: async path => {
      assert.ok(outputs.has(path), `unexpected read: ${path}`);
      return outputs.get(path);
    }
  };
}

test('reproducibility verifier cleans before each build and returns equal archive and manifest hashes', async () => {
  const events = [];
  const io = harness();
  const result = await verifyReproducibleBuild({
    output: 'dist/repro-test',
    git: async args => { events.push(`git:${args.join(' ')}`); return io.git(args); },
    clean: async output => { events.push(`clean:${output}`); return io.clean(output); },
    build: async output => { events.push(`build:${output}`); return io.build(output); },
    read: io.read
  });
  assert.deepEqual(events, [
    'git:rev-parse HEAD', 'git:status --porcelain',
    'clean:dist/repro-test', 'git:status --porcelain', 'build:dist/repro-test', 'git:status --porcelain',
    'clean:dist/repro-test', 'git:status --porcelain', 'build:dist/repro-test', 'git:status --porcelain'
  ]);
  assert.equal(result.sourceCommit, commit);
  assert.equal(result.builds.length, 2);
  assert.equal(result.builds[0].archiveSha256, result.builds[1].archiveSha256);
  assert.equal(result.builds[0].provenanceSha256, result.builds[1].provenanceSha256);
});

test('reproducibility verifier fails before building from a dirty tree', async () => {
  let builds = 0;
  const io = harness({ dirty: true });
  await assert.rejects(verifyReproducibleBuild({ ...io, output: 'dist/repro-test', build: async () => { builds += 1; } }), /DIRTY_WORKTREE/);
  assert.equal(builds, 0);
});

test('reproducibility verifier fails loudly when either artifact differs', async () => {
  await assert.rejects(verifyReproducibleBuild({ ...harness({ secondArchive: Buffer.from('different') }), output: 'dist/repro-test' }), /INVALID_ARCHIVE|ARCHIVE_MISMATCH/);
  const changedProvenance = Buffer.from(`${JSON.stringify({ files: { 'payload.txt': { sha256: payloadHash } }, sourceCommit: commit, toolchain: { esbuild: '0.25.10', node: process.version }, changed: true })}\n`);
  const changedArchive = zipStore([{ name: 'payload.txt', data: payload }, { name: 'provenance.json', data: changedProvenance }]);
  await assert.rejects(verifyReproducibleBuild({ ...harness({ secondArchive: changedArchive, secondProvenance: changedProvenance }), output: 'dist/repro-test' }), /PROVENANCE_MISMATCH/);
});

test('reproducibility verifier rejects packaged provenance or payload disagreement', async () => {
  const wrongPayload = Buffer.from('wrong payload');
  const wrongArchive = zipStore([{ name: 'payload.txt', data: wrongPayload }, { name: 'provenance.json', data: provenance }]);
  await assert.rejects(verifyReproducibleBuild({ ...harness({ secondArchive: wrongArchive }), output: 'dist/repro-test' }), /PAYLOAD_HASH_MISMATCH/);
  const externalOnly = Buffer.from(`${JSON.stringify({ files: { 'payload.txt': { sha256: payloadHash } }, sourceCommit: commit, toolchain: { esbuild: '0.25.10', node: process.version }, external: true })}\n`);
  await assert.rejects(verifyReproducibleBuild({ ...harness({ secondProvenance: externalOnly }), output: 'dist/repro-test' }), /PACKAGED_PROVENANCE_MISMATCH/);
});

test('reproducibility verifier rejects a build that dirties the tree', async () => {
  const io = harness();
  let statusCalls = 0;
  await assert.rejects(verifyReproducibleBuild({ ...io, output: 'dist/repro-test', git: async args => {
    if (args[0] === 'rev-parse') return `${commit}\n`;
    statusCalls += 1;
    return statusCalls === 3 ? '?? generated-outside-output\n' : '';
  } }), /DIRTY_WORKTREE/);
});

test('package exposes the durable reproducibility command', async () => {
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.reproducible, 'node scripts/verify-reproducible-build.mjs');
});
