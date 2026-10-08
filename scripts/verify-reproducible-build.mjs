import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlugin } from './build-plugin.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const execFileAsync = promisify(execFile);
const sha256 = data => createHash('sha256').update(data).digest('hex');
const defaultGit = async args => (await execFileAsync('git', args, { cwd: root, encoding: 'utf8' })).stdout;
const defaultClean = output => rm(resolve(root, output), { recursive: true, force: true });
const defaultBuild = output => buildPlugin({ output });
const defaultRead = path => readFile(resolve(root, path));
function zipEntries(archive) {
  const entries = new Map();
  let offset = 0;
  while (offset + 4 <= archive.length && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const size = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    if (method !== 0 || offset + 30 + nameLength + extraLength + size > archive.length) throw new Error('INVALID_ARCHIVE');
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    if (entries.has(name)) throw new Error('INVALID_ARCHIVE');
    entries.set(name, archive.subarray(start, start + size));
    offset = start + size;
  }
  if (entries.size === 0) throw new Error('INVALID_ARCHIVE');
  return entries;
}

export async function verifyReproducibleBuild(options = {}) {
  const output = options.output ?? 'dist/reproducibility-proof';
  if (typeof output !== 'string' || !/^dist\/[A-Za-z0-9_-]+$/.test(output)) throw new Error('INVALID_BUILD_INPUT');
  const git = options.git ?? defaultGit;
  const clean = options.clean ?? defaultClean;
  const build = options.build ?? defaultBuild;
  const read = options.read ?? defaultRead;
  const sourceCommit = (await git(['rev-parse', 'HEAD'])).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('INVALID_SOURCE_COMMIT');
  if ((await git(['status', '--porcelain'])).trim()) throw new Error('DIRTY_WORKTREE');
  const builds = [];
  for (let number = 1; number <= 2; number += 1) {
    await clean(output);
    if ((await git(['status', '--porcelain'])).trim()) throw new Error('DIRTY_WORKTREE');
    await build(output);
    const archive = await read(`${output}/r7-ai-assistant.zip`);
    const provenanceBytes = await read(`${output}/provenance.json`);
    const entries = zipEntries(archive);
    const packagedProvenance = entries.get('provenance.json');
    if (!packagedProvenance || !packagedProvenance.equals(provenanceBytes)) throw new Error('PACKAGED_PROVENANCE_MISMATCH');
    const provenance = JSON.parse(packagedProvenance.toString('utf8'));
    if (provenance.sourceCommit !== sourceCommit) throw new Error('SOURCE_COMMIT_MISMATCH');
    if (provenance.toolchain?.node !== process.version || provenance.toolchain?.esbuild !== '0.25.10') throw new Error('TOOLCHAIN_MISMATCH');
    for (const [name, record] of Object.entries(provenance.files ?? {})) {
      const data = entries.get(name);
      if (!data || record?.sha256 !== sha256(data)) throw new Error('PAYLOAD_HASH_MISMATCH');
    }
    if ((await git(['status', '--porcelain'])).trim()) throw new Error('DIRTY_WORKTREE');
    builds.push(Object.freeze({ number, archiveSha256: sha256(archive), provenanceSha256: sha256(provenanceBytes) }));
  }
  if (builds[0].provenanceSha256 !== builds[1].provenanceSha256) throw new Error('PROVENANCE_MISMATCH');
  if (builds[0].archiveSha256 !== builds[1].archiveSha256) throw new Error('ARCHIVE_MISMATCH');
  return Object.freeze({ sourceCommit, node: process.version, builds: Object.freeze(builds) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyReproducibleBuild();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
